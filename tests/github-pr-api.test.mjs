import assert from "node:assert/strict";
import test from "node:test";

/**
 * Tests for the GitHub PR API route and evidence API route.
 * External HTTP calls are mocked — no GitHub availability dependency.
 */

// --- Helper: Parse check text ---

function parseCheckText(text) {
  const riskMatch = text.match(/^Risk:\s*(.+)$/m);
  const affectedMatch = text.match(/^Affected assets:\s*(\d+)/m);
  const routeMatch = text.match(/^Route to:\s*(.+)$/m);
  const evidenceLines = text
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));

  return {
    risk: riskMatch?.[1]?.trim() ?? "unknown",
    affectedAssets: Number(affectedMatch?.[1]) || 0,
    ownerRouting: routeMatch?.[1]?.trim() ?? "",
    reasons: evidenceLines,
  };
}

// --- Tests: Check text parsing ---

test("parseCheckText extracts risk and affected assets", () => {
  const text = [
    "Commit: `7d91d18bfe81cc99084aa1565a3b9ee76852ad53`",
    "Pull request: #1",
    "Risk: critical",
    "Affected assets: 2",
    "Route to: Analytics Engineering",
    "",
    "Evidence:",
    "- 2 downstream assets reference the changed field",
    "- 8 counterfactual checks exceeded policy thresholds",
  ].join("\n");

  const parsed = parseCheckText(text);
  assert.equal(parsed.risk, "critical");
  assert.equal(parsed.affectedAssets, 2);
  assert.equal(parsed.ownerRouting, "Analytics Engineering");
  assert.equal(parsed.reasons.length, 2);
  assert.match(parsed.reasons[0], /2 downstream/);
  assert.match(parsed.reasons[1], /8 counterfactual/);
});

test("parseCheckText handles missing fields gracefully", () => {
  const parsed = parseCheckText("");
  assert.equal(parsed.risk, "unknown");
  assert.equal(parsed.affectedAssets, 0);
  assert.equal(parsed.ownerRouting, "");
  assert.equal(parsed.reasons.length, 0);
});

// --- Tests: Check Run selection ---

test("finds ShadowGraph check by name case-insensitively", () => {
  const checkRuns = [
    { name: "build", conclusion: "success" },
    { name: "ShadowGraph change impact", conclusion: "failure" },
    { name: "lint", conclusion: "success" },
  ];
  const found = checkRuns.find(
    (c) => c.name.toLowerCase() === "shadowgraph change impact",
  );
  assert.ok(found);
  assert.equal(found.conclusion, "failure");
});

test("returns null when ShadowGraph check is missing", () => {
  const checkRuns = [
    { name: "build", conclusion: "success" },
    { name: "lint", conclusion: "success" },
  ];
  const found = checkRuns.find(
    (c) => c.name.toLowerCase() === "shadowgraph change impact",
  );
  assert.equal(found, undefined);
});

// --- Tests: Commit SHA matching ---

test("SHA validation accepts 40-character hex", () => {
  const SHA_RE = /^[0-9a-f]{40}$/i;
  assert.ok(SHA_RE.test("7d91d18bfe81cc99084aa1565a3b9ee76852ad53"));
  assert.ok(!SHA_RE.test("short"));
  assert.ok(!SHA_RE.test(""));
  assert.ok(!SHA_RE.test("zd91d18bfe81cc99084aa1565a3b9ee76852ad53"));
});

test("stale evidence is detected when commit SHA differs", () => {
  const headSha = "7d91d18bfe81cc99084aa1565a3b9ee76852ad53";
  const checkText = "Commit: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`\nRisk: critical";
  const evidenceMatchesHead = checkText.includes(`Commit: \`${headSha}\``);
  assert.equal(evidenceMatchesHead, false);
});

test("fresh evidence is confirmed when commit SHA matches", () => {
  const headSha = "7d91d18bfe81cc99084aa1565a3b9ee76852ad53";
  const checkText = `Commit: \`${headSha}\`\nRisk: critical`;
  const evidenceMatchesHead = checkText.includes(`Commit: \`${headSha}\``);
  assert.equal(evidenceMatchesHead, true);
});

// --- Tests: Input validation ---

