import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../src/datahub/index.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
}).outputText;
const adapter = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

function config(overrides = {}) {
  return {
    baseUrl: "http://datahub.test",
    graphqlUrl: "http://datahub.test/api/graphql",
    timeoutMs: 1000,
    demoFallback: false,
    ...overrides,
  };
}

test("loadDataHubConfig normalizes urls and parses explicit values", () => {
  const result = adapter.loadDataHubConfig({
    DATAHUB_GMS_URL: "https://catalog.example/",
    DATAHUB_TOKEN: "secret",
    DATAHUB_TIMEOUT_MS: "1200",
    DATAHUB_DEMO_FALLBACK: "false",
  });

  assert.deepEqual(result, {
    baseUrl: "https://catalog.example",
    graphqlUrl: "https://catalog.example/api/graphql",
    token: "secret",
    timeoutMs: 1200,
    demoFallback: false,
  });
});

test("loadDataHubConfig rejects unsafe configuration", () => {
  assert.throws(
    () => adapter.loadDataHubConfig({ DATAHUB_GMS_URL: "file:///tmp/datahub" }),
    (error) => error.code === "CONFIG",
  );
  assert.throws(
    () => adapter.loadDataHubConfig({ DATAHUB_TIMEOUT_MS: "10" }),
    (error) => error.code === "CONFIG",
  );
});

test("graphqlRequest sends auth, query variables, and returns typed data", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ data: { ping: "pong" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await adapter.graphqlRequest(
    config({ token: "abc" }),
    "query Ping($id: ID!) { ping(id: $id) }",
    { id: "42" },
    fetchImpl,
  );

  assert.deepEqual(result, { ping: "pong" });
  assert.equal(seen.url, "http://datahub.test/api/graphql");
  assert.equal(seen.init.headers.authorization, "Bearer abc");
  assert.deepEqual(JSON.parse(seen.init.body).variables, { id: "42" });
});

test("graphqlRequest preserves GraphQL errors instead of falling back", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({ errors: [{ message: "Not authorized" }] }),
      { status: 200 },
    );

  await assert.rejects(
    adapter.graphqlRequest(config(), "query { me { urn } }", {}, fetchImpl),
    (error) => error.code === "GRAPHQL" && /Not authorized/.test(error.message),
  );
});

