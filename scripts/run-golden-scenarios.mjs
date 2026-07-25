import {
  dangerousSemanticReplay,
  safeRefactorReplay,
} from "../examples/golden-replay.mjs";
import { runShadowAnalysis } from "../src/pipeline/index.js";

const baseSha = "1".repeat(40);
const scenarios = [
  {
    name: "dangerous semantic scale change",
    expected: "failure",
    after:
      "select gross_amount * (1 - discount_percentage) as net_revenue from raw.orders",
    replayPlan: dangerousSemanticReplay,
  },
  {
    name: "safe equivalent refactor",
    expected: "success",
    after:
      "select gross_amount - (gross_amount * discount_percentage / 100.0) as net_revenue from raw.orders",
    replayPlan: safeRefactorReplay,
  },
];

const before =
  "select gross_amount * (1 - discount_percentage / 100.0) as net_revenue from raw.orders";

for (const [index, scenario] of scenarios.entries()) {
  const headSha = String(index + 2).repeat(40);
  const pullRequestInput = {
    repository: "shadowgraph/demo",
    pullRequest: index + 1,
    baseSha,
    headSha,
    files: [
      {
        path: "models/order_details.sql",
        status: "modified",
        before: `-- shadowgraph:dataset=analytics.order_details\n${before}`,
        after: `-- shadowgraph:dataset=analytics.order_details\n${scenario.after}`,
      },
    ],
  };
  const change = {
    kind: "column_expression_changed",
    dataset: "analytics.order_details",
    column: "net_revenue",
  };
  const result = await runShadowAnalysis({
    pullRequestInput,
    dataHubContext: {
      source: "deterministic",
      warnings: [],
      changes: [
        {
          change,
          identity: {
            hint: change.dataset,
            entity: {
              urn: "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.order_details,PROD)",
              name: "order_details",
              type: "DATASET",
            },
            matchedColumns: [change.column],
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
              inputColumns: [],
              columnLineage: [
                {
                  upstreamDataset: change.dataset,
                  upstreamColumn: change.column,
                  downstreamColumn: change.column,
                },
              ],
            },
          ],
        },
      ],
    },
    replayPlan: scenario.replayPlan,
  });

  const summary = {
    scenario: scenario.name,
    expected: scenario.expected,
    conclusion: result.decision.conclusion,
    schemaEqual:
      JSON.stringify(result.replay.before.schema) ===
      JSON.stringify(result.replay.after.schema),
    beforeRevenue: result.replay.before.metrics.total_revenue,
    afterRevenue: result.replay.after.metrics.total_revenue,
    breachedChecks: result.replay.comparison.breached.length,
    githubCheck: result.publications.githubCheck.conclusion,
    publicationMode: "dry-run",
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (result.decision.conclusion !== scenario.expected) process.exitCode = 1;
}
