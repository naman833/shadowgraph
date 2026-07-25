# Setup

This guide separates what can be run today from the planned live-integration
environment.

## 1. Run the application

Requirements:

- Node.js 22.13 or newer
- npm

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The application uses
deterministic reference data; a DataHub instance is not required to explore the
current vertical slice.

Run the repository checks with:

```bash
npm test
npm run lint
```

## 2. Start DataHub locally

The live adapter is in progress, but contributors can prepare the intended
context environment with the DataHub CLI and Docker:

```bash
datahub docker quickstart
datahub init --username datahub --password datahub
datahub datapack load showcase-ecommerce
```

Open [http://localhost:9002](http://localhost:9002) and sign in with the local
Quickstart credentials (`datahub` / `datahub`). Confirm that datasets, owners,
and upstream/downstream lineage are visible.

The showcase datapack provides a rich metadata graph. The planned executable
replay uses a separately loaded static dataset, such as fiction-retail, because
metadata alone does not contain warehouse rows.

## 3. Planned integration configuration

When the live adapters land, the service will use server-side environment
variables similar to:

```env
DATAHUB_GMS_URL=http://localhost:8080
DATAHUB_FRONTEND_URL=http://localhost:9002
DATAHUB_TOKEN=
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
```

Do not commit tokens, private keys, webhook secrets, or a populated `.env` file.
The exact names may change with the adapter implementation; treat this block as
the intended contract, not a claim that configuration is currently consumed.

## 4. Production integration checklist

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

### Docker Quickstart is slow

The first run downloads several large images. Wait for `DataHub is now running`
before loading a datapack.