test("client normalizes a live entity and its owner", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        data: {
          search: {
            searchResults: [
              {
                entity: {
                  urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,acme.orders,PROD)",
                  type: "DATASET",
                  name: "orders",
                  platform: { name: "Snowflake" },
                  ownership: {
                    owners: [
                      {
                        owner: {
                          urn: "urn:li:corpuser:alex",
                          type: "CORP_USER",
                          username: "alex",
                          properties: { displayName: "Alex Data" },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      }),
      { status: 200 },
    );
  const client = new adapter.DataHubClient(config(), fetchImpl);
  const result = await client.resolveEntity("orders");

  assert.equal(result.source, "live");
  assert.equal(result.entity.name, "orders");
  assert.equal(result.entity.platform, "Snowflake");
  assert.deepEqual(result.entity.owners[0], {
    urn: "urn:li:corpuser:alex",
    name: "Alex Data",
    type: "CORP_USER",
  });
});

test("network-only demo fallback is deterministic and clearly labelled", async () => {
  const fetchImpl = async () => {
    throw new TypeError("connection refused");
  };
  const client = new adapter.DataHubClient(
    config({ demoFallback: true }),
    fetchImpl,
  );

  const entity = await client.resolveEntity("orders");
  const lineage = await client.downstreamLineage(entity.entity.urn, 2);

  assert.equal(entity.source, "demo");
  assert.equal(entity.entity.source, "demo");
  assert.match(entity.warning, /labelled demo metadata/i);
  assert.equal(lineage.source, "demo");
  assert.deepEqual(
    lineage.nodes.map((node) => node.name),
    ["order_finance", "Executive Revenue", "fraud_features"],
  );
  assert.ok(lineage.nodes.every((node) => node.source === "demo"));
});

test("lineage traversal performs a cycle-safe one-hop BFS with real edges", async () => {
  const requestBodies = [];
  const root =
    "urn:li:dataset:(urn:li:dataPlatform:snowflake,acme.orders,PROD)";
  const finance =
    "urn:li:dataset:(urn:li:dataPlatform:dbt,acme.analytics.order_finance,PROD)";
  const customers =
    "urn:li:dataset:(urn:li:dataPlatform:dbt,acme.analytics.customers,PROD)";
  const dashboard = "urn:li:dashboard:(looker,revenue_overview)";
  const adjacency = new Map([
    [
      root,
      [
        { urn: finance, type: "DATASET" },
        { urn: customers, type: "DATASET" },
      ],
    ],
    [finance, [{ urn: dashboard, type: "DASHBOARD" }]],
    [
      customers,
      [
        { urn: dashboard, type: "DASHBOARD" },
        { urn: root, type: "DATASET" },
      ],
    ],
  ]);

  const fetchImpl = async (_url, init) => {
    const requestBody = JSON.parse(init.body);
    requestBodies.push(requestBody);
    const entities = adjacency.get(requestBody.variables.input.urn) ?? [];
    return new Response(
      JSON.stringify({
        data: {
          scrollAcrossLineage: {
            searchResults: entities.map((entity) => ({ degree: 1, entity })),
          },
        },
      }),
      { status: 200 },
    );
  };
  const client = new adapter.DataHubClient(config(), fetchImpl);
  const lineage = await client.downstreamLineage(root, 2);

  assert.deepEqual(
    requestBodies.map((body) => body.variables.input.urn),
    [root, finance, customers],
  );
  assert.ok(
    requestBodies.every(
      (body) =>
        body.variables.input.count === 25 &&
        body.variables.input.orFilters[0].and[0].values.length === 1 &&
        body.variables.input.orFilters[0].and[0].values[0] === "1",
    ),
  );
  assert.equal(lineage.source, "live");
  assert.deepEqual(
    lineage.nodes.map(({ urn, name, degree }) => ({ urn, name, degree })),
    [
      { urn: finance, name: "order_finance", degree: 1 },
      { urn: customers, name: "customers", degree: 1 },
      { urn: dashboard, name: "revenue_overview", degree: 2 },
    ],
  );
  assert.deepEqual(lineage.edges, [
    { from: root, to: finance, degree: 1 },
    { from: root, to: customers, degree: 1 },
    { from: finance, to: dashboard, degree: 2 },
    { from: customers, to: dashboard, degree: 2 },
  ]);
});

test("dataset names are parsed from the URN dataset field, not the environment", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        data: {
          scrollAcrossLineage: {
            searchResults: [
              {
                degree: 1,
                entity: {
                  urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,warehouse.analytics.daily%20orders,PROD)",
                  type: "DATASET",
                },
              },
            ],
          },
        },
      }),
      { status: 200 },
    );
  const client = new adapter.DataHubClient(config(), fetchImpl);
  const lineage = await client.downstreamLineage(
    "urn:li:dataset:(urn:li:dataPlatform:snowflake,warehouse.raw.orders,PROD)",
    1,
  );

  assert.equal(lineage.nodes[0].name, "daily orders");
});

test("lineage traversal enforces a hard node bound", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        data: {
          scrollAcrossLineage: {
            searchResults: Array.from({ length: 150 }, (_, index) => ({
              degree: 1,
              entity: {
                urn: `urn:li:dataset:(urn:li:dataPlatform:test,table_${index},PROD)`,
                type: "DATASET",
              },
            })),
          },
        },
      }),
      { status: 200 },
    );
  const client = new adapter.DataHubClient(config(), fetchImpl);
  const lineage = await client.downstreamLineage(
    "urn:li:dataset:(urn:li:dataPlatform:test,root,PROD)",
    1,
  );

  assert.equal(lineage.nodes.length, 100);
  assert.equal(lineage.edges.length, 100);
  assert.match(lineage.warning, /100-node safety limit/);
});

test("demo fallback does not hide HTTP or GraphQL integration failures", async () => {
  const fetchImpl = async () =>
    new Response("unauthorized", { status: 401 });
  const client = new adapter.DataHubClient(
    config({ demoFallback: true }),
    fetchImpl,
  );

  await assert.rejects(
    client.resolveEntity("orders"),
    (error) => error.code === "HTTP" && error.status === 401,
  );
});
