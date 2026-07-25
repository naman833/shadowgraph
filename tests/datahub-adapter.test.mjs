import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { classifyConsumers } from "../src/analysis/classify-consumers.js";

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

test("dataset identity resolution prefers the canonical qualified name and validates columns", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        data: {
          search: {
            searchResults: [
              {
                entity: {
                  urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,other.order_details_archive,PROD)",
                  type: "DATASET",
                  name: "order_details_archive",
                  schemaMetadata: {
                    fields: [{ fieldPath: "discount_percentage" }],
                  },
                },
              },
              {
                entity: {
                  urn: "urn:li:dataset:(urn:li:dataPlatform:dbt,showcase_ecommerce.order_details,PROD)",
                  type: "DATASET",
                  name: "order_details",
                  schemaMetadata: {
                    fields: [
                      {
                        fieldPath: "discount_percentage",
                        nativeDataType: "NUMBER",
                      },
                      { fieldPath: "order_id", nativeDataType: "NUMBER" },
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
  const result = await client.resolveDatasetIdentity("order_details", [
    "discount_percentage",
    "missing_field",
  ]);

  assert.equal(
    result.entity.urn,
    "urn:li:dataset:(urn:li:dataPlatform:dbt,showcase_ecommerce.order_details,PROD)",
  );
  assert.deepEqual(result.matchedColumns, ["discount_percentage"]);
  assert.deepEqual(result.missingColumns, ["missing_field"]);
  assert.equal(result.schemaFields[0].nativeDataType, "NUMBER");
  assert.match(result.warning, /missing_field/);
});

test("dataset identity resolution refuses equally ranked ambiguous matches", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        data: {
          search: {
            searchResults: ["one", "two"].map((suffix) => ({
              entity: {
                urn: `urn:li:dataset:(urn:li:dataPlatform:dbt,warehouse_${suffix}.orders,PROD)`,
                type: "DATASET",
                name: "orders",
                schemaMetadata: { fields: [{ fieldPath: "order_id" }] },
              },
            })),
          },
        },
      }),
      { status: 200 },
    );
  const client = new adapter.DataHubClient(config(), fetchImpl);
  const result = await client.resolveDatasetIdentity("orders", ["order_id"], "dbt");

  assert.equal(result.ambiguous, true);
  assert.equal(result.entity, null);
  assert.equal(result.candidates.length, 2);
  assert.match(result.warning, /no canonical identity was selected/i);
});

test("change context distinguishes column consumers from dataset-lineage-only assets", async () => {
  const root =
    "urn:li:dataset:(urn:li:dataPlatform:dbt,showcase_ecommerce.order_details,PROD)";
  const trueConsumer =
    "urn:li:dataset:(urn:li:dataPlatform:dbt,showcase_ecommerce.order_finance,PROD)";
  const lineageOnly =
    "urn:li:dataset:(urn:li:dataPlatform:dbt,showcase_ecommerce.order_audit,PROD)";
  const downstreamField = `urn:li:schemaField:(${trueConsumer},net_revenue)`;
  const requests = [];

  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (body.query.includes("ShadowGraphResolveEntity")) {
      return new Response(
        JSON.stringify({
          data: {
            search: {
              searchResults: [
                {
                  entity: {
                    urn: root,
                    type: "DATASET",
                    name: "order_details",
                    schemaMetadata: {
                      fields: [{ fieldPath: "discount_percentage" }],
                    },
                  },
                },
              ],
            },
          },
        }),
        { status: 200 },
      );
    }
    if (body.query.includes("ShadowGraphEntitiesByUrn")) {
      return new Response(
        JSON.stringify({
          data: {
            entities: [
              {
                urn: trueConsumer,
                type: "DATASET",
                name: "order_finance",
                platform: { name: "dbt" },
                ownership: {
                  owners: [
                    {
                      owner: {
                        urn: "urn:li:corpgroup:finance",
                        type: "CORP_GROUP",
                        name: "finance",
                        properties: { displayName: "Finance Analytics" },
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
        { status: 200 },
      );
    }

    const results = body.variables.input.urn.startsWith(
      "urn:li:schemaField:",
    )
      ? [{ degree: 1, entity: { urn: downstreamField, type: "SCHEMA_FIELD" } }]
      : [
          { degree: 1, entity: { urn: trueConsumer, type: "DATASET" } },
          { degree: 1, entity: { urn: lineageOnly, type: "DATASET" } },
        ];
    return new Response(
      JSON.stringify({
        data: { scrollAcrossLineage: { searchResults: results } },
      }),
      { status: 200 },
    );
  };

  const client = new adapter.DataHubClient(config(), fetchImpl);
  const result = await client.resolveChangeContext(
    [
      {
        kind: "column_expression_changed",
        filePath: "models/marts/order_details.sql",
        column: "discount_percentage",
      },
    ],
    1,
  );

  const consumers = result.changes[0].consumers;
  const affected = consumers.find((consumer) => consumer.urn === trueConsumer);
  const unrelated = consumers.find((consumer) => consumer.urn === lineageOnly);
  assert.deepEqual(affected.columnLineage, [
    {
      upstreamDataset: "order_details",
      upstreamColumn: "discount_percentage",
      downstreamColumn: "net_revenue",
    },
  ]);
  assert.equal(affected.owners[0].name, "Finance Analytics");
  assert.deepEqual(unrelated.columnLineage, []);
  assert.deepEqual(
    classifyConsumers(consumers, [
      {
        kind: "column_expression_changed",
        dataset: "order_details",
        column: "discount_percentage",
      },
    ]).map(({ urn, classification }) => ({ urn, classification })),
    [
      { urn: trueConsumer, classification: "true_consumer" },
      { urn: lineageOnly, classification: "lineage_only" },
    ],
  );
  assert.equal(
    requests.filter((body) =>
      body.query.includes("ShadowGraphEntitiesByUrn"),
    ).length,
    1,
  );
  assert.deepEqual(
    requests.find((body) =>
      body.query.includes("ShadowGraphEntitiesByUrn"),
    ).variables.urns,
    [trueConsumer],
  );
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
