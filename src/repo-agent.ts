import { Think, type TurnContext } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import {
  Workspace,
  WorkspaceFileSystem,
  createWorkspaceStateBackend,
} from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import { createWorkersAI } from "workers-ai-provider";
import type {
  AskInput,
  Env,
  RepoAgentConfig,
  RepoAnswer,
  RepoSyncReason,
  RepoSource,
  RepoStatus,
  SyncResult,
} from "./contracts";

const DEFAULT_BRANCH = "main";
const DEFAULT_MODEL_ID = "@cf/zai-org/glm-4.7-flash";
const DEFAULT_SYNC_INTERVAL_SECONDS = 3600; // 1 hour
const DEFERRED_SYNC_DELAY_SECONDS = 30;
const DEFAULT_QUERY_TIMEOUT_MS = 120_000;
const QUERY_MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;
const REPO_RESPONSE_SHAPE =
  '<answer>...</answer>\n<sources>[{"title":"...","path":"..."}]</sources>';

type EnvRepoSettings = {
  repoUrl: string | null;
  branch: string;
  modelId: string;
  syncIntervalSeconds: number | null;
  queryTimeoutMs: number;
};

type QueryHooks = {
  queryId?: string;
  onStatus?: (stage: string) => void | Promise<void>;
  onAnswerDelta?: (delta: string) => void | Promise<void>;
  signal?: AbortSignal;
};

