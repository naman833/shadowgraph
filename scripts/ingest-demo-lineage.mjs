/**
 * Ingests the ShadowGraph demo project into a local DataHub instance.
 *
 * ShadowGraph's merge-blocking decision depends on column-level lineage, so
 * this script writes schemaMetadata, datasetProperties, table-level
 * upstreamLineage, fineGrainedLineages, and ownership for every asset declared
 * in demo-project/shadowgraph.json.
 *
 * The writes go through the DataHub OpenAPI v3 entity endpoints, which upsert
 * whole aspects by URN. Combined with the fixed audit timestamp below, every
 * run produces the same graph.
 *
 * Usage:
 *   node scripts/ingest-demo-lineage.mjs [--dry-run]
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

const dryRun = process.argv.includes("--dry-run");

/** Fixed so repeated runs are idempotent instead of churning audit stamps. */
const AUDIT_STAMP = {
  time: Date.parse("2026-01-01T00:00:00.000Z"),
  actor: "urn:li:corpuser:datahub",
};
const TECHNICAL_OWNER_TYPE_URN =
  "urn:li:ownershipType:__system__technical_owner";
const SNOWFLAKE_PLATFORM = "urn:li:dataPlatform:snowflake";
const DBT_PLATFORM = "urn:li:dataPlatform:dbt";
const REQUEST_TIMEOUT_MS = 60_000;

const RAW_ORDERS =
  "urn:li:dataset:(urn:li:dataPlatform:snowflake,acme.raw.orders,PROD)";
const STG_ORDERS =
  "urn:li:dataset:(urn:li:dataPlatform:dbt,acme_analytics.staging.stg_orders,PROD)";
const FCT_ORDER_REVENUE =
  "urn:li:dataset:(urn:li:dataPlatform:dbt,acme_analytics.marts.fct_order_revenue,PROD)";
const ORDER_DISCOUNT_FEATURES =
  "urn:li:dataset:(urn:li:dataPlatform:dbt,acme_analytics.features.order_discount_features,PROD)";

const CORP_GROUPS = [
  {
    urn: "urn:li:corpGroup:data-platform",
    displayName: "Data Platform Team",
    description: "Owns raw ingestion into the warehouse.",
    email: "data-platform@acme.example",
  },
  {
    urn: "urn:li:corpGroup:analytics-engineering",
    displayName: "Analytics Engineering",
    description: "Owns the dbt staging and marts layers.",
    email: "analytics-engineering@acme.example",
  },
  {
    urn: "urn:li:corpGroup:ml-platform",
    displayName: "ML Platform",
    description: "Owns feature tables consumed by production models.",
    email: "ml-platform@acme.example",
  },
];

/**
 * Column-level lineage is declared per downstream field so that the
 * fineGrainedLineages aspect stays readable next to the demo SQL.
 */
