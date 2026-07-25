import assert from "node:assert/strict";
import test from "node:test";

import {
  affectedOwnerNames,
  buildGitHubCheckRun,
  GitHubCheckPublisher,
} from "../src/github/checks.js";
import {
  buildDataHubEvidencePlan,
  DataHubEvidenceClient,
  DataHubMcpDocumentTransport,
} from "../src/datahub/evidence.js";

const headSha = "b".repeat(40);
const analysis = {
  repository: "acme/shadowgraph",
  pullRequest: 42,
  baseSha: "a".repeat(40),
  headSha,
  analysisId: `acme/shadowgraph#42@${headSha}`,
};

const dangerous = {
  conclusion: "failure",
  mergeable: false,
  severity: "critical",
  affectedAssetCount: 2,
  reasons: ["Revenue changed by -24.75%", "Tier-1 dashboard consumes discount_percentage"],
  summary: "Merge blocked: critical data change risk",
};

test("builds commit-scoped dangerous and safe GitHub Check conclusions", () => {
  const consumers = [
    {
      affected: true,
      owners: [{ name: "Finance Analytics" }, { name: "Data Platform" }],
    },
    { affected: true, owners: [{ name: "Finance Analytics" }] },
    { affected: false, owners: [{ name: "Unrelated Team" }] },
  ];
  const blocked = buildGitHubCheckRun({ analysis, decision: dangerous, consumers });
  assert.equal(blocked.head_sha, headSha);
  assert.equal(blocked.external_id, analysis.analysisId);
  assert.equal(blocked.conclusion, "failure");
  assert.match(blocked.output.title, /blocked/i);
  assert.match(blocked.output.text, /Route to: Data Platform, Finance Analytics/);
  assert.doesNotMatch(blocked.output.text, /Unrelated Team/);

  const safe = buildGitHubCheckRun({
    analysis,
    decision: {
      conclusion: "success",
      mergeable: true,
      severity: "none",
      affectedAssetCount: 0,
      reasons: ["No breaking downstream impact detected"],
      summary: "Shadow analysis passed",
    },
  });
  assert.equal(safe.conclusion, "success");
  assert.match(safe.output.title, /safe to merge/i);

  const inconclusiveDecision = {
    conclusion: "neutral",
    mergeable: false,
    severity: "unknown",
    affectedAssetCount: 0,
    reasons: ["Dataset identity is ambiguous"],
    summary: "Shadow analysis inconclusive: required evidence is missing",
  };
  const inconclusive = buildGitHubCheckRun({
    analysis,
    decision: inconclusiveDecision,
  });
  assert.equal(inconclusive.conclusion, "neutral");
  assert.match(inconclusive.output.title, /inconclusive/i);
  assert.match(
    buildDataHubEvidencePlan({ analysis, decision: inconclusiveDecision })
      .document.contents.text,
    /ShadowGraph decision: INCONCLUSIVE/,
  );
});

test("rejects stale analysis identity and contradictory decisions", () => {
  assert.throws(
    () =>
      buildGitHubCheckRun({
        analysis: { ...analysis, analysisId: `acme/shadowgraph#42@${"c".repeat(40)}` },
        decision: dangerous,
      }),
    /not scoped to the head commit/,
  );
  assert.throws(
    () =>
      buildGitHubCheckRun({
        analysis,
        decision: { ...dangerous, conclusion: "success" },
      }),
    /disagree/,
  );
});

test("routes only de-duplicated owners of affected assets", () => {
  assert.deepEqual(
    affectedOwnerNames([
      { affected: true, owners: ["Finance", { displayName: "finance" }, { login: "data-team" }] },
      { affected: false, owners: ["ML"] },
    ]),
    ["data-team", "Finance"],
  );
});

