import assert from "node:assert/strict";
import test from "node:test";

import {
  detectChanges,
  detectChangesFromUnifiedDiff,
} from "../src/analysis/index.js";

test("detects a dropped projected column and filter logic change", () => {
  const changes = detectChanges({
    filePath: "models/orders.sql",
    before: `
      select order_id, discount_percentage, revenue
      from {{ ref('raw_orders') }}
      where status = 'complete'
    `,
    after: `
      select order_id, revenue
      from {{ ref('raw_orders') }}
      where status in ('complete', 'refunded')
    `,
  });

  assert.ok(
    changes.some(
      (change) =>
        change.kind === "column_dropped" &&
        change.column === "discount_percentage",
    ),
  );
  assert.ok(changes.some((change) => change.kind === "filter_changed"));
  assert.ok(changes.every((change) => change.dataset === "orders"));
});

test("detects an explicit rename from a unified DDL diff", () => {
  const changes = detectChangesFromUnifiedDiff({
    filePath: "schemas/orders.sql",
    patch: `@@ -1 +1 @@
-ALTER TABLE analytics.orders RENAME COLUMN discount_pct TO discount_percentage;
+ALTER TABLE analytics.orders RENAME COLUMN discount_percentage TO discount_rate;
`,
  });

  assert.deepEqual(
    changes.find((change) => change.kind === "column_renamed"),
    {
      kind: "column_renamed",
      dataset: "analytics.orders",
      column: "discount_percentage",
      newColumn: "discount_rate",
      sources: [],
      confidence: 1,
    },
  );
});

test("ignores formatting-only SQL edits", () => {
  assert.deepEqual(
    detectChanges({
      filePath: "models/orders.sql",
      before: "select order_id from raw_orders",
      after: " SELECT   order_id\nFROM raw_orders ",
    }),
    [],
  );
});

