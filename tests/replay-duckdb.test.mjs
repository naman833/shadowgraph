import assert from "node:assert/strict";
import test from "node:test";

import {
  ReplayLimitError,
  replayCounterfactual,
} from "../src/replay/index.js";
import {
  dangerousSemanticReplay,
  safeRefactorReplay,
} from "./fixtures/replay-golden.mjs";

test("DuckDB replay catches the golden semantic change without a schema change", async () => {
  const replay = await replayCounterfactual(dangerousSemanticReplay);

  assert.deepEqual(replay.before.schema, replay.after.schema);
  assert.equal(replay.before.rowCount, 4);
  assert.equal(replay.after.rowCount, 4);
  assert.equal(replay.before.nullRates.net_revenue, 0);
  assert.equal(replay.after.nullRates.net_revenue, 0);
  assert.equal(replay.before.metrics.total_revenue, 357);
  assert.equal(replay.after.metrics.total_revenue, -6870);
  assert.equal(replay.comparison.passed, false);
  assert.ok(
    replay.comparison.breached.some(
      (difference) =>
        difference.category === "metric" &&
        difference.metric === "total_revenue" &&
        difference.magnitude < -100,
    ),
  );
  assert.ok(
    replay.comparison.breached.some(
      (difference) =>
        difference.category === "distribution" &&
        difference.metric === "median_revenue",
    ),
  );
  assert.equal(replay.execution.engine, "duckdb");
  assert.equal(replay.execution.sourceRows, 4);
});

test("DuckDB replay passes an equivalent safe refactor", async () => {
  const replay = await replayCounterfactual(safeRefactorReplay);

  assert.deepEqual(replay.before, replay.after);
  assert.equal(replay.comparison.equivalent, true);
  assert.equal(replay.comparison.passed, true);
  assert.deepEqual(replay.comparison.differences, []);
});

test("DuckDB replay captures schema, volume, null, metric, and distribution evidence", async () => {
  const replay = await replayCounterfactual({
    ...safeRefactorReplay,
    afterSql: `
      SELECT
        CAST(order_id AS VARCHAR) AS order_id,
        gross_amount,
        customer_segment,
        CASE WHEN order_id = 1001 THEN NULL ELSE gross_amount END AS net_revenue
      FROM orders
      WHERE order_id <> 1004
    `,
  });

  const categories = new Set(
    replay.comparison.differences.map((difference) => difference.category),
  );
  assert.deepEqual(
    categories,
    new Set(["schema", "volume", "null_rate", "metric", "distribution"]),
  );
});

test("DuckDB replay rejects oversized inputs and result explosions", async () => {
  await assert.rejects(
    replayCounterfactual({
      ...safeRefactorReplay,
      limits: { maxInputRows: 3 },
    }),
    (error) =>
      error instanceof ReplayLimitError &&
      error.message === "source rows exceed maxInputRows (3)",
  );

  await assert.rejects(
    replayCounterfactual({
      ...safeRefactorReplay,
      afterSql: "SELECT a.order_id FROM orders a CROSS JOIN orders b",
      snapshot: {},
      limits: { maxResultRows: 10 },
    }),
    (error) =>
      error instanceof ReplayLimitError &&
      error.message === "after_result exceeds maxResultRows (10)",
  );
});

test("DuckDB replay rejects mutating and multi-statement SQL", async () => {
  await assert.rejects(
    replayCounterfactual({
      ...safeRefactorReplay,
      afterSql: "DROP TABLE orders",
    }),
    /must be a read-only SELECT or WITH query/,
  );
  await assert.rejects(
    replayCounterfactual({
      ...safeRefactorReplay,
      afterSql: "SELECT * FROM orders; SELECT * FROM orders",
    }),
    /exactly one statement/,
  );
});
