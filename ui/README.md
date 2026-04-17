# Optional UI

This is a separate `vinext` UI that talks to the repo-agent Worker API.

## Stack

- `vinext` pages router UI
- `@cloudflare/kumo` components with standalone styles
- client-side fetches to the backend Worker

## Local Dev

Install dependencies inside `ui/` and start the frontend:

```bash
cd ui
pnpm install
cp .env.example .env.local
pnpm dev
```

By default the UI expects the backend Worker at `http://localhost:8788`.