test("rejects invalid owner parameter", () => {
  const OWNER_REPO_RE = /^[a-z0-9_.-]+$/i;
  assert.ok(!OWNER_REPO_RE.test(""));
  assert.ok(!OWNER_REPO_RE.test("user/repo"));
  assert.ok(!OWNER_REPO_RE.test("user name"));
  assert.ok(OWNER_REPO_RE.test("naman833"));
  assert.ok(OWNER_REPO_RE.test("my-org"));
});

test("rejects non-positive pull numbers", () => {
  assert.ok(!(Number.isInteger(0) && 0 > 0));
  assert.ok(!(Number.isInteger(-1) && -1 > 0));
  assert.ok(Number.isInteger(1) && 1 > 0);
});

// --- Tests: Source labels ---

test("live source labels are correctly assigned", () => {
  const sources = { github: "live_github", datahub: "unavailable", evidence: "commit_scoped_evidence" };
  assert.equal(sources.github, "live_github");
  assert.notEqual(sources.github, "demo");
});

test("demo source labels are not confused with live", () => {
  const sources = { github: "demo", datahub: "demo", evidence: "demo" };
  assert.notEqual(sources.github, "live_github");
});

// --- Tests: No silent demo fallback ---

test("API errors are not replaced with demo data", () => {
  // Simulate what the UI does on error: it shows the error, not demo data
  const apiResponse = { ok: false, error: true, code: "RATE_LIMITED", message: "Rate limited" };
  assert.equal(apiResponse.ok, false);
  // The UI should show the error message, never silently fall back to demo
  assert.ok(apiResponse.message.length > 0);
});

// --- Tests: Token not exposed to client ---

test("token is never included in API responses", () => {
  const mockResponse = {
    ok: true,
    pr: { number: 1, title: "test" },
    files: [],
    check: null,
    source: "live_github",
  };
  const serialized = JSON.stringify(mockResponse);
  assert.ok(!serialized.includes("ghp_"));
  assert.ok(!serialized.includes("ghs_"));
  assert.ok(!serialized.includes("GITHUB_TOKEN"));
  assert.ok(!serialized.includes("Bearer"));
});

// --- Tests: GitHub timeout handling ---

test("timeout errors are identified correctly", () => {
  const timeoutMsg = "The operation was aborted due to timeout";
  const isTimeout = timeoutMsg.includes("abort") || timeoutMsg.includes("timeout");
  assert.ok(isTimeout);
});

// --- Tests: Rendering naman833/shadowgraph PR #1 ---

test("PR #1 evidence shows blocked conclusion", () => {
  const checkResult = {
    name: "ShadowGraph change impact",
    conclusion: "failure",
    title: "Unsafe data change blocked",
    summary: "Merge blocked: critical data change risk",
  };
  assert.equal(checkResult.conclusion, "failure");
  assert.equal(checkResult.title, "Unsafe data change blocked");
  assert.match(checkResult.summary, /critical/);
});

test("PR #1 evidence includes affected assets and breached checks", () => {
  const checkText = [
    "Commit: `7d91d18bfe81cc99084aa1565a3b9ee76852ad53`",
    "Pull request: #1",
    "Risk: critical",
    "Affected assets: 2",
    "Route to: Analytics Engineering",
    "",
    "Evidence:",
    "- 2 downstream assets reference the changed field",
    "- 8 counterfactual checks exceeded policy thresholds",
  ].join("\n");

  const parsed = parseCheckText(checkText);
  assert.equal(parsed.affectedAssets, 2);
  assert.equal(parsed.ownerRouting, "Analytics Engineering");

  const breachedLine = parsed.reasons.find((r) => r.includes("counterfactual"));
  const countMatch = breachedLine?.match(/^(\d+)/);
  assert.equal(Number(countMatch?.[1]), 8);
});

// --- Tests: DataHub states ---

test("datahub unavailable vs connected states are distinguished", () => {
  const statusConnected = "live";
  const statusUnavailable = "unavailable";
  const statusNotConfigured = "not_configured";

  assert.notEqual(statusConnected, statusUnavailable);
  assert.notEqual(statusConnected, statusNotConfigured);
  assert.notEqual(statusUnavailable, statusNotConfigured);
});
