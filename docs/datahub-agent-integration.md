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
demo remains reliable. The DataHub API routes, GraphQL adapter, and MCP smoke
path use live DataHub when configured.

The local adapter was also verified against showcase `order_details`: canonical
name parsing returned `order_details`, schema validation matched `order_id`,
depth 1 returned one node/edge, and bounded depth 3 returned 25 nodes with 51
real parent→child edges. Column context returned 25 column consumers and
hydrated owner metadata for the affected subset.

Evidence writeback uses the official MCP `save_document` contract. Its transport
derives a deterministic Document URN from repository, PR, and full head SHA, so
retries update one record. Mutation discovery was verified without writing;
actual writeback remains approval-gated.

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
