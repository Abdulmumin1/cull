"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Text, Loader } from "@cloudflare/kumo";
import {
  ArrowsClockwise,
  CaretRight,
  Info,
  ArrowUp,
  WarningCircle,
} from "@phosphor-icons/react";

type RepoSource = {
  title: string;
  path: string;
};

type RepoAnswer = {
  answer: string;
  sources: RepoSource[];
};

type RepoState = {
  repoUrl: string | null;
  branch: string;
  lastCommit: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  ready: boolean;
  syncState: "idle" | "queued" | "syncing" | "ready" | "error";
  lastSyncReason: "bootstrap" | "manual" | "scheduled" | null;
  configuredFromEnv?: boolean;
  modelId?: string;
  syncIntervalSeconds?: number | null;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: RepoSource[];
  streaming?: boolean;
};

type HealthState = "checking" | "healthy" | "offline";

type StreamHandlers = {
  onStatus?: (payload: { stage?: string }) => void;
  onDelta?: (payload: { text?: string }) => void;
  onSources?: (payload: { sources?: unknown }) => void;
  onDone?: (payload: unknown) => void;
};

export function RepoWorkbench({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [question, setQuestion] = useState("");
  const [health, setHealth] = useState<HealthState>("checking");
  const [statusMessage, setStatusMessage] = useState(
    "Checking backend health.",
  );
  const [repoState, setRepoState] = useState<RepoState | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function runHealthCheck() {
      try {
        const response = await fetch(joinUrl(apiBaseUrl, "/health"));
        if (!response.ok) {
          throw new Error(`Health check failed with ${response.status}`);
        }

        if (!cancelled) {
          setHealth("healthy");
          setStatusMessage("Backend reachable.");
        }
      } catch (healthError) {
        if (!cancelled) {
          setHealth("offline");
          setStatusMessage(errorMessage(healthError));
        }
      }
    }

    void runHealthCheck();

    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl]);

  useEffect(() => {
    void refreshState();
  }, [apiBaseUrl]);

  useEffect(() => {
    if (!repoState?.repoUrl || repoState.ready) {
      return;
    }

    const interval = window.setInterval(() => {
      void pollState();
    }, 5_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [apiBaseUrl, repoState?.ready, repoState?.repoUrl, repoState?.syncState]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busyAction]);

  async function refreshState() {
    await runAction("refresh", async () => {
      const nextState = await getJson<RepoState>("/status");
      setRepoState(nextState);
      setStatusMessage(describeRepoState(nextState));
    });
  }

  async function syncRepo() {
    await runAction("sync", async () => {
      await postJson("/sync");
      const nextState = await getJson<RepoState>("/status");
      setRepoState(nextState);
      setStatusMessage(
        nextState.ready
          ? "Repository sync completed."
          : describeRepoState(nextState),
      );
    });
  }

  async function pollState() {
    try {
      const nextState = await getJson<RepoState>("/status");
      setRepoState(nextState);
      setStatusMessage(describeRepoState(nextState));
    } catch {}
  }

  async function askRepo() {
    const currentQuestion = question.trim();
    if (!currentQuestion) {
      return;
    }

    const assistantId = createMessageId();

    setQuestion("");
    setMessages((prev) => [
      ...prev,
      createMessage("user", currentQuestion),
      {
        id: assistantId,
        role: "assistant",
        content: "",
        sources: [],
        streaming: true,
      },
    ]);

    await runAction("ask", async () => {
      try {
        let finalAnswer: RepoAnswer | null = null;

        await streamSseResponse(
          joinUrl(apiBaseUrl, "/query/stream"),
          { question: currentQuestion },
          {
            onStatus: ({ stage }) => {
              setStatusMessage(formatStage(stage));
            },
            onDelta: ({ text }) => {
              if (!text) {
                return;
              }

              updateMessage(assistantId, (message) => ({
                ...message,
                content: message.content + text,
                streaming: true,
              }));
            },
            onSources: ({ sources }) => {
              updateMessage(assistantId, (message) => ({
                ...message,
                sources: normalizeSources(sources),
              }));
            },
            onDone: (payload) => {
              const answer = normalizeRepoAnswer(payload);
              finalAnswer = answer;
              updateMessage(assistantId, (message) => ({
                ...message,
                content: answer.answer,
                sources: answer.sources,
                streaming: false,
              }));
              setStatusMessage("Answer received.");
            },
          },
        );

        if (!finalAnswer) {
          throw new Error(
            "The stream ended before the backend returned a final answer.",
          );
        }
      } catch (askError) {
        updateMessage(assistantId, (message) => ({
          ...message,
          content: message.content || `Error: ${errorMessage(askError)}`,
          streaming: false,
        }));
        throw askError;
      }
    });
  }

  async function runAction(name: string, action: () => Promise<void>) {
    setBusyAction(name);
    setError(null);

    try {
      await action();
    } catch (actionError) {
      setError(errorMessage(actionError));
      setStatusMessage("Request failed.");
    } finally {
      setBusyAction(null);
    }
  }

  function updateMessage(
    messageId: string,
    update: (message: ChatMessage) => ChatMessage,
  ) {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId ? update(message) : message,
      ),
    );
  }

  async function getJson<T>(path: string): Promise<T> {
    const response = await fetch(joinUrl(apiBaseUrl, path));
    return readJsonResponse<T>(response);
  }

  async function postJson<T = unknown>(
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(joinUrl(apiBaseUrl, path), {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return readJsonResponse<T>(response);
  }

  const canAsk = Boolean(repoState?.ready);

  return (
    <div className="app-layout">
      <main className="chat-canvas">
        <div className="chat-content">
          {messages.length === 0 ? (
            <div className="empty-state">
              <h2 className="empty-title">Ask about docs to get started</h2>
            </div>
          ) : (
            <div className="messages-container">
              {messages.map((message) => (
                <div key={message.id} className={`message-row ${message.role}`}>
                  <div className="message-bubble">
                    <div className="message-content">
                      {message.streaming && !message.content ? (
                        <span className="thinking-spinner">
                          <Loader size="sm" /> Thinking...
                        </span>
                      ) : (
                        message.content
                      )}
                    </div>
                    {message.sources && message.sources.length > 0 && (
                      <div className="message-sources">
                        <Text size="sm" bold>
                          Sources
                        </Text>
                        <ul className="source-list">
                          {message.sources.map((source, index) => (
                            <li key={`${message.id}-${source.path}-${index}`}>
                              <span className="source-title">
                                {source.title}
                              </span>
                              <span className="source-path">{source.path}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          )}
        </div>

        <div className="chat-input-wrapper">
          <div className="chat-input-container">
            <input
              className="chat-input"
              placeholder="How to.."
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void askRepo();
                }
              }}
            />
            <button
              className="chat-submit-btn"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void askRepo();
              }}
              disabled={!question.trim() || !canAsk || busyAction === "ask"}
            >
              <ArrowUp weight="bold" size={16} />
            </button>
          </div>
        </div>
      </main>

      <aside className={`config-sidebar ${sidebarOpen ? "open" : "closed"}`}>
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-label="Toggle sidebar"
        >
          <CaretRight
            size={16}
            className={`toggle-icon ${sidebarOpen ? "open" : ""}`}
          />
        </button>

        <div className="sidebar-content">
          <div className="sidebar-section">
            <div className="section-header">
              <Text bold>Workspace Status</Text>
              <button
                className="sidebar-toggle"
                onClick={() => void refreshState()}
                aria-label="Refresh workspace state"
                disabled={busyAction === "refresh"}
              >
                <ArrowsClockwise size={16} />
              </button>
            </div>
            <div className="status-grid">
              <div className="status-item">
                <Text size="sm" variant="secondary">
                  Repo
                </Text>
                <Text size="sm">
                  {repoState?.repoUrl ?? "Missing REPO_URL configuration"}
                </Text>
              </div>
              <div className="status-item">
                <Text size="sm" variant="secondary">
                  Branch
                </Text>
                <Text size="sm">{repoState?.branch ?? "main"}</Text>
              </div>

              <div className="status-item">
                <Text size="sm" variant="secondary">
                  Last Sync
                </Text>
                <Text size="sm">
                  {repoState?.lastSyncedAt ?? "Not synced yet"}
                </Text>
              </div>
              <div className="status-item">
                <Text size="sm" variant="secondary">
                  Last Commit
                </Text>
                <Text size="xs">
                  {repoState?.lastCommit?.slice(0, 9) ?? "Unknown"}
                </Text>
              </div>
              <div className="status-item">
                <Text size="sm" variant="secondary">
                  Sync Interval
                </Text>
                <Text size="sm">
                  {formatSyncInterval(repoState?.syncIntervalSeconds)}
                </Text>
              </div>
            </div>
          </div>

          <hr className="divider" />

          <div className="action-buttons mt-4">
            <Button
              variant="primary"
              loading={busyAction === "sync"}
              onClick={() => void syncRepo()}
              className="full-width-btn"
            >
              Force Sync
            </Button>
          </div>

          {repoState?.lastError && (
            <>
              <hr className="divider" />
              <div className="sidebar-section">
                <div className="error-callout">
                  <WarningCircle size={20} color="var(--color-destructive)" />
                  <Text size="sm">{repoState.lastError}</Text>
                </div>
              </div>
            </>
          )}

          {error && (
            <>
              <hr className="divider" />
              <div className="sidebar-section">
                <div className="error-callout">
                  <WarningCircle size={20} color="var(--color-destructive)" />
                  <Text size="sm">{error}</Text>
                </div>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function createMessage(
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return {
    id: createMessageId(),
    role,
    content,
  };
}

function createMessageId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return Math.random().toString(36).slice(2, 10);
}

function joinUrl(baseUrl: string, path: string) {
  return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw await readErrorResponse(response);
  }

  return (await response.json()) as T;
}

async function readErrorResponse(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    if (typeof payload?.error === "string") {
      return new Error(payload.error);
    }
  } catch {}

  return new Error(`Request failed with ${response.status}`);
}

async function streamSseResponse(
  url: string,
  body: unknown,
  handlers: StreamHandlers,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw await readErrorResponse(response);
  }

  if (!response.body) {
    throw new Error("Streaming response body missing.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let boundary = findSseBoundary(buffer);
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));
      dispatchSseEvent(chunk, handlers);
      boundary = findSseBoundary(buffer);
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    dispatchSseEvent(buffer, handlers);
  }
}

function findSseBoundary(buffer: string) {
  const unixBoundary = buffer.indexOf("\n\n");
  const windowsBoundary = buffer.indexOf("\r\n\r\n");

  if (unixBoundary === -1) {
    return windowsBoundary;
  }

  if (windowsBoundary === -1) {
    return unixBoundary;
  }

  return Math.min(unixBoundary, windowsBoundary);
}

function dispatchSseEvent(chunk: string, handlers: StreamHandlers) {
  const lines = chunk.replace(/\r/g, "").split("\n");
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  const payload = dataLines.length
    ? (JSON.parse(dataLines.join("\n")) as unknown)
    : undefined;

  switch (event) {
    case "status":
      handlers.onStatus?.(payload as { stage?: string });
      return;
    case "delta":
      handlers.onDelta?.(payload as { text?: string });
      return;
    case "sources":
      handlers.onSources?.(payload as { sources?: unknown });
      return;
    case "done":
      handlers.onDone?.(payload);
      return;
    case "error":
      throw new Error(readStreamError(payload));
    default:
      return;
  }
}

function normalizeRepoAnswer(payload: unknown): RepoAnswer {
  if (!payload || typeof payload !== "object") {
    return {
      answer: "",
      sources: [],
    };
  }

  const answer =
    "answer" in payload && typeof payload.answer === "string"
      ? payload.answer
      : "";
  const sources = "sources" in payload ? normalizeSources(payload.sources) : [];

  return { answer, sources };
}

function normalizeSources(value: unknown): RepoSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const title =
      "title" in item && typeof item.title === "string" ? item.title : "source";
    const path =
      "path" in item && typeof item.path === "string" ? item.path : "";

    return path ? [{ title, path }] : [];
  });
}

