import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildReplayPlan,
  compileModel,
  DemoProjectError,
  loadManifest,
  parseSeedCsv,
} from "../src/demo/index.js";
import { replayCounterfactual } from "../src/replay/index.js";

const projectUrl = new URL("../demo-project/", import.meta.url);

function readProjectFile(relativePath) {
  return readFileSync(new URL(relativePath, projectUrl), "utf8");
}

const manifest = loadManifest(JSON.parse(readProjectFile("shadowgraph.json")));
const rawOrders = manifest.sources["raw.orders"];
const seedRows = parseSeedCsv(
  readProjectFile(rawOrders.seed),
  rawOrders.columns,
);
const seeds = {
  [rawOrders.table]: { columns: rawOrders.columns, rows: seedRows },
};
/**
 * The demo branches rewrite stg_orders.sql on purpose, so this scenario pins the
 * mainline text of that one model instead of reading the working tree. Reading
 * the working tree would silently assert a different scenario depending on which
 * branch is checked out, which is how this first failed in CI. Every other model
 * comes from disk, because nothing in the demo modifies them.
 */
const BASELINE_STG_ORDERS = `-- Normalizes raw orders and derives the discount rate every downstream
-- model depends on.
--
-- raw.orders.discount_percentage is a WHOLE PERCENTAGE (25 means 25%), so it
-- must be divided by 100 to become a rate usable in arithmetic.

select
    order_id,
    customer_id,
    order_date,
    customer_segment,
    gross_amount,
    discount_percentage,
    coalesce(discount_percentage, 0) / 100.0 as discount_rate,
    gross_amount * (1 - coalesce(discount_percentage, 0) / 100.0) as net_revenue
from {{ source('raw', 'orders') }}
`;

const committedModels = Object.fromEntries(
  manifest.models.map((model) => [
    model.name,
    model.name === "stg_orders"
      ? BASELINE_STG_ORDERS
      : readProjectFile(model.path),
  ]),
);


/**
 * Replaces text that must exist exactly `expected` times in the committed
 * model, so editing a demo model without updating this test fails loudly
 * instead of silently producing a different scenario.
 */
function replaceExactly(text, search, replacement, expected = 1) {
  const segments = text.split(search);
  assert.equal(
    segments.length - 1,
    expected,
    `expected ${expected} occurrence(s) of ${JSON.stringify(search)}`,
  );
  return segments.join(replacement);
}

const DISCOUNT_RATE_EXPRESSION =
  "coalesce(discount_percentage, 0) / 100.0 as discount_rate";
const NET_REVENUE_EXPRESSION =
  "gross_amount * (1 - coalesce(discount_percentage, 0) / 100.0) as net_revenue";
const SEED_SOURCE_REFERENCE = "from {{ source('raw', 'orders') }}";
const RATE_CTE = `with rated_orders as (
    select
        *,
        coalesce(discount_percentage, 0) / 100.0 as rate
    ${SEED_SOURCE_REFERENCE}
)
select
`;

// The pinned baseline carries the whole-percentage contract that makes the
// dangerous scenario dangerous. If it ever stops matching the expressions the
// derivations below rewrite, this is no longer the scenario the demo describes.
test("the pinned staging baseline encodes the whole-percentage contract", () => {
  assert.equal(
    BASELINE_STG_ORDERS.split(" / 100.0").length - 1,
    2,
    "the baseline must convert whole percentages in both derived columns",
  );
  assert.ok(BASELINE_STG_ORDERS.includes(DISCOUNT_RATE_EXPRESSION));
  assert.ok(BASELINE_STG_ORDERS.includes(NET_REVENUE_EXPRESSION));
});

// Drops the percent-to-rate scaling from both derived columns. The projected
// column list is untouched, so the output schema cannot reveal the change.
const dangerousModels = {
  ...committedModels,
  stg_orders: replaceExactly(committedModels.stg_orders, " / 100.0", "", 2),
};

// Computes the rate once in a CTE and subtracts the discount instead of
// multiplying by its complement: different SQL, identical results.
const safeModels = {
  ...committedModels,
  stg_orders: replaceExactly(
    replaceExactly(
      replaceExactly(
        replaceExactly(
          committedModels.stg_orders,
          DISCOUNT_RATE_EXPRESSION,
          "rate as discount_rate",
        ),
        NET_REVENUE_EXPRESSION,
        "gross_amount - (gross_amount * rate) as net_revenue",
      ),
      SEED_SOURCE_REFERENCE,
      "from rated_orders",
    ),
    "select\n",
    RATE_CTE,
  ),
};

const syntheticManifest = loadManifest({
  version: "1",
  sources: { "raw.orders": { table: "raw_orders" } },
  models: [
    { name: "leaf", path: "models/leaf.sql" },
    { name: "middle", path: "models/middle.sql" },
    { name: "top", path: "models/top.sql" },
  ],
});

