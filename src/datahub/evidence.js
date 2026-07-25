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

const DOCUMENT_URN_PREFIX = "urn:li:document:";

const CREATE_DOCUMENT_MUTATION = `
  mutation ShadowGraphCreateEvidence($input: CreateDocumentInput!) {
    createDocument(input: $input)
  }
`;

const UPDATE_DOCUMENT_CONTENTS_MUTATION = `
  mutation ShadowGraphUpdateEvidence($input: UpdateDocumentContentsInput!) {
    updateDocumentContents(input: $input)
  }
`;

const UPDATE_DOCUMENT_RELATED_MUTATION = `
  mutation ShadowGraphRelateEvidence($input: UpdateDocumentRelatedEntitiesInput!) {
    updateDocumentRelatedEntities(input: $input)
  }
`;

const READ_DOCUMENT_QUERY = `
  query ShadowGraphReadEvidence($urn: String!) {
    entity(urn: $urn) {
      urn
      ... on Document {
        subType
        info {
          title
          contents { text }
          relatedAssets { asset { urn } }
        }
      }
    }
  }
`;

const DUPLICATE_DOCUMENT = /already exists/i;

/**
 * Writes evidence as a DataHub Document over GraphQL.
 *
 * The local `mcp-server-datahub` build does not expose `save_document`, so this
 * uses the GMS document mutations directly. `createDocument` is attempted first
 * and its duplicate-ID rejection is what triggers the update path, so a retried
 * CI run updates one record instead of creating a second. Deciding by an
 * existence query instead would be wrong: DataHub's `exists` field is
 * search-index backed and lags a write by seconds.
 *
 * Every write is read back and its idempotency marker verified before the result
 * is reported, so a silently-dropped mutation cannot be presented as a
 * successful writeback.
 */
export class DataHubGraphQLDocumentTransport {
  constructor({ graphql, subType = "Decision" } = {}) {
    this.graphql = graphql;
    this.subType = subType;
  }

  async upsertDocument(plan) {
    assertInput(
      typeof this.graphql === "function",
      "A DataHub GraphQL transport function is required",
    );
    assertInput(DATAHUB_URN.test(plan.targetUrn ?? ""), "Document target URN is required");
    assertInput(
      plan.targetUrn.startsWith(DOCUMENT_URN_PREFIX),
      "Evidence target must be a DataHub document URN",
    );

    const urn = plan.targetUrn;
    const id = urn.slice(DOCUMENT_URN_PREFIX.length);
    const title = plan.document.title;
    const text = plan.document.contents.text;
    const relatedAssets = plan.document.relatedAssets ?? [];

    let existed = false;
    try {
      const created = await this.graphql(CREATE_DOCUMENT_MUTATION, {
        input: {
          id,
          title,
          subType: this.subType,
          state: "PUBLISHED",
          contents: { text },
          relatedAssets,
        },
      });
      if (created?.createDocument !== urn) {
        throw new DataHubEvidenceError(
          `DataHub created ${created?.createDocument ?? "no document"} instead of ${urn}`,
          "GRAPHQL",
        );
      }
    } catch (error) {
      if (!DUPLICATE_DOCUMENT.test(error?.message ?? "")) throw error;
      existed = true;
      const updated = await this.graphql(UPDATE_DOCUMENT_CONTENTS_MUTATION, {
        input: { urn, title, contents: { text }, subType: this.subType },
      });
      if (updated?.updateDocumentContents !== true) {
        throw new DataHubEvidenceError(
          "DataHub did not confirm the evidence document update",
          "GRAPHQL",
        );
      }
      // Related assets live in a separate aspect, so they are re-asserted on
      // every write to keep the record consistent with the current decision.
      await this.graphql(UPDATE_DOCUMENT_RELATED_MUTATION, {
        input: { urn, relatedAssets },
      });
    }

    const readBack = await this.graphql(READ_DOCUMENT_QUERY, { urn });
    const document = readBack?.entity;
    if (!document?.info) {
      throw new DataHubEvidenceError(
        "The evidence document could not be read back after writing",
        "GRAPHQL",
      );
    }
    const storedText = document.info?.contents?.text ?? "";
    if (!storedText.includes(plan.lookup.exactMarker)) {
      throw new DataHubEvidenceError(
        "The evidence document read back without its idempotency marker",
        "GRAPHQL",
      );
    }

    return {
      action: existed ? "updated" : "created",
      urn,
      readBack: {
        urn: document.urn,
        title: document.info?.title ?? null,
        markerPresent: true,
        contentBytes: storedText.length,
        relatedAssets: (document.info?.relatedAssets ?? [])
          .map((related) => related?.asset?.urn)
          .filter(Boolean)
          .sort(),
      },
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
