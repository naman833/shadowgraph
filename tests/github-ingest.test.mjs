import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzePullRequest,
  MAX_PULL_REQUEST_FILES,
  normalizePullRequestInput,
} from "../src/github/ingest.js";

const baseInput = {
  repository: "acme/shadowgraph",
  pullRequest: 42,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

test("ingests immutable GitHub PR snapshots and detects semantic SQL changes", () => {
  const result = analyzePullRequest({
    ...baseInput,
    files: [
      {
        path: "models/orders.sql",
        status: "modified",
        before: `
          select order_id, discount_percentage / 100 as discount_rate
          from raw.orders
        `,
        after: `
          select order_id, discount_percentage as discount_rate
          from raw.orders
        `,
      },
      {
        path: "README.md",
        status: "modified",
        before: "old",
        after: "new",
      },
    ],
  });

  assert.equal(
    result.analysisId,
    `acme/shadowgraph#42@${"b".repeat(40)}`,
  );
  assert.deepEqual(result.files, { received: 2, analyzed: 1, ignored: 1 });
  assert.ok(
    result.changes.some(
      (change) =>
        change.kind === "column_expression_changed" &&
        change.dataset === "orders" &&
        change.column === "discount_rate" &&
        change.filePath === "models/orders.sql",
    ),
  );
});

test("produces no findings for formatting-only SQL and non-data files", () => {
  const result = analyzePullRequest({
    ...baseInput,
    files: [
      {
        path: "models/orders.sql",
        status: "modified",
        before: "select order_id from raw.orders",
        after: " SELECT  order_id\nFROM raw.orders ",
      },
      {
        path: "docs/notes.md",
        status: "added",
        before: "",
        after: "discount_percentage",
      },
    ],
  });

  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.files, { received: 2, analyzed: 1, ignored: 1 });
});

test("rejects mutable, unsafe, duplicated, or oversized PR input", () => {
  assert.throws(
    () =>
      normalizePullRequestInput({
        ...baseInput,
        headSha: "not-a-sha",
        files: [],
      }),
    /Head SHA must be a full Git object ID/,
  );
  assert.throws(
    () =>
      normalizePullRequestInput({
        ...baseInput,
        files: [
          {
            path: "../secrets.sql",
            status: "added",
            before: "",
            after: "select 1",
          },
        ],
      }),
    /cannot traverse directories/,
  );
  assert.throws(
    () =>
      normalizePullRequestInput({
        ...baseInput,
        files: Array.from({ length: MAX_PULL_REQUEST_FILES + 1 }, (_, index) => ({
          path: `models/model_${index}.sql`,
          status: "added",
          before: "",
          after: "select 1",
        })),
      }),
    /100-file safety limit/,
  );
  assert.throws(
    () =>
      normalizePullRequestInput({
        ...baseInput,
        files: [
          {
            path: "models/oversized.sql",
            status: "added",
            before: "",
            after: "x".repeat(1_000_001),
          },
        ],
      }),
    /per-file safety limit/,
  );
  assert.throws(
    () =>
      normalizePullRequestInput({
        ...baseInput,
        files: [
          {
            path: "models/orders.sql",
            status: "added",
            before: "",
            after: "select 1",
          },
          {
            path: "models/orders.sql",
            status: "modified",
            before: "select 1",
            after: "select 2",
          },
        ],
      }),
    /Duplicate file path/,
  );
});
