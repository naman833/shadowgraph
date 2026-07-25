const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const DATAHUB_URN = /^urn:li:[a-zA-Z][a-zA-Z0-9_-]*:[^\s\u0000-\u001f\u007f]+$/;

export class DataHubEvidenceError extends Error {
  constructor(message, code = "INVALID_EVIDENCE_INPUT") {
    super(message);
    this.name = "DataHubEvidenceError";
    this.code = code;
  }
}

function assertInput(condition, message) {
  if (!condition) throw new DataHubEvidenceError(message);
}

function safeText(value, fallback = "Unknown") {
  if (typeof value !== "string") return fallback;
  const text = value
    .replace(/```[\s\S]*?```/g, "[redacted code]")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "[redacted code]")
    .replace(
      /\b(?:ignore (?:all |any )?(?:previous|prior) instructions|system prompt|you are chatgpt)\b/gi,
      "[redacted instruction]",
    )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return text.slice(0, 500) || fallback;
}

function validateAnalysis(analysis) {
  assertInput(analysis && typeof analysis === "object", "Analysis is required");
  assertInput(REPOSITORY.test(analysis.repository ?? ""), "Repository must be owner/name");
  assertInput(Number.isInteger(analysis.pullRequest) && analysis.pullRequest > 0, "Invalid PR number");
  assertInput(SHA.test(analysis.headSha ?? ""), "Head SHA must be a full Git object ID");
  const expectedId = `${analysis.repository}#${analysis.pullRequest}@${analysis.headSha}`;
  assertInput(analysis.analysisId === expectedId, "Analysis ID is not scoped to the head commit");
}

function stableEvidenceKey(analysis) {
  // The full immutable source identity is retained, making this collision-free
  // within a repository without relying on random or process-local state.
  return `shadowgraph:${analysis.repository}#${analysis.pullRequest}@${analysis.headSha.toLowerCase()}`;
}

/**
 * Generates an idempotent semantic upsert plan. A transport resolves the
 * evidence key first, then creates or updates one DataHub Document.
 */
export function buildDataHubEvidencePlan({
  analysis,
  decision,
  relatedAssets = [],
  checkUrl,
}) {
  validateAnalysis(analysis);
  assertInput(decision && typeof decision === "object", "Decision is required");
  assertInput(
    ["success", "failure", "neutral"].includes(decision.conclusion),
    "Invalid decision conclusion",
  );

  const assets = [...new Set(relatedAssets)].sort();
  for (const urn of assets) {
    assertInput(typeof urn === "string" && DATAHUB_URN.test(urn), `Invalid DataHub URN: ${urn}`);
  }
  if (checkUrl) assertInput(/^https?:\/\//i.test(checkUrl), "Check URL must use HTTP or HTTPS");

  const evidenceKey = stableEvidenceKey(analysis);
  const targetUrn = `urn:li:document:shadowgraph_${createHash("sha256")
    .update(evidenceKey)
    .digest("hex")}`;
  const outcome =
    decision.conclusion === "failure"
      ? "BLOCKED"
      : decision.conclusion === "neutral"
        ? "INCONCLUSIVE"
        : "PASSED";
  const reasons = (decision.reasons ?? []).map((reason) => safeText(reason)).slice(0, 20);
  const contents = [
    `<!-- ${evidenceKey} -->`,
    `# ShadowGraph decision: ${outcome}`,
    "",
    `- Repository: \`${analysis.repository}\``,
    `- Pull request: #${analysis.pullRequest}`,
    `- Commit: \`${analysis.headSha.toLowerCase()}\``,
    `- Severity: ${safeText(decision.severity, "unknown")}`,
    `- Affected assets: ${Number(decision.affectedAssetCount) || 0}`,
    ...(checkUrl ? [`- GitHub Check: ${checkUrl}`] : []),
    "",
    "## Evidence",
    "",
    ...(reasons.length ? reasons : ["No breaking downstream impact detected"]).map(
      (reason) => `- ${reason}`,
    ),
  ].join("\n");

  return {
    schemaVersion: "1",
    operation: "upsert_document",
    idempotencyKey: evidenceKey,
    targetUrn,
    lookup: {
      entityType: "DOCUMENT",
      query: `"${evidenceKey}"`,
      exactMarker: `<!-- ${evidenceKey} -->`,
    },
    document: {
      title: `ShadowGraph: ${analysis.repository} PR #${analysis.pullRequest} @ ${analysis.headSha.slice(0, 12)}`,
      contents: { text: contents },
      relatedAssets: assets,
    },
  };
}

/**
 * Approval-gated DataHub writeback abstraction. The injected transport owns
 * GraphQL details and must implement upsertDocument(plan).
 */
export class DataHubEvidenceClient {
  constructor({ transport } = {}) {
    this.transport = transport;
  }

  async write(plan, { dryRun = true, approved = false } = {}) {
    assertInput(plan?.operation === "upsert_document", "Unsupported evidence operation");
    assertInput(typeof plan.idempotencyKey === "string", "Evidence key is required");
    if (dryRun) return { dryRun: true, approved: false, request: plan };
    if (!approved) {
      throw new DataHubEvidenceError(
        "Explicit approval is required before DataHub writeback",
        "APPROVAL_REQUIRED",
      );
    }
    if (!this.transport || typeof this.transport.upsertDocument !== "function") {
      throw new DataHubEvidenceError("DataHub evidence transport is required", "CONFIG");
    }
    const result = await this.transport.upsertDocument(plan);
    return {
      dryRun: false,
      approved: true,
      idempotencyKey: plan.idempotencyKey,
      ...result,
    };
  }
}

/**
 * Adapter for the official DataHub MCP server's save_document tool. Supplying
 * the deterministic target URN makes retries update one document instead of
 * creating duplicates.
 */
export class DataHubMcpDocumentTransport {
  constructor({ client } = {}) {
    this.client = client;
  }

  async upsertDocument(plan) {
    assertInput(
      this.client && typeof this.client.callTool === "function",
      "DataHub MCP client is required",
    );
    assertInput(DATAHUB_URN.test(plan.targetUrn ?? ""), "Document target URN is required");
    const result = await this.client.callTool("save_document", {
      document_type: "Decision",
      title: plan.document.title,
      content: plan.document.contents.text,
      urn: plan.targetUrn,
      topics: ["ShadowGraph", "change impact", "pull request safety"],
      related_assets: plan.document.relatedAssets,
    });
    if (result?.isError) {
      throw new DataHubEvidenceError("DataHub MCP save_document failed", "MCP");
    }
    return {
      action: "upserted",
      urn: plan.targetUrn,
      result,
    };
  }
}
import { createHash } from "node:crypto";