function isDemoProjectError(error) {
  return (
    error instanceof DemoProjectError &&
    error.name === "DemoProjectError" &&
    error.code === "INVALID_DEMO_PROJECT"
  );
}

function replayModel(modelName, after) {
  return replayCounterfactual(
    buildReplayPlan({
      manifest,
      modelName,
      before: committedModels,
      after,
      seeds,
    }),
  );
}

test("loadManifest indexes the committed demo manifest by model name and path", () => {
  assert.equal(manifest.version, "1");
  assert.equal(manifest.project, "acme_analytics");
  assert.deepEqual(
    [...manifest.byName.keys()],
    ["stg_orders", "fct_order_revenue", "order_discount_features"],
  );
  assert.deepEqual(
    [...manifest.byPath.keys()],
    [
      "models/staging/stg_orders.sql",
      "models/marts/fct_order_revenue.sql",
      "models/features/order_discount_features.sql",
    ],
  );
  assert.equal(
    manifest.byName.get("fct_order_revenue"),
    manifest.byPath.get("models/marts/fct_order_revenue.sql"),
  );
  assert.equal(
    manifest.byName.get("stg_orders").dataset,
    "acme_analytics.staging.stg_orders",
  );
});

test("loadManifest rejects manifests it cannot safely compile", () => {
  const valid = {
    version: "1",
    sources: { "raw.orders": { table: "raw_orders" } },
    models: [{ name: "leaf", path: "models/leaf.sql" }],
  };

  assert.throws(() => loadManifest(null), isDemoProjectError);
  assert.throws(() => loadManifest("shadowgraph.json"), isDemoProjectError);
  assert.throws(
    () => loadManifest({ ...valid, version: "2" }),
    /Unsupported manifest version/,
  );
  assert.throws(
    () => loadManifest({ ...valid, models: [] }),
    /Manifest must declare models/,
  );
  assert.throws(
    () => loadManifest({ version: "1", sources: valid.sources }),
    /Manifest must declare models/,
  );
  assert.throws(
    () => loadManifest({ version: "1", models: valid.models }),
    /Manifest must declare sources/,
  );
  assert.throws(
    () =>
      loadManifest({
        ...valid,
        models: [...valid.models, { name: "leaf", path: "models/other.sql" }],
      }),
    /Duplicate model: leaf/,
  );
  for (const invalid of [
    null,
    "shadowgraph.json",
    { ...valid, version: "2" },
    { ...valid, models: [] },
    { version: "1", models: valid.models },
    {
      ...valid,
      models: [...valid.models, { name: "leaf", path: "models/other.sql" }],
    },
  ]) {
    assert.throws(() => loadManifest(invalid), isDemoProjectError);
  }
});

