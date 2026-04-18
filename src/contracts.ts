export type RepoSource = {
  title: string;
  path: string;
};

export type RepoAnswer = {
  answer: string;
  sources: RepoSource[];
};

export type RepoSyncState = "idle" | "queued" | "syncing" | "ready" | "error";

export type RepoSyncReason = "bootstrap" | "manual" | "scheduled";

export type RepoStatus = {
  repoUrl: string | null;
  branch: string;
  lastCommit: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  ready: boolean;
  syncState: RepoSyncState;
  lastSyncReason: RepoSyncReason | null;
  activeQueryCount: number;
  configuredFromEnv: boolean;
  modelId: string;
  syncIntervalSeconds: number | null;
};

export type RepoAgentConfig = {
  repoUrl: string | null;
  branch: string;
  lastCommit: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  syncState: RepoSyncState;
  lastSyncReason: RepoSyncReason | null;
  activeQueryCount: number;
};

export type AskInput = {
  question: string;
};

export type QueryInput = AskInput;

export type SyncResult = {
  repoUrl: string;
  branch: string;
  lastCommit: string | null;
  lastSyncedAt: string;
};

export interface Env {
  AI: any;
  LOADER: WorkerLoader;
  REPO_SYNC_AGENT: DurableObjectNamespace<
    import("./repo-sync-agent").RepoSyncAgent
  >;
  REPO_QUERY_AGENT: DurableObjectNamespace<
    import("./repo-query-agent").RepoQueryAgent
  >;
  REPO_DB: D1Database;
  REPO_FILES: R2Bucket;
  REPO_URL?: string;
  REPO_BRANCH?: string;
  REPO_SYNC_INTERVAL_SECONDS?: string;
  REPO_SYNC_MAX_AGE_SECONDS?: string;
  QUERY_TIMEOUT_MS?: string;
  MODEL_ID?: string;
  ALLOWED_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
  REPO_TOKEN?: string;
}