function formatStage(stage?: string) {
  switch (stage) {
    case "checking-repo":
      return "Checking repo state.";
    case "syncing":
      return "Repository is syncing in the background.";
    case "answering":
      return "Generating answer.";
    case "retrying-model":
      return "Retrying the model after a transient upstream failure.";
    default:
      return stage ? `Working: ${stage}` : "Working.";
  }
}

function formatSyncState(repoState: RepoState | null) {
  if (!repoState?.repoUrl) {
    return "Missing config";
  }

  switch (repoState.syncState) {
    case "queued":
      return "Bootstrap queued";
    case "syncing":
      return repoState.lastSyncedAt ? "Refreshing" : "Bootstrapping";
    case "ready":
      return "Ready";
    case "error":
      return "Error";
    default:
      return repoState.ready ? "Ready" : "Waiting";
  }
}

function describeRepoState(repoState: RepoState | null) {
  if (!repoState?.repoUrl) {
    return "Set REPO_URL to prepare the repository workspace.";
  }

  switch (repoState.syncState) {
    case "queued":
      return "Repository bootstrap is queued.";
    case "syncing":
      return repoState.lastSyncedAt
        ? "Repository sync is running in the background."
        : "Repository bootstrap is running in the background.";
    case "ready":
      return repoState.lastSyncReason === "manual"
        ? "Repository is ready after a manual sync."
        : "Repository is ready.";
    case "error":
      return repoState.lastError
        ? `Repository sync failed: ${repoState.lastError}`
        : "Repository sync failed.";
    default:
      return repoState.ready
        ? "Repository is ready."
        : "Repository is waiting to bootstrap.";
  }
}

function formatSyncInterval(value?: number | null) {
  if (!value) {
    return "Disabled";
  }

  if (value < 60) {
    return `${value}s`;
  }

  if (value % 60 === 0) {
    return `${value / 60}m`;
  }

  return `${value}s`;
}

function readStreamError(payload: unknown) {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }

  return "The stream failed.";
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}
