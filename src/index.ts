import { getAgentByName, routeAgentRequest } from "agents";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { RepoAgent } from "./repo-agent";
import type { Env } from "./contracts";

export { RepoAgent };

const DEFAULT_REPO_AGENT_NAME = "default";

const app = new Hono<{ Bindings: Env }>();
const apiCors = cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type"],
});

app.onError((error, c) => {
  return c.json(
    {
      error: error instanceof Error ? error.message : String(error),
    },
    400,
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
  return proxyToDefaultAgent(c.env, c.req.raw, "/status");
});

app.post("/sync", async (c) => {
  return proxyToDefaultAgent(c.env, c.req.raw, "/sync");
});

app.post("/query", async (c) => {
  return proxyToDefaultAgent(c.env, c.req.raw, "/query");
});

app.post("/query/stream", async (c) => {
  return proxyToDefaultAgent(c.env, c.req.raw, "/query/stream");
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
    ctx.waitUntil(warmDefaultAgent(env));
  },
};

async function getRepoAgent(env: Env, repoId: string) {
  return getAgentByName(env.REPO_AGENT, decodeURIComponent(repoId));
}

async function proxyToDefaultAgent(
  env: Env,
  request: Request,
  pathname: string,
): Promise<Response> {
  return proxyToRepoAgent(env, DEFAULT_REPO_AGENT_NAME, request, pathname);
}

async function proxyToRepoAgent(
  env: Env,
  repoId: string,
  request: Request,
  pathname: string,
): Promise<Response> {
  const agent = await getRepoAgent(env, repoId);
  const url = new URL(request.url);
  url.pathname = pathname;

  return agent.fetch(new Request(url.toString(), request));
}

async function warmDefaultAgent(env: Env): Promise<void> {
  if (!env.REPO_URL?.trim()) {
    return;
  }

  const response = await proxyToDefaultAgent(
    env,
    new Request("https://repo-agent.internal/status"),
    "/status",
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Repo agent warmup failed: ${errorText}`);
  }
}