const DATASETS = [
  {
    urn: RAW_ORDERS,
    platform: SNOWFLAKE_PLATFORM,
    schemaName: "acme.raw.orders",
    name: "orders",
    description: "Raw order-entry data landed from the storefront.",
    owner: "urn:li:corpGroup:data-platform",
    fields: [
      {
        path: "order_id",
        native: "BIGINT",
        kind: "number",
        doc: "Primary key.",
      },
      { path: "customer_id", native: "VARCHAR", kind: "string" },
      { path: "order_date", native: "DATE", kind: "date" },
      {
        path: "customer_segment",
        native: "VARCHAR",
        kind: "string",
        doc: "enterprise or consumer.",
      },
      {
        path: "gross_amount",
        native: "DOUBLE",
        kind: "number",
        doc: "Order value before any discount, in USD.",
      },
      {
        path: "discount_percentage",
        native: "DOUBLE",
        kind: "number",
        doc: "Discount expressed as a WHOLE PERCENTAGE. 25 means 25 percent. Consumers must divide by 100 before arithmetic use.",
      },
    ],
    upstreams: [],
    columnLineage: [],
  },
  {
    urn: STG_ORDERS,
    platform: DBT_PLATFORM,
    schemaName: "acme_analytics.staging.stg_orders",
    name: "stg_orders",
    description:
      "Order grain with the normalized discount rate and net revenue.",
    owner: "urn:li:corpGroup:analytics-engineering",
    fields: [
      { path: "order_id", native: "BIGINT", kind: "number" },
      { path: "customer_id", native: "VARCHAR", kind: "string" },
      { path: "order_date", native: "DATE", kind: "date" },
      { path: "customer_segment", native: "VARCHAR", kind: "string" },
      { path: "gross_amount", native: "DOUBLE", kind: "number" },
      { path: "discount_percentage", native: "DOUBLE", kind: "number" },
      {
        path: "discount_rate",
        native: "DOUBLE",
        kind: "number",
        doc: "Discount as a fraction between 0 and 1.",
      },
      {
        path: "net_revenue",
        native: "DOUBLE",
        kind: "number",
        doc: "gross_amount after discount, in USD.",
      },
    ],
    upstreams: [RAW_ORDERS],
    columnLineage: [
      { to: "order_id", from: [[RAW_ORDERS, "order_id"]], op: "IDENTITY" },
      {
        to: "customer_id",
        from: [[RAW_ORDERS, "customer_id"]],
        op: "IDENTITY",
      },
      { to: "order_date", from: [[RAW_ORDERS, "order_date"]], op: "IDENTITY" },
      {
        to: "customer_segment",
        from: [[RAW_ORDERS, "customer_segment"]],
        op: "IDENTITY",
      },
      {
        to: "gross_amount",
        from: [[RAW_ORDERS, "gross_amount"]],
        op: "IDENTITY",
      },
      {
        to: "discount_percentage",
        from: [[RAW_ORDERS, "discount_percentage"]],
        op: "IDENTITY",
      },
      {
        to: "discount_rate",
        from: [[RAW_ORDERS, "discount_percentage"]],
        op: "TRANSFORM",
      },
      {
        to: "net_revenue",
        from: [
          [RAW_ORDERS, "gross_amount"],
          [RAW_ORDERS, "discount_percentage"],
        ],
        op: "TRANSFORM",
      },
    ],
  },
  {
    urn: FCT_ORDER_REVENUE,
    platform: DBT_PLATFORM,
    schemaName: "acme_analytics.marts.fct_order_revenue",
    name: "fct_order_revenue",
    description: "Net revenue aggregated by customer segment.",
    owner: "urn:li:corpGroup:analytics-engineering",
    fields: [
      { path: "customer_segment", native: "VARCHAR", kind: "string" },
      { path: "order_count", native: "BIGINT", kind: "number" },
      { path: "gross_revenue", native: "DOUBLE", kind: "number" },
      { path: "net_revenue", native: "DOUBLE", kind: "number" },
      { path: "average_discount_rate", native: "DOUBLE", kind: "number" },
    ],
    upstreams: [STG_ORDERS],
    columnLineage: [
      {
        to: "customer_segment",
        from: [[STG_ORDERS, "customer_segment"]],
        op: "GROUP_BY",
      },
      { to: "order_count", from: [[STG_ORDERS, "order_id"]], op: "COUNT" },
      { to: "gross_revenue", from: [[STG_ORDERS, "gross_amount"]], op: "SUM" },
      { to: "net_revenue", from: [[STG_ORDERS, "net_revenue"]], op: "SUM" },
      {
        to: "average_discount_rate",
        from: [[STG_ORDERS, "discount_rate"]],
        op: "AVG",
      },
    ],
  },
  {
    urn: ORDER_DISCOUNT_FEATURES,
    platform: DBT_PLATFORM,
    schemaName: "acme_analytics.features.order_discount_features",
    name: "order_discount_features",
    description: "Fraud-model features derived from the discount rate.",
    owner: "urn:li:corpGroup:ml-platform",
    fields: [
      { path: "order_id", native: "BIGINT", kind: "number" },
      { path: "customer_segment", native: "VARCHAR", kind: "string" },
      {
        path: "order_discount_ratio",
        native: "DOUBLE",
        kind: "number",
        doc: "Expected within [0, 1]; the model was trained on that range.",
      },
      { path: "is_high_discount", native: "INTEGER", kind: "number" },
    ],
    upstreams: [STG_ORDERS],
    columnLineage: [
      { to: "order_id", from: [[STG_ORDERS, "order_id"]], op: "IDENTITY" },
      {
        to: "customer_segment",
        from: [[STG_ORDERS, "customer_segment"]],
        op: "IDENTITY",
      },
      {
        to: "order_discount_ratio",
        from: [[STG_ORDERS, "discount_rate"]],
        op: "IDENTITY",
      },
      {
        to: "is_high_discount",
        from: [[STG_ORDERS, "discount_rate"]],
        op: "TRANSFORM",
      },
    ],
  },
];

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
  return { url: unquote(url), token: token ? unquote(token) : undefined };
}

/** Maps a column kind onto DataHub's SchemaFieldDataType union. */
function schemaFieldType(kind) {
  const unions = {
    number: "com.linkedin.schema.NumberType",
    string: "com.linkedin.schema.StringType",
    date: "com.linkedin.schema.DateType",
    boolean: "com.linkedin.schema.BooleanType",
  };
  const union = unions[kind];
  if (!union) throw new Error(`Unsupported column kind: ${kind}`);
  return { type: { [union]: {} } };
}

function schemaFieldUrn(datasetUrn, fieldPath) {
  return `urn:li:schemaField:(${datasetUrn},${fieldPath})`;
}

