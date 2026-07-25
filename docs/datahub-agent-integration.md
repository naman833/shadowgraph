# DataHub agent integration

ShadowGraph uses both parts of DataHub's official Agent Context interface:

- The **DataHub MCP Server** supplies structured tools such as `search`,
  `get_entities`, `get_lineage`, and `list_schema_fields`.
- The **DataHub Skills** supply the workflow instructions for combining those
  tools into search, lineage, enrichment, and quality investigations.

DataHub's documentation describes tools as individual actions and skills as the
judgment for chaining those actions. ShadowGraph needs both: MCP provides live
catalog context, while the skills teach an agent how to perform a defensible
change-impact analysis.

Official references:

- [DataHub Skills](https://docs.datahub.com/docs/dev-guides/agent-context/skills)
- [DataHub MCP Server](https://docs.datahub.com/docs/features/feature-guides/mcp)
- [DataHub Skills source](https://github.com/datahub-project/datahub-skills)
- [DataHub MCP source](https://github.com/acryldata/mcp-server-datahub)

## Cost and account requirements

The local path is entirely free and open source. It uses DataHub Core, Docker,
the official self-hosted MCP server, the official skills, Node.js, and `uv`.
ShadowGraph does not require a Codex connection, an OpenAI API key, or DataHub
Cloud. Codex is only one possible development environment capable of reading
the portable skill files.

## What is live

The following path has been exercised against the local DataHub Core quickstart:

1. Start `mcp-server-datahub` version 0.6.0 over stdio.
2. Authenticate using the private DataHub CLI profile or environment variables.
3. Negotiate an MCP session and list available tools.
4. Verify the required read-only tools are present.
5. Search the live catalog for `orders`.
6. Select a returned dataset URN and invoke live lineage.

Mutation, user, document, and data-quality mutation tools are disabled by the
smoke test. No token is printed, copied into the repository, or included in the
result.

The browser UI still presents deterministic reference evidence so the hosted
demo remains reliable. The DataHub API routes, GraphQL adapter, MCP smoke path,
and evidence writeback use live DataHub when configured.

The local adapter was also verified against showcase `order_details`: canonical
name parsing returned `order_details`, schema validation matched `order_id`,
depth 1 returned one node/edge, and bounded depth 3 returned 25 nodes with 51
real parent→child edges. Column context returned 25 column consumers and
hydrated owner metadata for the affected subset.

## Evidence writeback

Writeback derives a deterministic Document URN from repository, PR, and full head
SHA, so retries update one record instead of appending duplicates. It is
approval-gated: `npm run analyze:pr` writes nothing unless `--record-evidence`
is passed, and the transport itself refuses a non-dry-run write without explicit
approval.

Two transports implement the same plan:

| Transport | Path | Availability |
| --- | --- | --- |
| `DataHubGraphQLDocumentTransport` | GMS `createDocument` / `updateDocumentContents` / `updateDocumentRelatedEntities` | Verified against DataHub v1.5.0.6 |
| `DataHubMcpDocumentTransport` | Official MCP `save_document` tool | Only where the MCP build exposes it |

The GraphQL transport is the default because `mcp-server-datahub@0.6.0` does not
expose `save_document` — the smoke test reports this as
`saveDocumentAvailable: false`.

It attempts `createDocument` first and treats the duplicate-ID rejection as the
signal to update. Branching on an existence query instead would be incorrect:
DataHub's `exists` field is search-index backed and lags a write by seconds.

Every write is read back and its idempotency marker re-verified before success is
reported. Verified locally against both real pull requests:

```text
PR #1 first approved run   -> created, marker present, 3 related assets
PR #1 repeated approved run -> updated, same URN, still one document
PR #2 approved run         -> created
DataHub DOCUMENT search for "ShadowGraph" -> total=2
```

Two documents for two pull requests, after three approved runs, is the
idempotency proof.

## Run locally

Prerequisites:

- DataHub Core quickstart running at `http://localhost:8080`
- Showcase metadata loaded
- A DataHub CLI profile at `~/.datahubenv`, or the two MCP environment variables
- [`uv`](https://docs.astral.sh/uv/) providing `uvx`

Configure the local quickstart:

```bash
datahub docker quickstart
datahub init --username datahub --password datahub
datahub datapack load showcase-ecommerce
```

Install the free MCP runner on macOS:

```bash
brew install uv
```

Then run:

```bash
npm run verify:datahub-mcp
```

A successful result includes:

```json
{
  "ok": true,
  "server": "mcp-server-datahub@0.6.0",
  "datahub": "http://localhost:8080",
  "readOnly": true,
  "searchReturnedUrn": true,
  "lineageCallSucceeded": true
}
```

The script accepts either:

```bash
export DATAHUB_GMS_URL="http://localhost:8080"
export DATAHUB_GMS_TOKEN="<token>"
```

or the existing DataHub CLI profile. Never commit either a populated `.env`
file or a token-bearing MCP client configuration.

## Why the MCP server is launched by a script

MCP client configuration formats differ across Codex, Cursor, Claude Code,
Copilot, and other agents. ShadowGraph therefore keeps the integration portable:
the smoke script launches the official stdio server directly and validates the
same protocol and tools any compatible client uses. Contributors may also point
their preferred client at:

- command: `uvx`
- arguments: `mcp-server-datahub@0.6.0`
- environment: `DATAHUB_GMS_URL` and `DATAHUB_GMS_TOKEN`

This avoids committing an editor-specific configuration or linking the project
to a particular agent vendor.
