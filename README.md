# GitFlare

**GitHub on Cloudflare.** Version control, CI/CD, and agent orchestration — built on the edge.

GitFlare replaces GitHub for your projects. Git hosting runs on Cloudflare Artifacts, CI runs in Cloudflare Sandboxes, and deployments go to your Coolify instances on bare metal.

## Architecture

```
Developer / Agent
       │
       ▼ (git push / API)
  Cloudflare Workers (GitFlare API)
       │
  ┌────┼────────────────┐
  │    │                 │
  ▼    ▼                 ▼
Artifacts   D1 Database   Durable Objects
(Git Repos)  (Metadata)    (Coordination)
  │                        │
  │    Queues ◄────────────┘
  │      │
  │      ▼
  │   Sandboxes (CI Runners)
  │      │
  │      ▼ (webhook)
  │   Coolify (Deploy)
  │      │
  │      ▼
  │   Mac Mini / Lenovo (Bare Metal)
  │
  └──► R2 (LFS / Build Artifacts)
```

## Quick Start

### Prerequisites
- Node.js 22+
- Cloudflare account with Workers Paid plan
- Wrangler CLI (`npm install -g wrangler`)

### Setup
```bash
# Install dependencies
npm install

# Login to Cloudflare
wrangler login

# Create D1 database
wrangler d1 create gitflare-db
# Update database_id in wrangler.jsonc with the returned ID

# Create R2 bucket
wrangler r2 bucket create gitflare-storage

# Create KV namespace
wrangler kv namespace create CACHE
# Update KV id in wrangler.jsonc

# Create queues
wrangler queues create gitflare-ci-jobs
wrangler queues create gitflare-deploy-jobs
wrangler queues create gitflare-ci-dlq
wrangler queues create gitflare-deploy-dlq

# Run D1 migrations
npm run db:migrate:remote

# Set secrets
wrangler secret put JWT_SECRET
wrangler secret put COOLIFY_API_KEY
wrangler secret put COOLIFY_BASE_URL
wrangler secret put ADMIN_API_KEY

# Deploy
npm run deploy
```

### Local Development
```bash
# Run migrations locally
npm run db:migrate:local

# Start dev server
npm run dev
```

## Usage

### Create a Repository
```bash
curl -X POST https://gitflare.your-domain.com/api/repos \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "starship", "description": "Autonomous coding agent platform"}'
```

### Create an API Key
```bash
curl -X POST https://gitflare.your-domain.com/api/keys \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "starship-push", "repo_id": "REPO_ID", "permissions": "write"}'
```

### Push Code
```bash
# Add GitFlare as a remote
git remote add gitflare https://gitflare.your-domain.com/git/starship

# Push (use API key as password)
git push gitflare main
# Username: anything
# Password: YOUR_API_KEY
```

### Add Coolify Deploy Target
```bash
curl -X POST https://gitflare.your-domain.com/api/repos/starship/deploys \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production",
    "type": "coolify",
    "coolify_app_id": "YOUR_COOLIFY_APP_ID",
    "coolify_base_url": "https://coolify.your-domain.com",
    "coolify_api_key": "YOUR_COOLIFY_KEY",
    "branch_filter": ["main"]
  }'
```

### CI Configuration
Add `.gitflare/ci.yml` to your repo:
```yaml
name: My Pipeline

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    sandbox: standard-2
    steps:
      - name: Install deps
        run: npm install
      - name: Run tests
        run: npm test

  deploy:
    needs: [test]
    deploy:
      target: coolify
      branch_filter: [main]
    steps:
      - name: Deploy
        run: echo "Deploying via Coolify webhook"
```

## First Project: Starship

Starship is the first project being hosted on GitFlare. See `examples/starship.ci.yml` for its CI configuration.

## Tech Stack
- **Runtime:** Cloudflare Workers (Hono framework)
- **Git Storage:** Cloudflare Artifacts (Git-native Zig/WASM engine)
- **Database:** Cloudflare D1 (SQLite at the edge)
- **Object Storage:** Cloudflare R2 (zero egress)
- **CI Runners:** Cloudflare Sandboxes (Docker containers)
- **Job Queue:** Cloudflare Queues
- **Real-time:** Cloudflare Durable Objects (WebSocket)
- **AI:** Cloudflare Workers AI (code review, search)
- **Deploy Target:** Coolify on bare metal

## License
Private — Thomas's projects.