export class RepoAgent extends Think<Env, RepoAgentConfig> {
  // override maxSteps = 120;

  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.REPO_FILES,
    name: () => this.name,
  });

  private activeQueryCount = 0;
  private syncPromise: Promise<SyncResult> | null = null;

  getModel() {
    const settings = this.getEnvSettings();
    return createWorkersAI({ binding: this.env.AI })(settings.modelId, {
      sessionAffinity: this.sessionAffinity,
    });
  }

  getSystemPrompt() {
    return [
      "You are a narrow repo question-answering agent running inside Cloudflare Think.",
      "Answer only by inspecting the current workspace through the execute tool.",
      "Search docs first. Only search code if docs do not clearly answer the question.",
      "",
      "Docs-first policy:",
      "- search README* first",
      "- then docs/**",
      "- then *.md, *.mdx, and *.rst",
      "- use state.glob(), state.searchFiles(), and state.readFile()",
      "- if docs are sufficient, stop without searching code",
      "",
      "Code fallback policy:",
      "- search source files, config files, exported APIs, and type definitions",
      "- use state.glob(), state.searchFiles(), and state.readFile()",
      "",
      "Answering rules:",
      "- treat the workspace as read-only during answers",
      "- prefer concise evidence from the smallest useful set of files",
      `- return only this exact shape: ${REPO_RESPONSE_SHAPE}`,
      "- do not wrap the response in markdown fences",
      "- keep <answer> plain text only",
      "- keep <sources> as a valid JSON array",
      "- if the repo does not answer the question, return an honest short answer and an empty or partial sources array",
    ].join("\n");
  }

  getTools() {
    return {
      execute: createExecuteTool({
        tools: {},
        state: createWorkspaceStateBackend(this.workspace),
        loader: this.env.LOADER,
      }),
    };
  }

  override beforeTurn(ctx: TurnContext) {
    const latestUserMessage = [...ctx.messages]
      .reverse()
      .find((message) => message.role === "user");

    return {
      activeTools: ["execute"],
      messages: latestUserMessage ? [latestUserMessage] : ctx.messages,
    };
  }

  override async onStart(): Promise<void> {
    const settings = this.getEnvSettings();

    if (!settings.repoUrl) {
      return;
    }

    if (settings.syncIntervalSeconds) {
      await this.scheduleEvery(
        settings.syncIntervalSeconds,
        "runScheduledSync",
        {},
      );
    }

    await this.ensureBootstrapQueued();
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/status") {
        return jsonResponse(await this.getRepoState());
      }

      if (request.method === "POST" && url.pathname === "/sync") {
        return jsonResponse(await this.syncRepo());
      }

      if (request.method === "POST" && url.pathname === "/query") {
        const body = await readJson<AskInput>(request);
        return jsonResponse(await this.answerQuestion(body));
      }

      if (request.method === "POST" && url.pathname === "/query/stream") {
        const body = await readJson<AskInput>(request);
        return this.streamAnswer(body, request.signal);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return jsonResponse(
        {
          error: formatError(error),
        },
        { status: errorStatus(error) },
      );
    }
  }

  async getRepoState(): Promise<RepoStatus> {
    await this.ensureBootstrapQueued();
    return this.buildStatus();
  }

  async syncRepo(): Promise<SyncResult> {
    return this.syncRepoInternal("manual");
  }

  async runBootstrapSync(): Promise<void> {
    await this.syncRepoInternal("bootstrap");
  }

  async runScheduledSync(_payload?: string): Promise<void> {
    await this.syncRepoInternal("scheduled");
  }

  private async syncRepoInternal(reason: RepoSyncReason): Promise<SyncResult> {
    if (this.syncPromise) {
      return this.syncPromise;
    }

    const settings = this.getEnvSettings();
    let config = await this.ensurePinnedRepoConfig(settings);

    if (!settings.repoUrl || !config.repoUrl) {
      throw new Error(
        "Set REPO_URL before starting the repo docs endpoint worker.",
      );
    }

    const repoUrl = config.repoUrl;

    if (this.activeQueryCount > 0) {
      if (reason === "scheduled" && config.lastSyncedAt) {
        await this.scheduleDeferredSync();
        return buildSyncResult(config);
      }

      if (reason === "manual") {
        throw new Error(
          "A repo query is currently in progress. Retry sync again shortly.",
        );
      }
    }

    const syncTask = this.keepAliveWhile(async () => {
      const git = createGit(new WorkspaceFileSystem(this.workspace));
      const branch = settings.branch;
      const token = this.env.REPO_TOKEN;

      logRepoAgent("sync-start", {
        reason,
        repoUrl,
        branch,
        hadPreviousSync: Boolean(config.lastSyncedAt),
      });

      config = {
        ...config,
        syncState: "syncing",
        lastSyncReason: reason,
        lastError: null,
      };
      this.configure(config);

      try {
        if (!config.lastSyncedAt) {
          await git.clone({
            url: repoUrl,
            branch,
            singleBranch: true,
            depth: 1,
            token,
          });
        } else {
          await git.pull({
            remote: "origin",
            ref: branch,
            author: {
              name: "Repo Agent",
              email: "repo-agent@cloudflare.dev",
            },
            token,
          });
        }

        const log = await git.log({ depth: 1 });
        const lastCommit = log[0]?.oid ?? null;
        const lastSyncedAt = new Date().toISOString();

        config = {
          ...config,
          branch,
          lastCommit,
          lastSyncedAt,
          lastError: null,
          syncState: "ready",
          lastSyncReason: reason,
        };
        this.configure(config);

        logRepoAgent("sync-done", {
          reason,
          repoUrl,
          branch,
          lastCommit,
          lastSyncedAt,
        });

        return buildSyncResult(config);
      } catch (error) {
        config = {
          ...config,
          lastError: formatError(error),
          syncState: "error",
          lastSyncReason: reason,
        };
        this.configure(config);
        logRepoAgent("sync-error", {
          reason,
          repoUrl,
          branch,
          error: formatError(error),
        });
        throw error;
      }
    });

    this.syncPromise = syncTask;

    try {
      return await syncTask;
    } finally {
      this.syncPromise = null;
    }
  }

  async answerQuestion(input: AskInput): Promise<RepoAnswer> {
    const question = input.question.trim();

    if (!question) {
      throw new Error("question is required");
    }

    return this.runQuery(question, {
      queryId: createQueryId(),
    });
  }

  private async streamAnswer(
    input: AskInput,
    requestSignal?: AbortSignal,
  ): Promise<Response> {
    const question = input.question.trim();

    if (!question) {
      throw new Error("question is required");
    }

    const queryId = createQueryId();
    logRepoAgent("stream-start", {
      queryId,
      question,
      repoUrl: this.getRepoConfig().repoUrl,
    });

    const encoder = new TextEncoder();
    let abortController: AbortController | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        abortController = new AbortController();
        const signal = mergeAbortSignals(requestSignal, abortController.signal);

        void (async () => {
          try {
            const answer = await this.runQuery(question, {
              queryId,
              signal,
              onStatus: async (stage) => {
                sendSseEvent(controller, encoder, "status", { stage });
              },
              onAnswerDelta: async (delta) => {
                if (delta) {
                  sendSseEvent(controller, encoder, "delta", { text: delta });
                }
              },
            });

            sendSseEvent(controller, encoder, "sources", {
              sources: answer.sources,
            });
            sendSseEvent(controller, encoder, "done", answer);
            logRepoAgent("stream-done", {
              queryId,
              answerLength: answer.answer.length,
              sourceCount: answer.sources.length,
            });
          } catch (error) {
            logRepoAgent("stream-error", {
              queryId,
              error: formatError(error),
            });
            sendSseEvent(controller, encoder, "error", {
              error: formatError(error),
            });
          } finally {
            try {
              controller.close();
            } catch {}
          }
        })();
      },
      cancel: () => {
        abortController?.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  private async runQuery(
    question: string,
    hooks: QueryHooks = {},
  ): Promise<RepoAnswer> {
    const queryId = hooks.queryId ?? createQueryId();
    logRepoAgent("query-start", {
      queryId,
      question,
      activeQueryCount: this.activeQueryCount,
      syncInProgress: Boolean(this.syncPromise),
    });

    await hooks.onStatus?.("checking-repo");
    const config = await this.ensureRepoReady(hooks.onStatus, queryId);
    const releaseQuery = this.beginQuery(config);

    logRepoAgent("query-ready", {
      queryId,
      repoUrl: config.repoUrl,
      branch: config.branch,
      lastCommit: config.lastCommit,
      syncState: config.syncState,
    });

    try {
      await hooks.onStatus?.("answering");

      const signal = mergeAbortSignals(
        hooks.signal,
        createTimeoutSignal(this.getEnvSettings().queryTimeoutMs),
      );

      let lastError: unknown;

      for (let attempt = 1; attempt <= QUERY_MAX_ATTEMPTS; attempt += 1) {
        const state = {
          emittedAnswer: "",
          rawText: "",
        };

        try {
          return await this.runQueryAttempt(
            config,
            question,
            { ...hooks, queryId },
            signal,
            state,
          );
        } catch (error) {
          lastError = error;

          if (!shouldRetryQueryError(error, attempt, state.rawText, signal)) {
            throw error;
          }

          console.warn("[repo-agent] retrying transient Workers AI error", {
            queryId,
            attempt,
            error: getErrorMessage(error),
          });
          await hooks.onStatus?.("retrying-model");
          await sleep(RETRY_DELAY_MS, signal);
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("The query failed.");
    } finally {
      logRepoAgent("query-finish", {
        queryId,
        remainingActiveQueries: Math.max(0, this.activeQueryCount - 1),
      });
      releaseQuery();
    }
  }

  private async runQueryAttempt(
    config: RepoAgentConfig,
    question: string,
    hooks: QueryHooks,
    signal: AbortSignal,
    state: {
      emittedAnswer: string;
      rawText: string;
    },
  ): Promise<RepoAnswer> {
    const queryId = hooks.queryId ?? "unknown";
    logRepoAgent("query-attempt-start", {
      queryId,
      branch: config.branch,
      question,
    });

    await this.chat(
      buildQueryPrompt(config, question),
      {
        onEvent: async (json) => {
          const delta = extractTextDelta(json);
          const chunkType = extractChunkType(json);

          if (chunkType) {
            logRepoAgent("model-event", {
              queryId,
              chunkType,
              deltaLength: delta.length,
            });
          }

          if (!delta) {
            return;
          }

          state.rawText += delta;

          const nextAnswer = extractPartialAnswer(state.rawText);
          if (!nextAnswer || !hooks.onAnswerDelta) {
            return;
          }

          if (nextAnswer.startsWith(state.emittedAnswer)) {
            const nextDelta = nextAnswer.slice(state.emittedAnswer.length);
            if (nextDelta) {
              await hooks.onAnswerDelta(nextDelta);
            }
          }

          state.emittedAnswer = nextAnswer;
        },
        onDone: () => {},
      },
      { signal },
    );

    const normalized = normalizeRepoAnswer(state.rawText.trim());
    logRepoAgent("query-attempt-finished", {
      queryId,
      rawTextLength: state.rawText.length,
      answerLength: normalized.answer.length,
      sourceCount: normalized.sources.length,
      rawPreview: previewText(state.rawText),
    });

    if (!normalized.answer) {
      logRepoAgent("query-empty-response", {
        queryId,
        rawTextLength: state.rawText.length,
        rawPreview: previewText(state.rawText),
      });
      throw new Error("The agent returned an empty response.");
    }

    if (
      hooks.onAnswerDelta &&
      normalized.answer.startsWith(state.emittedAnswer) &&
      normalized.answer.length > state.emittedAnswer.length
    ) {
      await hooks.onAnswerDelta(
        normalized.answer.slice(state.emittedAnswer.length),
      );
    }

    return normalized;
  }

  private async ensureRepoReady(
    onStatus?: (stage: string) => void | Promise<void>,
    queryId?: string,
  ): Promise<RepoAgentConfig> {
    const config = await this.ensureBootstrapQueued();

    if (!config.repoUrl) {
      throw new Error(
        "Set REPO_URL before starting the repo docs endpoint worker.",
      );
    }

    if (this.syncPromise || !isRepoReady(config)) {
      logRepoAgent("query-not-ready", {
        queryId,
        syncState: config.syncState,
        lastSyncedAt: config.lastSyncedAt,
        lastError: config.lastError,
      });
      await onStatus?.("syncing");
      throw new Error(getRepoAvailabilityMessage(config));
    }

    return config;
  }

  private beginQuery(_config: RepoAgentConfig): () => void {
    if (this.syncPromise) {
      throw new Error("Repository sync is in progress. Retry shortly.");
    }

    this.activeQueryCount += 1;

    return () => {
      this.activeQueryCount = Math.max(0, this.activeQueryCount - 1);
    };
  }

  private async ensureBootstrapQueued(): Promise<RepoAgentConfig> {
    const config = await this.ensurePinnedRepoConfig();

    if (!config.repoUrl) {
      return config;
    }

    if (
      config.lastSyncedAt ||
      config.syncState === "queued" ||
      config.syncState === "syncing" ||
      config.syncState === "ready" ||
      config.syncState === "error"
    ) {
      return config;
    }

    const queuedConfig: RepoAgentConfig = {
      ...config,
      syncState: "queued",
      lastSyncReason: "bootstrap",
      lastError: null,
    };

    this.configure(queuedConfig);
    await this.queue("runBootstrapSync", {});

    return queuedConfig;
  }

  private async scheduleDeferredSync(): Promise<void> {
    await this.schedule(
      DEFERRED_SYNC_DELAY_SECONDS,
      "runScheduledSync",
      "deferred",
      { idempotent: true },
    );
  }

  private async ensurePinnedRepoConfig(
    settings = this.getEnvSettings(),
  ): Promise<RepoAgentConfig> {
    const current = this.getRepoConfig();

    if (!settings.repoUrl) {
      const nextConfig: RepoAgentConfig = {
        repoUrl: null,
        branch: DEFAULT_BRANCH,
        lastCommit: null,
        lastSyncedAt: null,
        lastError: null,
        syncState: "idle",
        lastSyncReason: null,
      };

      if (current.repoUrl || current.lastCommit || current.lastSyncedAt) {
        await this.resetWorkspace();
        this.configure(nextConfig);
        return nextConfig;
      }

      return current;
    }

    const repoChanged =
      current.repoUrl !== settings.repoUrl ||
      current.branch !== settings.branch;

    if (!repoChanged) {
      return current;
    }

    const nextConfig: RepoAgentConfig = {
      repoUrl: settings.repoUrl,
      branch: settings.branch,
      lastCommit: null,
      lastSyncedAt: null,
      lastError: null,
      syncState: "idle",
      lastSyncReason: null,
    };

    if (current.repoUrl || current.lastCommit || current.lastSyncedAt) {
      await this.resetWorkspace();
    }

    this.configure(nextConfig);
    return nextConfig;
  }

  private async resetWorkspace(): Promise<void> {
    const entries = await this.workspace.readDir("/");

    for (const entry of entries) {
      await this.workspace.rm(entry.path, {
        recursive: true,
        force: true,
      });
    }
  }

  private getEnvSettings(): EnvRepoSettings {
    const configuredInterval =
      parsePositiveInt(this.env.REPO_SYNC_INTERVAL_SECONDS) ??
      parsePositiveInt(this.env.REPO_SYNC_MAX_AGE_SECONDS);

    return {
      repoUrl: this.env.REPO_URL?.trim() || null,
      branch: this.env.REPO_BRANCH?.trim() || DEFAULT_BRANCH,
      modelId: this.env.MODEL_ID?.trim() || DEFAULT_MODEL_ID,
      syncIntervalSeconds: configuredInterval ?? DEFAULT_SYNC_INTERVAL_SECONDS,
      queryTimeoutMs:
        parsePositiveInt(this.env.QUERY_TIMEOUT_MS) ?? DEFAULT_QUERY_TIMEOUT_MS,
    };
  }

  private buildStatus(): RepoStatus {
    const config = this.getRepoConfig();
    const settings = this.getEnvSettings();

    return {
      repoUrl: settings.repoUrl ?? config.repoUrl,
      branch: settings.branch,
      lastCommit: config.lastCommit,
      lastSyncedAt: config.lastSyncedAt,
      lastError: config.lastError,
      ready: isRepoReady(config) && !this.syncPromise,
      syncState: this.syncPromise ? "syncing" : config.syncState,
      lastSyncReason: config.lastSyncReason,
      configuredFromEnv: Boolean(settings.repoUrl),
      modelId: settings.modelId,
      syncIntervalSeconds: settings.syncIntervalSeconds,
    };
  }

  private getRepoConfig(): RepoAgentConfig {
    return (
      this.getConfig() ?? {
        repoUrl: null,
        branch: DEFAULT_BRANCH,
        lastCommit: null,
        lastSyncedAt: null,
        lastError: null,
        syncState: "idle",
        lastSyncReason: null,
      }
    );
  }
}

function buildSyncResult(config: RepoAgentConfig): SyncResult {
  if (!config.repoUrl || !config.lastSyncedAt) {
    throw new Error("Repository sync has not completed yet.");
  }

  return {
    repoUrl: config.repoUrl,
    branch: config.branch,
    lastCommit: config.lastCommit,
    lastSyncedAt: config.lastSyncedAt,
  };
}

function isRepoReady(config: RepoAgentConfig): boolean {
  return Boolean(
    config.repoUrl && config.lastSyncedAt && config.syncState === "ready",
  );
}

function getRepoAvailabilityMessage(config: RepoAgentConfig): string {
  if (config.syncState === "error") {
    return config.lastError
      ? `Repository bootstrap failed: ${config.lastError}`
      : "Repository bootstrap failed. Check /status and retry sync.";
  }

  if (!config.lastSyncedAt) {
    return "Repository is bootstrapping in the background. Retry shortly.";
  }

  return "Repository sync is in progress. Retry shortly.";
}

function buildQueryPrompt(config: RepoAgentConfig, question: string): string {
  return [
    `Repository: ${config.repoUrl ?? "unknown"}`,
    `Branch: ${config.branch}`,
    `Question: ${question}`,
  ].join("\n");
}

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("The query timed out."));
  }, timeoutMs);

  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timeout);
    },
    { once: true },
  );

  return controller.signal;
}

