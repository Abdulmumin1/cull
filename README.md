# cull

`cull` uses [Project Think](https://blog.cloudflare.com/project-think/) and virtual file ssytem to triage your docs/codebase and answer questions.

You point it at one repo with env vars, deploy it, and call:

- `GET /health`
- `GET /status`
- `POST /query`
- `POST /query/stream`

It keeps the repo warm in the background and answers questions from the repo contents.

## Deploy

1. Install dependencies.

```bash
npm install
```

2. Create the Cloudflare resources once:

```bash
npx wrangler r2 bucket create docs-agent-cf-repo-files
npx wrangler d1 create docs-agent-cf-repo-db
```

Then copy the returned D1 `database_id` into [wrangler.jsonc](/Users/macbookpro/Documents/projects/docs-agent-cf/wrangler.jsonc:1).

3. Set your repo in `.dev.vars` for local dev, or as Worker vars for deploy:

```text
REPO_URL=https://github.com/your-org/your-repo
REPO_BRANCH=main
QUERY_TIMEOUT_MS=120000
MODEL_ID=@cf/moonshotai/kimi-k2.5
```

4. If the repo is private, add a token:

```bash
npx wrangler secret put REPO_TOKEN
```

5. Deploy:

```bash
npx wrangler deploy
```

6. Ask a question:

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/query \
  -H "content-type: application/json" \
  -d '{"question":"How does authentication work?"}'
```

## Response Shape

`POST /query` returns:

```json
{
  "answer": "...",
  "sources": [
    { "title": "Authentication", "path": "docs/auth.md" },
    { "title": "auth.ts", "path": "src/auth.ts" }
  ]
}
```

`POST /query/stream` streams SSE events:

- `status`
- `delta`
- `sources`
- `done`
- `error`
