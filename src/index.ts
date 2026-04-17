import { getAgentByName, routeAgentRequest } from "agents";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AskInput, Env } from "./contracts";
import { errorStatus, formatError, readJson } from "./repo-common";
import { RepoAgent } from "./repo-agent";
import { RepoQueryAgent } from "./repo-query-agent";
import { RepoSyncAgent } from "./repo-sync-agent";

export { RepoAgent, RepoSyncAgent, RepoQueryAgent };

const DEFAULT_SYNC_AGENT_NAME = "default";

const app = new Hono<{ Bindings: Env }>();
const apiCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type"],
});

app.onError((error, c) => {
  return c.json(
    {
      error: formatError(error),
    },
    { status: errorStatus(error) as 400 | 409 | 500 | 503 | 504 },
  );
});

app.use("/health", apiCors);
app.use("/status", apiCors);
app.use("/sync", apiCors);
app.use("/query", apiCors);
app.use("/query/stream", apiCors);

app.use("/agents/*", async (c, next) => {
  const routed = await routeAgentRequest(c.req.raw, c.env, { cors: true });
  if (routed) {
    return routed;
  }

  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/status", async (c) => {
  return proxyToSyncAgent(c.env, c.req.raw, "/status");
});

app.post("/sync", async (c) => {
  return proxyToSyncAgent(c.env, c.req.raw, "/sync");
});

app.post("/query", async (c) => {
  const body = await readJson<AskInput>(c.req.raw);
  return proxyToQueryAgent(c.env, c.req.raw, "/query", body);
});

app.post("/query/stream", async (c) => {
  const body = await readJson<AskInput>(c.req.raw);
  return proxyToQueryAgent(c.env, c.req.raw, "/query/stream", body);
});

app.all("/repos/*", (c) => {
  return c.json(
    {
      error:
        "Runtime repo configuration is no longer supported. Set REPO_URL and REPO_BRANCH in the worker environment, then use /status, /sync, /query, or /query/stream.",
    },
    410,
  );
});

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(warmSyncAgent(env));
  },
};

async function proxyToSyncAgent(
  env: Env,
  request: Request,
  pathname: string,
): Promise<Response> {
  const agent = await getAgentByName(env.REPO_SYNC_AGENT, DEFAULT_SYNC_AGENT_NAME);
  const url = new URL(request.url);
  url.pathname = pathname;

  return agent.fetch(new Request(url.toString(), request));
}

async function proxyToQueryAgent(
  env: Env,
  request: Request,
  pathname: string,
  body: AskInput,
): Promise<Response> {
  const repoId = `query-${crypto.randomUUID()}`;
  const agent = await getAgentByName(env.REPO_QUERY_AGENT, repoId);
  const url = new URL(request.url);
  url.pathname = pathname;

  return agent.fetch(
    new Request(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    }),
  );
}

async function warmSyncAgent(env: Env): Promise<void> {
  if (!env.REPO_URL?.trim()) {
    return;
  }

  const response = await proxyToSyncAgent(
    env,
    new Request("https://repo-agent.internal/status"),
    "/status",
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Repo agent warmup failed: ${errorText}`);
  }
}
