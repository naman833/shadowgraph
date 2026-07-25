import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const MCP_PACKAGE =
  process.env.DATAHUB_MCP_PACKAGE ?? "mcp-server-datahub@0.6.0";
const REQUEST_TIMEOUT_MS = 60_000;
const inspectMutations = process.env.DATAHUB_MCP_INSPECT_MUTATIONS === "true";

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadDataHubConnection() {
  let url = process.env.DATAHUB_GMS_URL;
  let token = process.env.DATAHUB_GMS_TOKEN;

  if (!url || !token) {
    try {
      const profile = await readFile(`${homedir()}/.datahubenv`, "utf8");
      url ??= profile.match(/^\s*server:\s*([^#\n]+)/m)?.[1];
      token ??= profile.match(/^\s*token:\s*([^#\n]+)/m)?.[1];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  assert.ok(url, "Set DATAHUB_GMS_URL or configure ~/.datahubenv");
  assert.ok(token, "Set DATAHUB_GMS_TOKEN or configure ~/.datahubenv");
  return { url: unquote(url), token: unquote(token) };
}

function createRpcClient(child) {
  let buffer = "";
  let nextId = 1;
  const pending = new Map();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined) continue;

      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) {
        request.reject(
          new Error(
            `MCP ${request.method} failed: ${JSON.stringify(message.error)}`,
          ),
        );
      } else {
        request.resolve(message.result);
      }
    }
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params = {}) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { method, resolve, reject, timeout });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  return {
    notify(method, params = {}) {
      send({ jsonrpc: "2.0", method, params });
    },
    request,
  };
}

function textContent(result) {
  return (
    result?.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n") ?? ""
  );
}

const connection = await loadDataHubConnection();
const stderrChunks = [];
const child = spawn("uvx", [MCP_PACKAGE, "--transport", "stdio"], {
  env: {
    ...process.env,
    DATAHUB_GMS_URL: connection.url,
    DATAHUB_GMS_TOKEN: connection.token,
    TOOLS_IS_MUTATION_ENABLED: inspectMutations ? "true" : "false",
    TOOLS_IS_USER_ENABLED: "false",
    DATAHUB_MCP_DOCUMENT_TOOLS_DISABLED: "true",
    SAVE_DOCUMENT_TOOL_ENABLED: inspectMutations ? "true" : "false",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrChunks.push(chunk);
  if (stderrChunks.join("").length > 20_000) stderrChunks.shift();
});

try {
  const rpc = createRpcClient(child);
  await rpc.request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "shadowgraph-mcp-smoke", version: "0.1.0" },
  });
  rpc.notify("notifications/initialized");

  const listed = await rpc.request("tools/list");
  const toolNames = listed.tools.map((tool) => tool.name);
  const saveDocumentTool = listed.tools.find(
    (tool) => tool.name === "save_document",
  );
  for (const required of [
    "search",
    "get_entities",
    "get_lineage",
    "list_schema_fields",
  ]) {
    assert.ok(toolNames.includes(required), `Missing MCP tool: ${required}`);
  }

  const search = await rpc.request("tools/call", {
    name: "search",
    arguments: { query: "orders" },
  });
  assert.equal(search.isError, false, textContent(search));
  const searchText = textContent(search);
  assert.match(searchText, /urn:li:/i, "MCP search returned no DataHub URNs");

  const lineageTool = listed.tools.find((tool) => tool.name === "get_lineage");
  const lineageProperties = lineageTool.inputSchema?.properties ?? {};
  const lineageUrn =
    process.env.DATAHUB_MCP_SMOKE_URN ??
    searchText.match(/urn:li:dataset:\([^)]+\)/i)?.[0];
  assert.ok(lineageUrn, "Could not select a dataset URN for MCP lineage");

  const lineageArguments = { urn: lineageUrn };
  if (lineageProperties.upstream) lineageArguments.upstream = false;
  if (lineageProperties.direction) {
    lineageArguments.direction =
      lineageProperties.direction.enum?.find(
        (value) => value.toLowerCase() === "downstream",
      ) ?? "downstream";
  }
  if (lineageProperties.depth) lineageArguments.depth = 1;
  if (lineageProperties.max_hops) lineageArguments.max_hops = 1;

  const lineage = await rpc.request("tools/call", {
    name: "get_lineage",
    arguments: lineageArguments,
  });
  assert.equal(lineage.isError, false, textContent(lineage));

  console.log(
    JSON.stringify(
      {
        ok: true,
        server: MCP_PACKAGE,
        datahub: connection.url,
        readOnly: true,
        toolCount: toolNames.length,
        requiredTools: [
          "search",
          "get_entities",
          "get_lineage",
          "list_schema_fields",
        ],
        search: "orders",
        searchReturnedUrn: true,
        lineageUrn,
        lineageCallSucceeded: true,
        mutationDiscoveryOnly: inspectMutations,
        saveDocumentAvailable: Boolean(saveDocumentTool),
        ...(inspectMutations && saveDocumentTool
          ? { saveDocumentInputSchema: saveDocumentTool.inputSchema }
          : {}),
      },
      null,
      2,
    ),
  );
} catch (error) {
  const diagnostics = stderrChunks.join("").trim();
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  child.kill("SIGTERM");
}
