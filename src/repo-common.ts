import { Workspace } from "@cloudflare/shell";
import { createWorkersAI } from "workers-ai-provider";
import type { Env, RepoAnswer, RepoSource } from "./contracts";

export const DEFAULT_BRANCH = "main";
export const DEFAULT_MODEL_ID = "@cf/zai-org/glm-4.7-flash";
export const DEFAULT_SYNC_INTERVAL_SECONDS = 3600;
export const DEFERRED_SYNC_DELAY_SECONDS = 30;
export const DEFAULT_QUERY_TIMEOUT_MS = 120_000;
export const QUERY_MAX_ATTEMPTS = 2;
export const RETRY_DELAY_MS = 250;
export const REPO_RESPONSE_SHAPE =
  '<answer>...</answer>\n<sources>[{"title":"...","path":"..."}]</sources>';
export const SHARED_WORKSPACE_NAME = "repo";
export const SHARED_WORKSPACE_NAMESPACE = "repo";
export const DEFAULT_SYNC_AGENT_NAME = "default";

const sharedWorkspaces = new WeakMap<object, Workspace>();

export type EnvRepoSettings = {
  repoUrl: string | null;
  branch: string;
  modelId: string;
  syncIntervalSeconds: number | null;
  queryTimeoutMs: number;
};

export function createSharedWorkspace(env: Env) {
  const source = env.REPO_DB as object;
  const existing = sharedWorkspaces.get(source);

  if (existing) {
    return existing;
  }

  const workspace = new Workspace({
    sql: env.REPO_DB,
    r2: env.REPO_FILES,
    namespace: SHARED_WORKSPACE_NAMESPACE,
    name: SHARED_WORKSPACE_NAME,
  });

  sharedWorkspaces.set(source, workspace);
  return workspace;
}

export function getEnvSettings(env: Env): EnvRepoSettings {
  const configuredInterval =
    parsePositiveInt(env.REPO_SYNC_INTERVAL_SECONDS) ??
    parsePositiveInt(env.REPO_SYNC_MAX_AGE_SECONDS);

  return {
    repoUrl: env.REPO_URL?.trim() || null,
    branch: env.REPO_BRANCH?.trim() || DEFAULT_BRANCH,
    modelId: env.MODEL_ID?.trim() || DEFAULT_MODEL_ID,
    syncIntervalSeconds: configuredInterval ?? DEFAULT_SYNC_INTERVAL_SECONDS,
    queryTimeoutMs:
      parsePositiveInt(env.QUERY_TIMEOUT_MS) ?? DEFAULT_QUERY_TIMEOUT_MS,
  };
}

export function getModel(env: Env) {
  const settings = getEnvSettings(env);
  return createWorkersAI({ binding: env.AI })(settings.modelId);
}

export function buildSystemPrompt(): string {
  return [
    "You are a narrow repo question-answering agent running inside Cloudflare Think.",
    "Answer only by inspecting the current workspace through the execute tool.",
    "Search docs first. Only search code if docs do not clearly answer the question.",
    "Be fast and conservative: stop as soon as you have enough evidence to answer well.",
    "",
    "Docs-first policy:",
    "- search README* first",
    "- then docs/**",
    "- then *.md, *.mdx, and *.rst",
    "- use state.glob(), state.searchFiles(), and state.readFile()",
    "- prefer the smallest useful set of doc files",
    "- if one or two doc files clearly answer the question, stop immediately",
    "- if docs are sufficient, stop without searching code",
    "- do not keep digging for extra confirmation once the answer is clear",
    "",
    "Code fallback policy:",
    "- only search code when the docs are missing, ambiguous, or clearly incomplete",
    "- search source files, config files, exported APIs, and type definitions",
    "- use state.glob(), state.searchFiles(), and state.readFile()",
    "",
    "Answering rules:",
    "- treat the workspace as read-only during answers",
    "- prefer concise evidence from the smallest useful set of files",
    "- do not exhaustively inspect the repo",
    `- return only this exact shape: ${REPO_RESPONSE_SHAPE}`,
    "- do not wrap the response in markdown fences",
    "- keep <answer> plain text only",
    "- keep <sources> as a valid JSON array",
    "- if the repo does not answer the question, return an honest short answer and an empty or partial sources array",
  ].join("\n");
}

export function buildQueryPrompt(
  repoUrl: string | null,
  branch: string,
  question: string,
): string {
  return [
    `Repository: ${repoUrl ?? "unknown"}`,
    `Branch: ${branch}`,
    `Question: ${question}`,
  ].join("\n");
}

export function createTimeoutSignal(timeoutMs: number): AbortSignal {
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

export function mergeAbortSignals(
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

export function createQueryId(): string {
  return `q_${crypto.randomUUID().slice(0, 8)}`;
}

export function logRepo(event: string, details: Record<string, unknown>) {
  try {
    console.log(`[repo-agent] ${event}`, JSON.stringify(details));
  } catch {
    console.log(`[repo-agent] ${event}`);
  }
}

export function previewText(value: string, maxLength = 400): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
}

export function extractChunkType(json: string): string | null {
  try {
    const chunk = JSON.parse(json) as {
      type?: string;
    };

    return typeof chunk.type === "string" ? chunk.type : null;
  } catch {
    return null;
  }
}

export function extractTextDelta(json: string): string {
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

export function extractPartialAnswer(rawText: string): string | null {
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

export function normalizeRepoAnswer(rawText: string): RepoAnswer {
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
      answer: rawText,
      sources: [],
    };
  }

  return {
    answer: parsed.answer.trim(),
    sources: dedupeSources(parsed.sources),
  };
}

export function parsePositiveInt(value: string | undefined): number | null {
  if (!value?.trim()) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isTransientWorkersAIErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("inferenceupstreamerror") ||
    normalized.includes("prefill transfer failed") ||
    normalized.includes("kvtransfererror")
  );
}

export function formatError(error: unknown): string {
  const message = getErrorMessage(error);

  if (isTransientWorkersAIErrorMessage(message)) {
    return "Workers AI had a temporary upstream failure while generating this response. Retry the request.";
  }

  return message;
}

export function errorStatus(error: unknown): number {
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
    message.includes("sync is in progress") ||
    message.includes("retry shortly")
  ) {
    return 503;
  }

  if (message.includes("query is currently in progress")) {
    return 409;
  }

  if (message.includes("timed out")) {
    return 504;
  }

  return 500;
}

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

export function sendSseEvent(
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

export async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) {
    throw new Error("Expected a JSON request body.");
  }

  return JSON.parse(text) as T;
}

export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
    answer,
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