test("compileModel flattens transitive refs into one topologically ordered query", () => {
  const compiled = compileModel(syntheticManifest, "top", {
    leaf: `select order_id, discount_percentage ${SEED_SOURCE_REFERENCE}`,
    middle:
      "select order_id, discount_percentage / 100.0 as rate from {{ ref('leaf') }}",
    top: "select order_id, rate from {{ ref('middle') }} where rate > 0",
  });

  assert.ok(compiled.startsWith("WITH leaf AS ("));
  assert.ok(!compiled.includes("{{"));
  assert.ok(!compiled.includes("{%"));
  assert.ok(compiled.includes("from raw_orders"));
  assert.ok(compiled.indexOf("leaf AS (") < compiled.indexOf("from leaf"));
  assert.ok(compiled.indexOf("middle AS (") < compiled.indexOf("from middle"));
  assert.ok(compiled.indexOf("leaf AS (") < compiled.indexOf("middle AS ("));
  assert.equal(compiled.match(/\bleaf AS \(/g).length, 1);
  assert.equal(compiled.match(/\bmiddle AS \(/g).length, 1);

  const committed = compileModel(
    manifest,
    "fct_order_revenue",
    committedModels,
  );
  assert.ok(committed.startsWith("WITH stg_orders AS ("));
  assert.ok(committed.includes("from raw_orders"));
  assert.ok(!committed.includes("source("));
  assert.ok(!committed.includes("ref("));
  assert.ok(
    committed.indexOf("stg_orders AS (") < committed.indexOf("from stg_orders"),
  );
});

test("compileModel returns a plain SELECT when a model has no dependencies", () => {
  const compiled = compileModel(manifest, "stg_orders", committedModels);

  assert.ok(!compiled.includes("WITH "));
  assert.ok(compiled.trimStart().startsWith("--"));
  assert.ok(compiled.trimEnd().endsWith("from raw_orders"));
  assert.equal(
    compileModel(syntheticManifest, "leaf", {
      leaf: `select 1 as x ${SEED_SOURCE_REFERENCE};\n`,
    }),
    "select 1 as x from raw_orders",
  );
});

test("compileModel rejects a dependency cycle instead of looping or truncating", () => {
  assert.throws(
    () =>
      compileModel(syntheticManifest, "leaf", {
        leaf: "select * from {{ ref('middle') }}",
        middle: "select * from {{ ref('leaf') }}",
      }),
    (error) =>
      isDemoProjectError(error) && /Model dependency cycle/.test(error.message),
  );
  assert.throws(
    () =>
      compileModel(syntheticManifest, "leaf", {
        leaf: "select * from {{ ref('leaf') }}",
      }),
    /Model dependency cycle at leaf/,
  );
});

test("compileModel rejects unknown refs, unknown sources, and unsupported jinja", () => {
  assert.throws(
    () =>
      compileModel(syntheticManifest, "leaf", {
        leaf: "select * from {{ ref('ghost') }}",
        ghost: "select 1 as x",
      }),
    (error) =>
      isDemoProjectError(error) &&
      /Model references unknown ref: ghost/.test(error.message),
  );
  assert.throws(
    () =>
      compileModel(syntheticManifest, "leaf", {
        leaf: "select 1 as x from {{ source('raw', 'ghost') }}",
      }),
    /Manifest does not declare source raw.ghost/,
  );
  assert.throws(
    () => compileModel(syntheticManifest, "unlisted", { unlisted: "select 1" }),
    /Unknown model: unlisted/,
  );
  assert.throws(
    () => compileModel(syntheticManifest, "leaf", { leaf: "   " }),
    /Missing SQL for model leaf/,
  );
  for (const jinja of [
    "{{ config(materialized='table') }}\nselect 1 as x",
    "select 1 as x {% if target.name == 'prod' %} where false {% endif %}",
    "select {{ var('column') }} as x",
  ]) {
    assert.throws(
      () => compileModel(syntheticManifest, "leaf", { leaf: jinja }),
      (error) =>
        isDemoProjectError(error) &&
        /supports only ref\(\) and source\(\) templates/.test(error.message),
    );
  }
});

test("parseSeedCsv types the committed seed rows and preserves empty cells as null", () => {
  assert.equal(seedRows.length, 20);
  assert.deepEqual(seedRows[0], {
    order_id: 1001n,
    customer_id: "C-100",
    order_date: "2026-01-04",
    customer_segment: "enterprise",
    gross_amount: 1200,
    discount_percentage: 25,
  });
  assert.equal(typeof seedRows[0].order_id, "bigint");
  assert.equal(seedRows.at(-1).order_id, 1020n);
  assert.ok(seedRows.every((row) => typeof row.order_id === "bigint"));
  assert.ok(
    seedRows.every(
      (row) =>
        typeof row.gross_amount === "number" &&
        Number.isFinite(row.gross_amount),
    ),
  );
  assert.ok(seedRows.every((row) => typeof row.customer_id === "string"));
  assert.equal(seedRows[1].gross_amount, 80.5);
  assert.equal(seedRows[1].customer_segment, "consumer");

  const missingDiscounts = seedRows
    .filter((row) => row.discount_percentage === null)
    .map((row) => row.order_id);
  assert.deepEqual(missingDiscounts, [1004n, 1014n]);
  assert.ok(
    seedRows
      .filter((row) => row.discount_percentage !== null)
      .every((row) => Number.isFinite(row.discount_percentage)),
  );
  assert.equal(seedRows[7].discount_percentage, 0);
});

test("parseSeedCsv rejects seeds it cannot parse unambiguously", () => {
  const columns = { id: "BIGINT", label: "VARCHAR", amount: "DOUBLE" };

  assert.throws(
    () => parseSeedCsv("id,label,rogue\n1,a,2\n", columns),
    /Seed column rogue is not declared in the manifest/,
  );
  assert.throws(
    () => parseSeedCsv("id,label,amount\n1,a\n", columns),
    /Seed row 1 has 2 fields, expected 3/,
  );
  assert.throws(
    () => parseSeedCsv('id,label,amount\n1,"a,b",2\n', columns),
    /Seed CSV must not contain quoted fields/,
  );
  assert.throws(
    () => parseSeedCsv("id,label,amount\n1,a,not-a-number\n", columns),
    /Seed row 1 column amount is not numeric/,
  );
  assert.throws(
    () => parseSeedCsv("id,label,amount\n", columns),
    /Seed CSV must contain a header and at least one row/,
  );
  for (const invalid of [
    "id,label,rogue\n1,a,2\n",
    "id,label,amount\n1,a\n",
    'id,label,amount\n1,"a,b",2\n',
    "id,label,amount\n1,a,not-a-number\n",
    "id,label,amount\n",
  ]) {
    assert.throws(() => parseSeedCsv(invalid, columns), isDemoProjectError);
  }
});

test("parseSeedCsv rejects a non-numeric integer cell as an invalid demo project", () => {
  for (const invalid of ["not-a-number", "1.5", "1e3", "0x10"]) {
    assert.throws(
      () =>
        parseSeedCsv(`id,label\n${invalid},a\n`, {
          id: "BIGINT",
          label: "VARCHAR",
        }),
      isDemoProjectError,
      `integer cell ${invalid} should be rejected`,
    );
  }
});

test("buildReplayPlan derives a replay plan from the manifest that DuckDB can execute", async () => {
  const plan = buildReplayPlan({
    manifest,
    modelName: "order_discount_features",
    before: committedModels,
    after: safeModels,
    seeds,
  });

  assert.equal(plan.model, "order_discount_features");
  assert.equal(plan.dataset, "acme_analytics.features.order_discount_features");
  assert.equal(
    plan.urn,
    "urn:li:dataset:(urn:li:dataPlatform:dbt,acme_analytics.features.order_discount_features,PROD)",
  );
  assert.deepEqual(plan.tables, [
    { name: "raw_orders", columns: rawOrders.columns, rows: seedRows },
  ]);
  assert.equal(
    plan.beforeSql,
    compileModel(manifest, "order_discount_features", committedModels),
  );
  assert.equal(
    plan.afterSql,
    compileModel(manifest, "order_discount_features", safeModels),
  );
  assert.deepEqual(
    plan.snapshot.metrics,
    manifest.byName.get("order_discount_features").replay.metrics,
  );
  assert.deepEqual(
    plan.snapshot.distributions,
    manifest.byName.get("order_discount_features").replay.distributions,
  );

  const replay = await replayCounterfactual(plan);
  assert.equal(replay.execution.engine, "duckdb");
  assert.equal(replay.execution.sourceTables, 1);
  assert.equal(replay.execution.sourceRows, 20);
  assert.equal(replay.before.rowCount, 20);

  assert.throws(
    () =>
      buildReplayPlan({
        manifest,
        modelName: "stg_orders",
        before: committedModels,
        after: committedModels,
        seeds: {},
      }),
    /Replay requires at least one seeded source table/,
  );
});

test("dropping the percent scaling keeps the schema identical but breaches downstream metrics", async () => {
  const staging = await replayModel("stg_orders", dangerousModels);
  assert.deepEqual(staging.before.schema, staging.after.schema);
  assert.equal(staging.before.rowCount, staging.after.rowCount);
  assert.equal(staging.comparison.passed, false);

  const fact = await replayModel("fct_order_revenue", dangerousModels);
  assert.deepEqual(fact.before.schema, fact.after.schema);
  assert.equal(fact.before.rowCount, 2);
  assert.equal(fact.after.rowCount, 2);
  assert.equal(fact.before.metrics.total_net_revenue, 17311.4075);
  assert.equal(fact.after.metrics.total_net_revenue, -445403.95);
  assert.equal(fact.before.metrics.total_gross_revenue, 21985.3);
  assert.equal(fact.after.metrics.total_gross_revenue, 21985.3);
  assert.equal(fact.comparison.passed, false);
  assert.ok(
    fact.comparison.breached.some(
      (difference) =>
        difference.category === "metric" &&
        difference.metric === "total_net_revenue" &&
        difference.magnitude < -100,
    ),
  );
  assert.deepEqual(
    fact.comparison.differences.filter(
      (difference) => difference.category === "schema",
    ),
    [],
  );

  const features = await replayModel(
    "order_discount_features",
    dangerousModels,
  );
  assert.deepEqual(features.before.schema, features.after.schema);
  assert.equal(features.before.metrics.average_discount_ratio, 0.149);
  assert.equal(features.after.metrics.average_discount_ratio, 14.9);
  assert.equal(features.before.distributions.max_discount_ratio, 0.35);
  assert.equal(features.after.distributions.max_discount_ratio, 35);
  assert.equal(features.comparison.passed, false);
  assert.ok(
    features.comparison.breached.some(
      (difference) =>
        difference.category === "distribution" &&
        difference.metric === "max_discount_ratio",
    ),
  );
});

test("an equivalent CTE refactor of the staging model breaches nothing downstream", async () => {
  assert.notEqual(safeModels.stg_orders, committedModels.stg_orders);
  assert.ok(safeModels.stg_orders.includes("with rated_orders as ("));

  for (const modelName of [
    "stg_orders",
    "fct_order_revenue",
    "order_discount_features",
  ]) {
    const replay = await replayModel(modelName, safeModels);
    assert.deepEqual(
      replay.comparison.breached,
      [],
      `${modelName} reported a false positive`,
    );
    assert.deepEqual(replay.comparison.differences, []);
    assert.equal(replay.comparison.equivalent, true);
    assert.equal(replay.comparison.passed, true);
    assert.deepEqual(replay.before, replay.after);
  }
});
