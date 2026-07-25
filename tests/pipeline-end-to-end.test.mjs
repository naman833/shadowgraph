import assert from "node:assert/strict";
import test from "node:test";

import { runShadowAnalysis } from "../src/pipeline/index.js";
import {
  dangerousSemanticReplay,
  safeRefactorReplay,
} from "./fixtures/golden-replay.mjs";

const baseSha = "1".repeat(40);
const headSha = "2".repeat(40);
const beforeSql = `
  -- shadowgraph:dataset=analytics.order_details
  select gross_amount * (1 - discount_percentage / 100.0) as net_revenue
  from raw.orders
`;
const dangerousSql = `
  -- shadowgraph:dataset=analytics.order_details
  select gross_amount * (1 - discount_percentage) as net_revenue
  from raw.orders
`;
const safeSql = `
  -- shadowgraph:dataset=analytics.order_details
  select gross_amount - (gross_amount * (discount_percentage / 100.0)) as net_revenue
  from raw.orders
`;

function pullRequest(after) {
  return {
    repository: "acme/shadowgraph",
    pullRequest: 42,
    baseSha,
    headSha,
    files: [
      {
        path: "models/order_details.sql",
        status: "modified",
        before: beforeSql,
        after,
      },
    ],
  };
}

function contextFor(changes) {
  return {
    source: "deterministic",
    warnings: [],
    changes: changes.map((change) => ({
      change,
      identity: {
        hint: change.dataset,
        entity: {
          urn: "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.order_details,PROD)",
          name: "order_details",
          type: "DATASET",
        },
        matchedColumns: ["net_revenue"],
        missingColumns: [],
        ambiguous: false,
      },
      consumers: [
        {
          urn: "urn:li:dashboard:finance",
          name: "Executive revenue",
          type: "dashboard",
          tier: "tier_1",
          owners: [{ name: "Finance Analytics" }],
          columnLineage: [
            {
              upstreamDataset: "analytics.order_details",
              upstreamColumn: "net_revenue",
              downstreamColumn: "net_revenue",
            },
          ],
          inputColumns: [],
        },
      ],
    })),
  };
}

async function run(after, replayPlan) {
  const input = pullRequest(after);
  const detected = {
    kind: "column_expression_changed",
    dataset: "analytics.order_details",
    column: "net_revenue",
  };
  return runShadowAnalysis({
    pullRequestInput: input,
    dataHubContext: contextFor([detected]),
    replayPlan,
  });
}

test("end-to-end dangerous semantic change blocks with commit-scoped dry-run evidence", async () => {
  const result = await run(dangerousSql, dangerousSemanticReplay);

  assert.equal(result.analysis.changes[0].kind, "column_expression_changed");
  assert.equal(result.consumers[0].classification, "true_consumer");
  assert.equal(result.replay.comparison.passed, false);
  assert.equal(result.decision.conclusion, "failure");
  assert.equal(result.publications.githubCheck.head_sha, headSha);
  assert.equal(result.publications.githubCheck.conclusion, "failure");
  assert.match(
    result.publications.dataHubEvidence.document.contents.text,
    /ShadowGraph decision: BLOCKED/,
  );
  assert.equal(result.publications.dryRun, true);
});

test("end-to-end equivalent refactor passes without a lineage false positive", async () => {
  const result = await run(safeSql, safeRefactorReplay);

  assert.equal(result.consumers[0].affected, true);
  assert.equal(result.replay.comparison.passed, true);
  assert.equal(result.decision.conclusion, "success");
  assert.equal(result.decision.mergeable, true);
  assert.equal(result.publications.githubCheck.conclusion, "success");
});

test("ambiguous or missing context is neutral instead of a false pass", async () => {
  const input = pullRequest(dangerousSql);
  const result = await runShadowAnalysis({
    pullRequestInput: input,
    dataHubContext: {
      source: "live",
      warnings: [],
      changes: [
        {
          change: {
            kind: "column_expression_changed",
            dataset: "analytics.order_details",
            column: "net_revenue",
          },
          identity: {
            hint: "analytics.order_details",
            entity: null,
            matchedColumns: [],
            missingColumns: ["net_revenue"],
            ambiguous: true,
          },
          consumers: [],
        },
      ],
    },
  });

  assert.equal(result.decision.conclusion, "neutral");
  assert.equal(result.decision.mergeable, false);
  assert.equal(result.publications.githubCheck.conclusion, "neutral");
  assert.match(result.decision.reasons.join(" "), /not resolved|ambiguous/i);
});
