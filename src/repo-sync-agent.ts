import { Agent } from "agents";
import { WorkspaceFileSystem } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import type {
  Env,
  RepoAgentConfig,
  RepoStatus,
  RepoSyncReason,
  SyncResult,
} from "./contracts";
import {
  DEFAULT_BRANCH,
  DEFERRED_SYNC_DELAY_SECONDS,
  createSharedWorkspace,
  formatError,
  getEnvSettings,
  jsonResponse,
  logRepo,
} from "./repo-common";

export class RepoSyncAgent extends Agent<Env, RepoAgentConfig> {
  initialState: RepoAgentConfig = {
    repoUrl: null,
    branch: DEFAULT_BRANCH,
    lastCommit: null,
    lastSyncedAt: null,
    lastError: null,
    syncState: "idle",
    lastSyncReason: null,
    activeQueryCount: 0,
  };

  workspace = createSharedWorkspace(this.env);

  private syncPromise: Promise<SyncResult> | null = null;

  override async onStart(): Promise<void> {
    const settings = getEnvSettings(this.env);

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

      if (request.method === "POST" && url.pathname === "/active-query/start") {
        await this.bumpActiveQueryCount(1);
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/active-query/finish") {
        await this.bumpActiveQueryCount(-1);
        return jsonResponse({ ok: true });
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

    const settings = getEnvSettings(this.env);
    let config = await this.ensurePinnedRepoConfig(settings);

    if (!settings.repoUrl || !config.repoUrl) {
      throw new Error(
        "Set REPO_URL before starting the repo docs endpoint worker.",
      );
    }

    if (config.activeQueryCount > 0) {
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

    const repoUrl = config.repoUrl;
    const syncTask = this.keepAliveWhile(async () => {
      const git = createGit(new WorkspaceFileSystem(this.workspace));
      const branch = settings.branch;
      const token = this.env.REPO_TOKEN;

      logRepo("sync-start", {
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
      this.setState(config);

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
        this.setState(config);

        logRepo("sync-done", {
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
        this.setState(config);
        logRepo("sync-error", {
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

  private async bumpActiveQueryCount(delta: number): Promise<void> {
    const config = await this.ensurePinnedRepoConfig();
    const nextConfig: RepoAgentConfig = {
      ...config,
      activeQueryCount: Math.max(0, config.activeQueryCount + delta),
    };
    this.setState(nextConfig);
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

    this.setState(queuedConfig);
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
    settings = getEnvSettings(this.env),
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
        activeQueryCount: current.activeQueryCount,
      };

      if (current.repoUrl || current.lastCommit || current.lastSyncedAt) {
        await this.resetWorkspace();
        this.setState(nextConfig);
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
      activeQueryCount: current.activeQueryCount,
    };

    if (current.repoUrl || current.lastCommit || current.lastSyncedAt) {
      await this.resetWorkspace();
    }

    this.setState(nextConfig);
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

  private buildStatus(): RepoStatus {
    const config = this.getRepoConfig();
    const settings = getEnvSettings(this.env);

    return {
      repoUrl: settings.repoUrl ?? config.repoUrl,
      branch: settings.branch,
      lastCommit: config.lastCommit,
      lastSyncedAt: config.lastSyncedAt,
      lastError: config.lastError,
      ready: isRepoReady(config) && !this.syncPromise,
      syncState: this.syncPromise ? "syncing" : config.syncState,
      lastSyncReason: config.lastSyncReason,
      activeQueryCount: config.activeQueryCount,
      configuredFromEnv: Boolean(settings.repoUrl),
      modelId: settings.modelId,
      syncIntervalSeconds: settings.syncIntervalSeconds,
    };
  }

  private getRepoConfig(): RepoAgentConfig {
    return this.state ?? this.initialState;
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

function errorStatus(error: unknown): number {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (message.includes("set repo_url")) {
    return 503;
  }

  if (
    message.includes("bootstrapping in the background") ||
    message.includes("bootstrap failed") ||
    message.includes("retry shortly")
  ) {
    return 503;
  }

  if (message.includes("query is currently in progress")) {
    return 409;
  }

  return 500;
}
