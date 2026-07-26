# Setup

This guide separates the deterministic browser demo from the live DataHub
integration paths.

## 1. Run the application

Requirements:

- Node.js 22.13 or newer
- npm

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The application opens in PR
selector mode and fetches real pull-request evidence from GitHub. Public
repositories work unauthenticated at 60 requests per hour, but downloading the
evidence artifact that carries the replay measurements requires a token.

The routes run inside the Cloudflare Workers runtime, which does not inherit the
shell environment, so `process.env` in a route comes from `.dev.vars` rather than
from an exported variable:

```bash
printf 'GITHUB_TOKEN=%s\n' "$(gh auth token -h github.com)" > .dev.vars
```

`.dev.vars*` is git-ignored. Restart the dev server after creating it.

A DataHub instance is not required to load a pull request; without one the UI
reports DataHub as unavailable rather than substituting demo data.

Run the repository checks with:

```bash
npm test
npm run lint
npm run demo:golden
```

## 2. Start DataHub locally

Start the live context environment with the DataHub CLI and Docker:

```bash
datahub docker quickstart
datahub init --username datahub --password datahub
datahub datapack load showcase-ecommerce
```

Open [http://localhost:9002](http://localhost:9002) and sign in with the local
Quickstart credentials (`datahub` / `datahub`). Confirm that datasets, owners,
and upstream/downstream lineage are visible.

The showcase datapack provides a rich metadata graph. DuckDB replay uses
separately supplied bounded row fixtures because metadata alone does not contain
warehouse rows.

## 3. Live integration configuration

The application GraphQL adapter and official MCP server use server-side
environment variables:

```env
DATAHUB_GMS_URL=http://localhost:8080
DATAHUB_FRONTEND_URL=http://localhost:9002
DATAHUB_TOKEN=
DATAHUB_GMS_TOKEN=
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
OLLAMA_ENABLED=false
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b
```

`DATAHUB_TOKEN` is consumed by ShadowGraph's GraphQL adapter.
`DATAHUB_GMS_TOKEN` is the official MCP server's variable. They may contain the
same local token, but both remain empty in committed examples.

Do not commit tokens, private keys, webhook secrets, or a populated `.env` file.

Ollama is optional and entirely local. When enabled, it summarizes already
computed evidence; it never decides whether a change passes or blocks. The
deterministic pipeline works without any LLM or paid API.

## 4. Verify the official DataHub agent interface

ShadowGraph vendors DataHub's official agent skills under `.agents/skills` and
uses the official self-hosted MCP server. This is free and does not require an
OpenAI or Codex API key.

Install the free `uvx` runner on macOS:

```bash
brew install uv
```

After `datahub init` has created a private CLI profile, run:

```bash
npm run verify:datahub-mcp
```

The result should report `"ok": true`, `"readOnly": true`,
`"searchReturnedUrn": true`, and `"lineageCallSucceeded": true`. See
[datahub-agent-integration.md](datahub-agent-integration.md) for the security
model and portable client configuration.

## 5. Production integration checklist

- Verify GitHub webhook signatures before processing payloads.
- Resolve every result against the PR's immutable commit SHA.
- Give the DataHub credential only the read/write permissions the adapter needs.
- Keep replay data isolated from production and avoid logging row contents.
- Publish a neutral/inconclusive check when metadata or replay evidence is
  incomplete; never report an unverified change as safe.
- Redact credentials and sensitive SQL literals from stored reports.

## Troubleshooting

### The page loads but analysis values never change

Select **Run Shadow Analysis**. The reference sequence advances through five
stages and ends in a blocked decision.

### DataHub says “No Owned Assets”

That only means the signed-in user is not assigned as an owner. It does not mean
the showcase datapack failed. Browse the platform cards, domains, or catalog and
open an asset's lineage tab.

### DataHub CLI warns about Python above 3.11

If the command completes, this is a compatibility warning. If Quickstart fails,
install or isolate the CLI with a supported Python version and retry according
to the DataHub documentation.

### MCP verification says `uvx` was not found

Install `uv` with `brew install uv`, then confirm `uvx --version` works.

### MCP verification cannot find credentials

Run `datahub init --username datahub --password datahub` for the local
quickstart, or set `DATAHUB_GMS_URL` and `DATAHUB_GMS_TOKEN` in the shell.
Never paste a token into a committed file.

### Docker Quickstart is slow

The first run downloads several large images. Wait for `DataHub is now running`
before loading a datapack.
