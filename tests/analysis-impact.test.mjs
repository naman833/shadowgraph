import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyConsumers,
  compareSnapshots,
  decideMerge,
} from "../src/analysis/index.js";

const change = {
  kind: "column_expression_changed",
  dataset: "analytics.orders",
  column: "discount_percentage",
};

test("classifies true consumers without substring or string-literal false positives", () => {
  const consumers = classifyConsumers(
    [
      {
        urn: "urn:dashboard:finance",
        type: "dashboard",
        sql: "select sum(discount_percentage) from analytics.orders",
      },
      {
        urn: "urn:dataset:unrelated",
        type: "dataset",
        sql: "select note from audit where note = 'discount_percentage'",
      },
      {
        urn: "urn:dataset:column-lineage",
        type: "dataset",
        columnLineage: [
          {
            upstreamDataset: "analytics.orders",
            upstreamColumn: "discount_percentage",
          },
        ],
      },
    ],
    [change],
  );

  assert.equal(consumers[0].classification, "true_consumer");
  assert.equal(consumers[0].matchedChanges[0].evidence, "sql_reference");
  assert.equal(consumers[1].classification, "lineage_only");
  assert.equal(consumers[2].matchedChanges[0].evidence, "column_lineage");
});

test("counterfactual comparison reports breached behavioral checks", () => {
  const comparison = compareSnapshots(
    {
      schema: { order_id: "BIGINT", net_revenue: "DECIMAL" },
      rowCount: 1000,
      nullRates: { net_revenue: 0.2 },
      metrics: { revenue: 100000 },
      distributions: { fraud_score: 0.1 },
    },
    {
      schema: { order_id: "BIGINT", net_revenue: "DOUBLE" },
      rowCount: 820,
      nullRates: { net_revenue: 3.5 },
      metrics: { revenue: 75250 },
      distributions: { fraud_score: 0.18 },
    },
  );

  assert.equal(comparison.passed, false);
  assert.ok(
    comparison.breached.some(
      (difference) =>
        difference.category === "metric" &&
        difference.metric === "revenue" &&
        Math.round(difference.magnitude) === -25,
    ),
  );
  assert.ok(
    comparison.breached.some(
      (difference) =>
        difference.category === "schema" &&
        difference.change === "type_changed",
    ),
  );
});

test("blocks a critical downstream change and passes a false-positive-free edit", () => {
  const blocked = decideMerge({
    consumers: [
      {
        affected: true,
        type: "dashboard",
        tier: "tier_1",
      },
    ],
    comparison: {
      breached: [
        {
          category: "metric",
          metric: "revenue",
          magnitude: -24.75,
          breached: true,
        },
      ],
    },
  });
  assert.equal(blocked.conclusion, "failure");
  assert.equal(blocked.severity, "critical");

  const passed = decideMerge({
    consumers: [{ affected: false, type: "dashboard" }],
    comparison: { breached: [] },
  });
  assert.equal(passed.conclusion, "success");
  assert.equal(passed.severity, "none");
});