function schemaMetadataAspect(dataset) {
  return {
    value: {
      schemaName: dataset.schemaName,
      platform: dataset.platform,
      version: 0,
      hash: "",
      platformSchema: {
        "com.linkedin.schema.OtherSchema": {
          rawSchema: dataset.fields
            .map((field) => `${field.path} ${field.native}`)
            .join(", "),
        },
      },
      created: AUDIT_STAMP,
      lastModified: AUDIT_STAMP,
      fields: dataset.fields.map((field) => ({
        fieldPath: field.path,
        nativeDataType: field.native,
        type: schemaFieldType(field.kind),
        nullable: false,
        recursive: false,
        ...(field.doc ? { description: field.doc } : {}),
      })),
    },
  };
}

function datasetPropertiesAspect(dataset) {
  return {
    value: {
      name: dataset.name,
      qualifiedName: dataset.schemaName,
      description: dataset.description,
      customProperties: { managed_by: "shadowgraph-demo" },
    },
  };
}

function ownershipAspect(dataset) {
  return {
    value: {
      owners: [
        {
          owner: dataset.owner,
          type: "TECHNICAL_OWNER",
          typeUrn: TECHNICAL_OWNER_TYPE_URN,
        },
      ],
      lastModified: AUDIT_STAMP,
    },
  };
}

function upstreamLineageAspect(dataset) {
  if (!dataset.upstreams.length) return undefined;
  return {
    value: {
      upstreams: dataset.upstreams.map((upstream) => ({
        dataset: upstream,
        type: "TRANSFORMED",
        auditStamp: AUDIT_STAMP,
      })),
      fineGrainedLineages: dataset.columnLineage.map((edge) => ({
        upstreamType: "FIELD_SET",
        upstreams: edge.from.map(([upstreamUrn, upstreamField]) =>
          schemaFieldUrn(upstreamUrn, upstreamField),
        ),
        downstreamType: "FIELD",
        downstreams: [schemaFieldUrn(dataset.urn, edge.to)],
        transformOperation: edge.op,
        confidenceScore: 1.0,
      })),
    },
  };
}

function datasetRequest(dataset) {
  const upstreamLineage = upstreamLineageAspect(dataset);
  return {
    urn: dataset.urn,
    datasetProperties: datasetPropertiesAspect(dataset),
    schemaMetadata: schemaMetadataAspect(dataset),
    ownership: ownershipAspect(dataset),
    ...(upstreamLineage ? { upstreamLineage } : {}),
  };
}

function corpGroupRequest(group) {
  return {
    urn: group.urn,
    corpGroupInfo: {
      value: {
        displayName: group.displayName,
        description: group.description,
        email: group.email,
        admins: [],
        members: [],
        groups: [],
        created: AUDIT_STAMP,
      },
    },
  };
}

/**
 * Writes a batch of entities. Any non-2xx response, non-JSON body, or partial
 * acknowledgement aborts the run: a half-ingested graph would silently change
 * ShadowGraph's merge verdicts.
 */
async function postEntities(connection, entityName, payload) {
  const url = `${connection.url}/openapi/v3/entity/${entityName}?async=false`;
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (connection.token) headers.authorization = `Bearer ${connection.token}`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(`Could not reach DataHub at ${url}`, { cause });
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `DataHub returned HTTP ${response.status} for POST /openapi/v3/entity/${entityName}: ${body.slice(0, 2000)}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new Error(
      `DataHub returned a non-JSON response for ${entityName}: ${body.slice(0, 500)}`,
      { cause },
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== payload.length) {
    throw new Error(
      `DataHub acknowledged ${Array.isArray(parsed) ? parsed.length : "an unexpected shape"} of ${payload.length} ${entityName} writes`,
    );
  }
  return parsed;
}

const connection = await loadDataHubConnection();
const groupPayload = CORP_GROUPS.map(corpGroupRequest);
const datasetPayload = DATASETS.map(datasetRequest);
const tableEdgeCount = DATASETS.reduce(
  (total, dataset) => total + dataset.upstreams.length,
  0,
);
const columnEdgeCount = DATASETS.reduce(
  (total, dataset) => total + dataset.columnLineage.length,
  0,
);

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        datahub: connection.url,
        authenticated: Boolean(connection.token),
        corpgroup: groupPayload,
        dataset: datasetPayload,
      },
      null,
      2,
    ),
  );
} else {
  await postEntities(connection, "corpgroup", groupPayload);
  await postEntities(connection, "dataset", datasetPayload);
}

console.log(
  `${dryRun ? "Would ingest" : "Ingested"} ShadowGraph demo metadata into ${connection.url}`,
);
console.log(`  corpGroups: ${CORP_GROUPS.length}`);
console.log(
  `  datasets: ${DATASETS.length} (datasetProperties, schemaMetadata, ownership)`,
);
console.log(`  table-level upstream edges: ${tableEdgeCount}`);
console.log(`  column-level lineage edges: ${columnEdgeCount}`);
for (const dataset of DATASETS) {
  console.log(
    `  - ${dataset.schemaName}: ${dataset.fields.length} fields, ${dataset.upstreams.length} upstreams, ${dataset.columnLineage.length} column edges`,
  );
}
