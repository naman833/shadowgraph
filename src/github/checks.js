const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const CHECK_CONCLUSIONS = new Set(["success", "failure", "neutral"]);
const MAX_TEXT_LENGTH = 65_535;

export class GitHubCheckError extends Error {
  constructor(message, code = "INVALID_CHECK_INPUT") {
    super(message);
    this.name = "GitHubCheckError";
    this.code = code;
  }
}

function assertInput(condition, message) {
  if (!condition) throw new GitHubCheckError(message);
}

function safeText(value, fallback = "Unknown") {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text.slice(0, 500) || fallback;
}

function ownerName(owner) {
  if (typeof owner === "string") return safeText(owner);
  if (!owner || typeof owner !== "object") return null;
  return safeText(owner.name ?? owner.displayName ?? owner.login ?? owner.urn, "");
}

/**
 * Returns stable, de-duplicated routing targets for assets proven affected by
 * the change. Lineage-only candidates are deliberately excluded.
 */
export function affectedOwnerNames(consumers = []) {
  const names = new Map();
  for (const consumer of consumers) {
    if (consumer?.affected !== true) continue;
    for (const owner of consumer.owners ?? []) {
      const name = ownerName(owner);
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
  }
  return [...names.values()].sort((left, right) => left.localeCompare(right));
}

function validateAnalysis(analysis) {
  assertInput(analysis && typeof analysis === "object", "Analysis is required");
  assertInput(REPOSITORY.test(analysis.repository ?? ""), "Repository must be owner/name");
  assertInput(Number.isInteger(analysis.pullRequest) && analysis.pullRequest > 0, "Invalid PR number");
  assertInput(SHA.test(analysis.headSha ?? ""), "Head SHA must be a full Git object ID");
  const expectedId = `${analysis.repository}#${analysis.pullRequest}@${analysis.headSha}`;
  assertInput(analysis.analysisId === expectedId, "Analysis ID is not scoped to the head commit");
}

/**
 * Generates a GitHub Check Run request pinned to the immutable PR head commit.
 */
export function buildGitHubCheckRun({ analysis, decision, consumers = [], detailsUrl }) {
  validateAnalysis(analysis);
  assertInput(decision && typeof decision === "object", "Decision is required");
  assertInput(
    CHECK_CONCLUSIONS.has(decision.conclusion),
    "Decision conclusion must be success, failure, or neutral",
  );
  assertInput(
    decision.conclusion === "success"
      ? decision.mergeable === true
      : decision.mergeable === false,
    "Decision conclusion and mergeable status disagree",
  );

  const owners = affectedOwnerNames(consumers);
  const isBlocked = decision.conclusion === "failure";
  const isInconclusive = decision.conclusion === "neutral";
  const reasons = (decision.reasons ?? []).map((reason) => safeText(reason)).slice(0, 20);
  const ownerLine = owners.length
    ? `Route to: ${owners.join(", ")}`
    : "Route to: no affected owner found in DataHub";
  const text = [
    `Commit: \`${analysis.headSha}\``,
    `Pull request: #${analysis.pullRequest}`,
    `Risk: ${safeText(decision.severity, "unknown")}`,
    `Affected assets: ${Number(decision.affectedAssetCount) || 0}`,
    ownerLine,
    "",
    "Evidence:",
    ...(reasons.length ? reasons : ["No breaking downstream impact detected"]).map(
      (reason) => `- ${reason}`,
    ),
  ]
    .join("\n")
    .slice(0, MAX_TEXT_LENGTH);

  const payload = {
    name: "ShadowGraph change impact",
    head_sha: analysis.headSha.toLowerCase(),
    status: "completed",
    conclusion: decision.conclusion,
    external_id: analysis.analysisId,
    output: {
      title: isBlocked
        ? "Unsafe data change blocked"
        : isInconclusive
          ? "Data change analysis is inconclusive"
          : "Data change is safe to merge",
      summary: safeText(
        decision.summary,
        isBlocked
          ? "Merge blocked"
          : isInconclusive
            ? "Required evidence is missing"
            : "Shadow analysis passed",
      ),
      text,
    },
  };

  if (detailsUrl) {
    assertInput(/^https?:\/\//i.test(detailsUrl), "Details URL must use HTTP or HTTPS");
    payload.details_url = detailsUrl;
  }
  return payload;
}

/**
 * Network boundary for publishing check runs. It never writes unless dryRun is
 * explicitly false; callers can therefore safely generate and inspect payloads.
 */
export class GitHubCheckPublisher {
  constructor({ token, fetchImpl = globalThis.fetch, apiUrl = "https://api.github.com" } = {}) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
  }

  async publish({ repository, checkRun, dryRun = true }) {
    assertInput(REPOSITORY.test(repository ?? ""), "Repository must be owner/name");
    assertInput(checkRun?.head_sha && SHA.test(checkRun.head_sha), "Check run must target a commit");
    const endpoint = `${this.apiUrl}/repos/${repository}/check-runs`;
    if (dryRun) return { dryRun: true, endpoint, request: checkRun };

    if (!this.token) throw new GitHubCheckError("GitHub token is required to publish", "AUTH");
    if (typeof this.fetchImpl !== "function") {
      throw new GitHubCheckError("Fetch implementation is required", "CONFIG");
    }
    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(checkRun),
    });
    if (!response.ok) {
      throw new GitHubCheckError(`GitHub Check API returned HTTP ${response.status}`, "HTTP");
    }
    const result = await response.json();
    return {
      dryRun: false,
      id: result.id,
      url: result.html_url,
      headSha: checkRun.head_sha,
      conclusion: checkRun.conclusion,
    };
  }
}