test("GitHub publisher is dry-run by default and publishes only when requested", async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(url, "https://api.github.test/repos/acme/shadowgraph/check-runs");
    assert.match(init.headers.Authorization, /^Bearer /);
    return {
      ok: true,
      async json() {
        return { id: 123, html_url: "https://github.test/checks/123" };
      },
    };
  };
  const checkRun = buildGitHubCheckRun({ analysis, decision: dangerous });
  const publisher = new GitHubCheckPublisher({
    token: "test-token",
    fetchImpl,
    apiUrl: "https://api.github.test/",
  });

  const preview = await publisher.publish({ repository: analysis.repository, checkRun });
  assert.equal(preview.dryRun, true);
  assert.equal(calls, 0);

  const published = await publisher.publish({
    repository: analysis.repository,
    checkRun,
    dryRun: false,
  });
  assert.equal(calls, 1);
  assert.deepEqual(published, {
    dryRun: false,
    id: 123,
    url: "https://github.test/checks/123",
    headSha,
    conclusion: "failure",
  });
});

test("generates deterministic DataHub evidence upsert requests", () => {
  const input = {
    analysis,
    decision: dangerous,
    relatedAssets: [
      "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.orders,PROD)",
      "urn:li:dashboard:finance",
      "urn:li:dashboard:finance",
    ],
    checkUrl: "https://github.test/checks/123",
  };
  const first = buildDataHubEvidencePlan(input);
  const second = buildDataHubEvidencePlan(input);

  assert.deepEqual(first, second);
  assert.equal(first.operation, "upsert_document");
  assert.match(first.targetUrn, /^urn:li:document:shadowgraph_[0-9a-f]{64}$/);
  assert.match(first.idempotencyKey, new RegExp(`${headSha}$`));
  assert.deepEqual(first.document.relatedAssets, [
    "urn:li:dashboard:finance",
    "urn:li:dataset:(urn:li:dataPlatform:dbt,analytics.orders,PROD)",
  ]);
  assert.match(first.document.contents.text, /ShadowGraph decision: BLOCKED/);
  assert.match(first.document.contents.text, /<!-- shadowgraph:acme\/shadowgraph#42@/);
  assert.throws(
    () => buildDataHubEvidencePlan({ ...input, relatedAssets: ["not-a-urn"] }),
    /Invalid DataHub URN/,
  );
});

test("maps approved evidence to the official MCP save_document contract", async () => {
  const plan = buildDataHubEvidencePlan({
    analysis,
    decision: dangerous,
    relatedAssets: ["urn:li:dashboard:finance"],
  });
  let received;
  const transport = new DataHubMcpDocumentTransport({
    client: {
      async callTool(name, args) {
        received = { name, args };
        return { isError: false, content: [{ type: "text", text: "saved" }] };
      },
    },
  });
  const result = await transport.upsertDocument(plan);

  assert.equal(received.name, "save_document");
  assert.equal(received.args.document_type, "Decision");
  assert.equal(received.args.urn, plan.targetUrn);
  assert.deepEqual(received.args.related_assets, ["urn:li:dashboard:finance"]);
  assert.equal(result.urn, plan.targetUrn);
});

test("DataHub evidence writeback requires both non-dry-run and approval", async () => {
  const plan = buildDataHubEvidencePlan({
    analysis,
    decision: dangerous,
    relatedAssets: ["urn:li:dashboard:finance"],
  });
  let calls = 0;
  const client = new DataHubEvidenceClient({
    transport: {
      async upsertDocument(received) {
        calls += 1;
        assert.equal(received.idempotencyKey, plan.idempotencyKey);
        return { action: "updated", urn: "urn:li:document:shadowgraph-evidence" };
      },
    },
  });

  const preview = await client.write(plan);
  assert.equal(preview.dryRun, true);
  assert.equal(calls, 0);
  await assert.rejects(
    () => client.write(plan, { dryRun: false }),
    /Explicit approval is required/,
  );
  assert.equal(calls, 0);

  const written = await client.write(plan, { dryRun: false, approved: true });
  assert.equal(calls, 1);
  assert.equal(written.action, "updated");
  assert.equal(written.dryRun, false);
});
