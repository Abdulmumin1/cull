# Project Think Research For A Minimal Docs-Or-Code Repo Agent

## Goal

Build a self-hosted Cloudflare agent that does one thing:

- search a repo's docs first
- search code if docs do not answer the question
- return a structured answer with sources

Target response shape:

```json
{
  "answer": "...",
  "sources": [
    { "title": "Authentication", "path": "docs/auth.md" },
    { "title": "auth module", "path": "src/auth.ts" }
  ]
}
```

This is not a RAG system and it does not need a full sandbox architecture.

## Minimal Cloudflare Primitives

### 1. `Think` from `@cloudflare/think`

Yes, this can be the main primitive.

Why it fits:

- it is the top-level agent abstraction Cloudflare is pushing
- it already includes a built-in durable workspace
- it already handles the chat loop and tool execution
- it can expose a single `execute` tool powered by `codemode`

Use one `RepoAgent` per repo, implemented as a narrow `Think` subclass.

It only needs to hold:

- repo metadata
- auth reference
- current branch or commit
- the workspace instance

Important constraint:

`Think` is opinionated and experimental, so it should be used narrowly here.

Do not use it as a general assistant platform.
Use it only as the host for:

- repo workspace
- query loop
- minimal tool surface

### 2. Built-in `Workspace`

This is the core primitive.

`Think` already gives you `this.workspace`, backed by Durable Object storage.

Use that as the repo's durable virtual filesystem.

Why it fits:

- repo contents live in a durable workspace
- the agent can inspect the real files at query time
- no separate retrieval database is needed

### 3. Git support from `@cloudflare/shell`

Use `createGit(...)` or `gitTools(...)` to clone and refresh the repo into the workspace.

This keeps the repo current without introducing a separate storage model.

### 4. `@cloudflare/codemode`

Use this at query time so the model can write one small JavaScript program that searches the workspace.

That program should use `state.*` and optionally `git.*`.

This is the Cloudflare-native equivalent of "run some bash-like triage over the repo", except it is structured JavaScript, not an actual shell.

## Important Constraint

`@cloudflare/shell` is not a bash interpreter.

It gives you:

- `state.readFile()`
- `state.glob()`
- `state.searchFiles()`
- `state.walkTree()`
- `state.summarizeTree()`
- `git.clone()`
- `git.fetch()`
- `git.pull()`

That is enough for this product.

## Minimal Architecture

### Repo sync

1. Create a `RepoAgent` for a repo.
2. Attach a durable `Workspace`.
3. Clone the repo into that workspace.
4. Refresh it on a schedule if needed.

Conceptually:

```ts
class RepoAgent extends Think<Env> {
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.REPO_FILES,
    name: () => this.name
  });
}
```

Then sync with git against the workspace filesystem.

### Query flow

1. User asks a question.
2. Agent runs a `codemode` program over the workspace.
3. Program searches docs paths first.
4. If docs are insufficient, program searches code.
5. Program returns evidence.
6. Agent returns:

```json
{
  "answer": "...",
  "sources": [{ "title": "...", "path": "..." }]
}
```

## Docs-First Policy

Search these first:

- `README*`
- `docs/**`
- `*.md`
- `*.mdx`
- `*.rst`

Use:

- `state.glob(...)`
- `state.searchFiles(...)`
- `state.readFile(...)`

If the docs clearly answer the question, stop there.

## Code Fallback Policy

Only search code if docs do not answer the question.

Search:

- source files
- config files
- exported APIs
- type definitions

Use:

- `state.glob(...)`
- `state.searchFiles(...)`
- `state.readFile(...)`

## What The Query-Time Program Should Do

The model should write a small program that:

1. finds likely docs files
2. searches them for relevant terms
3. reads the best matches
4. decides whether docs are enough
5. if not, searches likely code files
6. returns concise evidence with file paths

That is the whole product loop.

## How To Use `Think` Narrowly

If `Think` is the primitive, keep it constrained.

Good use:

- built-in workspace
- one execute/search path over repo files
- docs-first system prompt
- structured answer output

Avoid exposing:

- extensions
- browser tools
- MCP
- broad write tools during answering
- open-ended assistant behavior

## Non-Goals

This design does not need:

- vector search
- embeddings
- RAG indexes
- full Sandbox by default
- Browser tools
- MCP
- extensions
- sub-agents
- a broad execution ladder in the initial architecture

## Minimal Self-Hosting Setup

For a self-hosted deployment, the user should only need:

- Worker entrypoint
- Durable Object binding for `RepoAgent`
- optional R2 bucket for larger workspace files
- Worker Loader binding for `codemode`
- provider secret for repo access
- optional Cron trigger for refresh

## Recommendation

Use Project Think's underlying primitives in the narrowest possible way:

1. `RepoAgent` Durable Object
2. `Workspace` as the canonical repo filesystem
3. shell git support to keep the repo synced
4. `codemode` to inspect docs first, then code
5. return `{ answer, sources }`

That is enough.

## Sources

- Project Think blog: https://blog.cloudflare.com/project-think/
- `@cloudflare/shell` README: https://raw.githubusercontent.com/cloudflare/agents/main/packages/shell/README.md
- `@cloudflare/codemode` README: https://raw.githubusercontent.com/cloudflare/agents/main/packages/codemode/README.md
- Think tools docs: https://raw.githubusercontent.com/cloudflare/agents/main/docs/think/tools.md