function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const controller = new AbortController();

  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  for (const signal of signals) {
    if (!signal) {
      continue;
    }

    if (signal.aborted) {
      abort(signal.reason);
      break;
    }

    signal.addEventListener(
      "abort",
      () => {
        abort(signal.reason);
      },
      { once: true },
    );
  }

  return controller.signal;
}

function createQueryId(): string {
  return `q_${crypto.randomUUID().slice(0, 8)}`;
}

function logRepoAgent(event: string, details: Record<string, unknown>) {
  try {
    console.log(`[repo-agent] ${event}`, JSON.stringify(details));
  } catch {
    console.log(`[repo-agent] ${event}`);
  }
}

function previewText(value: string, maxLength = 400): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}…`;
}

function extractChunkType(json: string): string | null {
  try {
    const chunk = JSON.parse(json) as {
      type?: string;
    };

    return typeof chunk.type === "string" ? chunk.type : null;
  } catch {
    return null;
  }
}

function extractTextDelta(json: string): string {
  try {
    const chunk = JSON.parse(json) as {
      type?: string;
      delta?: string;
      text?: string;
    };

    if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
      return chunk.delta;
    }

    if (chunk.type === "text-start" && typeof chunk.text === "string") {
      return chunk.text;
    }
  } catch {
    return "";
  }

  return "";
}

function extractPartialAnswer(rawText: string): string | null {
  const openMatch = /<answer>/i.exec(rawText);
  if (!openMatch) {
    return null;
  }

  const afterOpen = rawText.slice(openMatch.index + openMatch[0].length);
  const closeMatch = /<\/answer>/i.exec(afterOpen);

  if (!closeMatch) {
    return afterOpen;
  }

  return afterOpen.slice(0, closeMatch.index);
}

function normalizeRepoAnswer(rawText: string): RepoAnswer {
  const tagged = parseTaggedRepoAnswer(rawText);
  if (tagged) {
    return tagged;
  }

  const parsed = parseJsonObject(rawText);

  if (
    !parsed ||
    typeof parsed.answer !== "string" ||
    !Array.isArray(parsed.sources)
  ) {
    return {
      answer: rawText || "The agent returned an empty response.",
      sources: [],
    };
  }

  return {
    answer: parsed.answer.trim(),
    sources: dedupeSources(parsed.sources),
  };
}

function parseTaggedRepoAnswer(rawText: string): RepoAnswer | null {
  const answerMatch = rawText.match(/<answer>([\s\S]*?)<\/answer>/i);
  if (!answerMatch) {
    return null;
  }

  const sourcesMatch = rawText.match(/<sources>([\s\S]*?)<\/sources>/i);
  const answer = answerMatch[1].trim();
  let sources: RepoSource[] = [];

  if (sourcesMatch) {
    try {
      const parsed = JSON.parse(sourcesMatch[1].trim()) as unknown[];
      sources = dedupeSources(Array.isArray(parsed) ? parsed : []);
    } catch {
      sources = [];
    }
  }

  return {
    answer: answer || "The agent returned an empty response.",
    sources,
  };
}

function parseJsonObject(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start < 0 || end < start) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  }
}

function dedupeSources(value: unknown[]): RepoSource[] {
  const seen = new Set<string>();
  const sources: RepoSource[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const title =
      typeof record.title === "string"
        ? record.title.trim()
        : path.split("/").pop() || "source";

    if (!path || seen.has(path)) {
      continue;
    }

    seen.add(path);
    sources.push({ title, path });
  }

  return sources;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value?.trim()) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function shouldRetryQueryError(
  error: unknown,
  attempt: number,
  rawText: string,
  signal: AbortSignal,
): boolean {
  if (attempt >= QUERY_MAX_ATTEMPTS || signal.aborted || rawText.trim()) {
    return false;
  }

  return isTransientWorkersAIErrorMessage(getErrorMessage(error));
}

function isTransientWorkersAIErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("inferenceupstreamerror") ||
    normalized.includes("prefill transfer failed") ||
    normalized.includes("kvtransfererror")
  );
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatError(error: unknown): string {
  const message = getErrorMessage(error);

  if (isTransientWorkersAIErrorMessage(message)) {
    return "Workers AI had a temporary upstream failure while generating this response. Retry the request.";
  }

  return message;
}

function errorStatus(error: unknown): number {
  const message = getErrorMessage(error).toLowerCase();

  if (
    message.includes("question is required") ||
    message.includes("expected a json request body")
  ) {
    return 400;
  }

  if (message.includes("set repo_url")) {
    return 503;
  }

  if (
    message.includes("bootstrapping in the background") ||
    message.includes("bootstrap failed") ||
    message.includes("sync is in progress")
  ) {
    return 503;
  }

  if (message.includes("query is currently in progress")) {
    return 409;
  }

  return 500;
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

function sendSseEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: string,
  data: unknown,
): boolean {
  try {
    controller.enqueue(
      encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) {
    throw new Error("Expected a JSON request body.");
  }

  return JSON.parse(text) as T;
}
