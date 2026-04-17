import { getAgentByName } from "agents";
import { Think, type TurnContext } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import {
  createWorkspaceStateBackend,
} from "@cloudflare/shell";
import type { AskInput, Env, RepoAgentConfig, RepoAnswer, RepoStatus } from "./contracts";
import {
  QUERY_MAX_ATTEMPTS,
  RETRY_DELAY_MS,
  buildQueryPrompt,
  buildSystemPrompt,
  createQueryId,
  createSharedWorkspace,
  createTimeoutSignal,
  extractChunkType,
  extractPartialAnswer,
  extractTextDelta,
  formatError,
  getEnvSettings,
  getErrorMessage,
  getModel,
  jsonResponse,
  logRepo,
  mergeAbortSignals,
  normalizeRepoAnswer,
  previewText,
  readJson,
  sendSseEvent,
  sleep,
  DEFAULT_SYNC_AGENT_NAME,
} from "./repo-common";

type QueryHooks = {
  queryId?: string;
  onStatus?: (stage: string) => void | Promise<void>;
  onAnswerDelta?: (delta: string) => void | Promise<void>;
  signal?: AbortSignal;
};

export class RepoQueryAgent extends Think<Env> {
  override workspace = createSharedWorkspace(this.env);

  getModel() {
    return getModel(this.env);
  }

  getSystemPrompt() {
    return buildSystemPrompt();
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

  async onRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

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

  async answerQuestion(input: AskInput): Promise<RepoAnswer> {
    const question = input.question.trim();

    if (!question) {
      throw new Error("question is required");
    }

    return this.withQueryLease(async () =>
      this.runQuery(question, {
        queryId: createQueryId(),
      }),
    );
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
    logRepo("stream-start", { queryId, question });

    const encoder = new TextEncoder();
    let abortController: AbortController | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        abortController = new AbortController();
        const signal = mergeAbortSignals(requestSignal, abortController.signal);

        void this.withQueryLease(async () => {
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
            logRepo("stream-done", {
              queryId,
              answerLength: answer.answer.length,
              sourceCount: answer.sources.length,
            });
          } catch (error) {
            logRepo("stream-error", {
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
        });
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
    logRepo("query-start", { queryId, question });

    await hooks.onStatus?.("checking-repo");
    const config = await this.ensureRepoReady(hooks.onStatus, queryId);

    logRepo("query-ready", {
      queryId,
      repoUrl: config.repoUrl,
      branch: config.branch,
      lastCommit: config.lastCommit,
      syncState: config.syncState,
    });

    await hooks.onStatus?.("answering");

    const signal = mergeAbortSignals(
      hooks.signal,
      createTimeoutSignal(getEnvSettings(this.env).queryTimeoutMs),
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

    throw lastError instanceof Error ? lastError : new Error("The query failed.");
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
    logRepo("query-attempt-start", {
      queryId,
      branch: config.branch,
      question,
    });

    await this.chat(
      buildQueryPrompt(config.repoUrl, config.branch, question),
      {
        onEvent: async (json) => {
          const delta = extractTextDelta(json);
          const chunkType = extractChunkType(json);

          if (chunkType) {
            logRepo("model-event", {
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
    logRepo("query-attempt-finished", {
      queryId,
      rawTextLength: state.rawText.length,
      answerLength: normalized.answer.length,
      sourceCount: normalized.sources.length,
      rawPreview: previewText(state.rawText),
    });

    if (!normalized.answer) {
      logRepo("query-empty-response", {
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
    const status = await this.getSyncStatus();

    if (!status.repoUrl) {
      throw new Error(
        "Set REPO_URL before starting the repo docs endpoint worker.",
      );
    }

    if (!status.ready) {
      logRepo("query-not-ready", {
        queryId,
        syncState: status.syncState,
        lastSyncedAt: status.lastSyncedAt,
        lastError: status.lastError,
      });
      await onStatus?.("syncing");
      throw new Error(getRepoAvailabilityMessage(status));
    }

    return {
      repoUrl: status.repoUrl,
      branch: status.branch,
      lastCommit: status.lastCommit,
      lastSyncedAt: status.lastSyncedAt,
      lastError: status.lastError,
      syncState: status.syncState,
      lastSyncReason: status.lastSyncReason,
      activeQueryCount: status.activeQueryCount,
    };
  }

  private async withQueryLease<T>(callback: () => Promise<T>): Promise<T> {
    await this.markQueryActivity("start");

    try {
      return await callback();
    } finally {
      await this.markQueryActivity("finish");
    }
  }

  private async markQueryActivity(action: "start" | "finish"): Promise<void> {
    const syncAgent = await getAgentByName(
      this.env.REPO_SYNC_AGENT,
      DEFAULT_SYNC_AGENT_NAME,
    );

    await syncAgent.fetch(
      new Request(`https://repo-agent.internal/active-query/${action}`, {
        method: "POST",
      }),
    );
  }

  private async getSyncStatus(): Promise<RepoStatus> {
    const syncAgent = await getAgentByName(
      this.env.REPO_SYNC_AGENT,
      DEFAULT_SYNC_AGENT_NAME,
    );
    const response = await syncAgent.fetch(
      new Request("https://repo-agent.internal/status"),
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    return (await response.json()) as RepoStatus;
  }
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

function getRepoAvailabilityMessage(status: RepoStatus): string {
  if (status.syncState === "error") {
    return status.lastError
      ? `Repository bootstrap failed: ${status.lastError}`
      : "Repository bootstrap failed. Check /status and retry sync.";
  }

  if (!status.lastSyncedAt) {
    return "Repository is bootstrapping in the background. Retry shortly.";
  }

  return "Repository sync is in progress. Retry shortly.";
}

function errorStatus(error: unknown): number {
  const message = getErrorMessage(error).toLowerCase();

  if (
    message.includes("question is required") ||
    message.includes("expected a json request body")
  ) {
    return 400;
  }

  if (
    message.includes("bootstrapping in the background") ||
    message.includes("bootstrap failed") ||
    message.includes("sync is in progress") ||
    message.includes("retry shortly") ||
    message.includes("set repo_url")
  ) {
    return 503;
  }

  if (message.includes("timed out")) {
    return 504;
  }

  return 500;
}
