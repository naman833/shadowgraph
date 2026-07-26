/**
 * ShadowGraph evidence API route.
 *
 * GET /api/shadowgraph/evidence?owner=naman833&repo=shadowgraph&pull=1
 *
 * Combines GitHub PR metadata, the ShadowGraph Check result, and the real
 * workflow evidence artifact into a single AnalysisViewModel for the UI.
 *
 * Evidence is never fabricated from prose. If the artifact cannot be retrieved
 * (auth required, expired, etc.), the response clearly reports the reason.
 */
import { createDataHubClient } from "@/src/datahub";
import type {
  AnalysisViewModel,
  BreachedCheck,
  CheckConclusion,
  Consumer,
  DiffHunk,
  LineageEdge,
  LineageNode,
  ReplayMeasurement,
  RiskLevel,
  SourceStatus,
} from "@/src/types/analysis-view";

const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const OWNER_REPO_RE = /^[a-z0-9_.-]+$/i;
const CHECK_NAME = "ShadowGraph change impact";
const SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_ARTIFACT_BYTES = 5_000_000;

class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function getToken(): string | undefined {
  return process.env.GITHUB_TOKEN || undefined;
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ShadowGraph/1.0",
  };
  const token = getToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghFetch(path: string): Promise<Response> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = response.headers.get("x-ratelimit-reset");
    throw new ApiError(
      `Rate limited. Resets at ${reset ? new Date(Number(reset) * 1000).toISOString() : "unknown"}`,
      "RATE_LIMITED",
      429,
    );
  }
  if (!response.ok) {
    throw new ApiError(`GitHub API ${response.status}`, "GITHUB_ERROR", response.status);
  }
  return response;
}

/** Parse the structured text output of a ShadowGraph Check. */
function parseCheckText(text: string) {
  const riskMatch = text.match(/^Risk:\s*(.+)$/m);
  const affectedMatch = text.match(/^Affected assets:\s*(\d+)/m);
  const routeMatch = text.match(/^Route to:\s*(.+)$/m);
  const evidenceLines = text
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));

  return {
    risk: (riskMatch?.[1]?.trim() ?? "unknown") as RiskLevel,
    affectedAssets: Number(affectedMatch?.[1]) || 0,
    ownerRouting: routeMatch?.[1]?.trim() ?? "",
    reasons: evidenceLines,
  };
}

/**
 * Use the shared DataHub adapter for health checks. This guarantees the same
 * default URL (http://localhost:8080) and token handling as all other routes.
 */
async function checkDataHubHealth(): Promise<"live" | "unavailable" | "not_configured"> {
  try {
    const client = createDataHubClient();
    const health = await client.health();
    return health.ok && health.source === "live" ? "live" : "unavailable";
  } catch {
    return "unavailable";
  }
}

interface EvidenceArtifact {
  schemaVersion: string;
  consumers: Array<{
    urn: string;
    name: string;
    type?: string;
    classification: string;
    affected: boolean;
    owners?: Array<{ urn?: string; name: string; type?: string }>;
    matchedChanges?: unknown[];
  }>;
  replay: {
    comparison: { breached: Array<{ model?: string; category: string; metric: string; before: unknown; after: unknown; threshold?: unknown; magnitude?: number }> } | null;
    models: Array<{
      model: string;
      dataset?: string;
      urn?: string;
      comparison: { breached: Array<{ category: string; metric: string; before: unknown; after: unknown; threshold?: unknown; magnitude?: number }> };
    }>;
  };
  decision: {
    conclusion: string;
    severity: string;
    affectedAssetCount: number;
    reasons: string[];
    summary: string;
  };
  context?: {
    changes: Array<{
      identity: { entity?: { urn: string; name: string; platform?: string; owners?: Array<{ name: string }> } };
      consumers: Array<{ urn: string; name: string; type?: string; platform?: string }>;
    }>;
    source: string;
  };
  dataHub?: { source: string; graphqlUrl?: string };
  generatedFor?: { repository: string; pullRequest: number; baseSha: string; headSha: string };
}

/**
 * Attempt to download the real evidence artifact from the workflow run.
 * Returns null if auth is required or artifact is missing.
 */
async function fetchEvidenceArtifact(
  owner: string,
  repo: string,
  headSha: string,
): Promise<{ artifact: EvidenceArtifact; source: "workflow_artifact" } | { artifact: null; reason: string }> {
  const token = getToken();
  if (!token) {
    return { artifact: null, reason: "GITHUB_TOKEN required for artifact download" };
  }

  try {
    // Find workflow runs for this commit
    const runsResp = await ghFetch(`/repos/${owner}/${repo}/actions/runs?head_sha=${headSha}&per_page=5`);
    const runsData = (await runsResp.json()) as { workflow_runs: Array<{ id: number }> };

    for (const run of runsData.workflow_runs ?? []) {
      const artResp = await ghFetch(`/repos/${owner}/${repo}/actions/runs/${run.id}/artifacts`);
      const artData = (await artResp.json()) as { artifacts: Array<{ id: number; name: string; size_in_bytes: number; expired: boolean }> };

      // Find artifact matching this exact head SHA
      const match = artData.artifacts.find(
        (a) => a.name.includes(headSha) && !a.expired,
      );

      if (!match) continue;
      if (match.size_in_bytes > MAX_ARTIFACT_BYTES) {
        return { artifact: null, reason: "Evidence artifact exceeds size limit" };
      }

      // Download the zip - GitHub redirects to blob storage, handle manually
      // to avoid cross-origin header stripping
      const zipInitResp = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/actions/artifacts/${match.id}/zip`,
        {
          headers: ghHeaders(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: "manual",
        },
      );

      if (zipInitResp.status === 401 || zipInitResp.status === 403) {
        return { artifact: null, reason: "Authentication required for artifact download" };
      }

      let zipResp: Response;
      if (zipInitResp.status >= 300 && zipInitResp.status < 400) {
        const location = zipInitResp.headers.get("location");
        if (!location) {
          return { artifact: null, reason: "Artifact redirect missing location" };
        }
        zipResp = await fetch(location, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } else if (zipInitResp.ok) {
        zipResp = zipInitResp;
      } else {
        return { artifact: null, reason: `Artifact download failed: HTTP ${zipInitResp.status}` };
      }

      if (!zipResp.ok) {
        return { artifact: null, reason: `Artifact download failed: HTTP ${zipResp.status}` };
      }

      const zipBuffer = await zipResp.arrayBuffer();
      if (zipBuffer.byteLength > MAX_ARTIFACT_BYTES) {
        return { artifact: null, reason: "Downloaded artifact exceeds size limit" };
      }

      // Extract JSON from zip. GitHub uses data descriptors (size=0 in local
      // header) so we read the central directory at the end of the archive.
      const { inflateRaw } = await import("node:zlib");
      const { promisify } = await import("node:util");
      const inflate = promisify(inflateRaw);
      const zipBytes = new Uint8Array(zipBuffer);
      const dv = new DataView(zipBuffer);

      // Find End of Central Directory (EOCD) signature 0x06054b50
      let eocdOffset = -1;
      for (let i = zipBytes.length - 22; i >= 0; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
      }
      if (eocdOffset < 0) {
        return { artifact: null, reason: "Invalid ZIP: no end-of-central-directory" };
      }

      const cdOffset = dv.getUint32(eocdOffset + 16, true);
      const cdEntries = dv.getUint16(eocdOffset + 10, true);
      let jsonContent: string | null = null;
      let cdPos = cdOffset;

      for (let i = 0; i < cdEntries && cdPos < eocdOffset; i++) {
        if (dv.getUint32(cdPos, true) !== 0x02014b50) break;
        const method = dv.getUint16(cdPos + 10, true);
        const compSize = dv.getUint32(cdPos + 20, true);
        const fnLen = dv.getUint16(cdPos + 28, true);
        const extraLen = dv.getUint16(cdPos + 30, true);
        const commentLen = dv.getUint16(cdPos + 32, true);
        const localHeaderOffset = dv.getUint32(cdPos + 42, true);
        const filename = new TextDecoder().decode(zipBytes.subarray(cdPos + 46, cdPos + 46 + fnLen));

        if (filename.includes("..") || filename.startsWith("/")) {
          return { artifact: null, reason: "Artifact contains path traversal" };
        }

        if (filename.endsWith(".json")) {
          if (jsonContent !== null) {
            return { artifact: null, reason: "Artifact contains multiple JSON files" };
          }
          // Read data from local file header
          const localFnLen = dv.getUint16(localHeaderOffset + 26, true);
          const localExtraLen = dv.getUint16(localHeaderOffset + 28, true);
          const dataStart = localHeaderOffset + 30 + localFnLen + localExtraLen;
          const compressedData = zipBytes.subarray(dataStart, dataStart + compSize);

          if (method === 0) {
            jsonContent = new TextDecoder().decode(compressedData);
          } else if (method === 8) {
            const decompressed = await inflate(Buffer.from(compressedData));
            jsonContent = decompressed.toString("utf8");
          } else {
            return { artifact: null, reason: `Unsupported compression: ${method}` };
          }
        }

        cdPos += 46 + fnLen + extraLen + commentLen;
      }

      if (!jsonContent) {
        return { artifact: null, reason: "No JSON file found in artifact" };
      }

      if (jsonContent.length > MAX_ARTIFACT_BYTES) {
        return { artifact: null, reason: "Evidence JSON exceeds size limit" };
      }

      let parsed: EvidenceArtifact;
      try {
        parsed = JSON.parse(jsonContent);
      } catch {
        return { artifact: null, reason: "Evidence JSON is malformed" };
      }

      // Validate schema version
      if (!parsed.schemaVersion || !["1", "2"].includes(parsed.schemaVersion)) {
        return { artifact: null, reason: `Unsupported evidence schema version: ${parsed.schemaVersion}` };
      }

      // Validate head SHA matches
      if (parsed.generatedFor?.headSha && parsed.generatedFor.headSha.toLowerCase() !== headSha.toLowerCase()) {
        return { artifact: null, reason: "Evidence artifact head SHA does not match PR" };
      }

      return { artifact: parsed, source: "workflow_artifact" };
    }

    return { artifact: null, reason: "No evidence artifact found for this commit" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return { artifact: null, reason: `Artifact retrieval failed: ${msg}` };
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const owner = url.searchParams.get("owner");
    const repo = url.searchParams.get("repo");
    const pull = url.searchParams.get("pull");

    if (!owner || !OWNER_REPO_RE.test(owner)) {
      throw new ApiError("Invalid owner", "INVALID_INPUT", 400);
    }
    if (!repo || !OWNER_REPO_RE.test(repo)) {
      throw new ApiError("Invalid repo", "INVALID_INPUT", 400);
    }
    if (!pull || !Number.isInteger(Number(pull)) || Number(pull) < 1) {
      throw new ApiError("Invalid pull number", "INVALID_INPUT", 400);
    }
    const prNumber = Number(pull);

    // Fetch PR metadata
    const prResp = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    const pr = (await prResp.json()) as Record<string, unknown>;
    const base = pr.base as Record<string, unknown>;
    const head = pr.head as Record<string, unknown>;
    const user = pr.user as Record<string, unknown>;
    const headSha = (head?.sha as string) ?? "";
    const baseSha = (base?.sha as string) ?? "";

    if (!SHA_RE.test(headSha)) {
      throw new ApiError("Could not resolve head SHA", "INVALID_STATE", 422);
    }

    // Fetch files
    const filesResp = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);
    const rawFiles = (await filesResp.json()) as Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }>;

    const changedFiles: DiffHunk[] = rawFiles.map((f) => ({
      path: f.filename,
      patch: f.patch ?? "",
      additions: f.additions,
      deletions: f.deletions,
    }));

    // Fetch check runs
    const checksResp = await ghFetch(
      `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
    );
    const checksData = (await checksResp.json()) as {
      check_runs: Array<{
        name: string;
        status: string;
        conclusion: string | null;
        output: { title: string | null; summary: string | null; text: string | null };
        html_url: string;
        details_url: string | null;
      }>;
    };

    const sgCheck = checksData.check_runs.find(
      (c) => c.name.toLowerCase() === CHECK_NAME.toLowerCase(),
    );

    // Parse check text for summary info
    const checkText = sgCheck?.output?.text ?? "";
    const parsed = parseCheckText(checkText);
    const conclusion = (sgCheck?.conclusion ?? "neutral") as CheckConclusion;

    // DataHub health check via shared adapter
    const datahubStatus = await checkDataHubHealth();

    // Attempt to download the real evidence artifact
    const artifactResult = await fetchEvidenceArtifact(owner, repo, headSha);

    // Build the view model from real evidence when available
    let consumers: Consumer[] = [];
    const lineageNodes: LineageNode[] = [];
    const lineageEdges: LineageEdge[] = [];
    const breachedChecks: BreachedCheck[] = [];
    const replayMeasurements: ReplayMeasurement[] = [];
    const resolvedUrns: string[] = [];
    let evidenceSourceLabel: SourceStatus["evidence"];
    let evidenceNote = "";

    if (artifactResult.artifact) {
      const ev = artifactResult.artifact;

      // Real consumers from the artifact
      consumers = (ev.consumers ?? []).map((c) => ({
        urn: c.urn,
        name: c.name,
        type: c.type ?? "dataset",
        affected: c.affected,
        owners: (c.owners ?? []).map((o) => ({ name: o.name, urn: o.urn, type: o.type })),
        classification: c.classification as Consumer["classification"],
      }));

      // Real breached checks from replay models
      for (const model of ev.replay?.models ?? []) {
        for (const b of model.comparison?.breached ?? []) {
          breachedChecks.push({
            model: model.model,
            metric: b.metric,
            category: b.category,
            before: b.before as number | string,
            after: b.after as number | string,
            threshold: b.threshold as number | string | undefined,
            magnitude: b.magnitude,
          });
        }
        // All measurements (including non-breached)
        for (const d of model.comparison?.breached ?? []) {
          replayMeasurements.push({
            model: model.model,
            metric: d.metric,
            category: d.category,
            before: d.before as number | string,
            after: d.after as number | string,
            breached: true,
            threshold: d.threshold as number | string | undefined,
          });
        }
      }

      // Real URNs and lineage from context
      for (const change of ev.context?.changes ?? []) {
        if (change.identity?.entity?.urn) {
          resolvedUrns.push(change.identity.entity.urn);
          lineageNodes.push({
            urn: change.identity.entity.urn,
            name: change.identity.entity.name,
            type: "DATASET",
            platform: change.identity.entity.platform,
            degree: 0,
          });
        }
        for (const consumer of change.consumers ?? []) {
          if (!lineageNodes.some((n) => n.urn === consumer.urn)) {
            lineageNodes.push({
              urn: consumer.urn,
              name: consumer.name,
              type: consumer.type ?? "DATASET",
              platform: consumer.platform,
              degree: 1,
            });
          }
          if (change.identity?.entity?.urn) {
            const edge = { from: change.identity.entity.urn, to: consumer.urn };
            if (!lineageEdges.some((e) => e.from === edge.from && e.to === edge.to)) {
              lineageEdges.push(edge);
            }
          }
        }
      }

      evidenceSourceLabel = "commit_scoped_evidence";
    } else {
      // No artifact available — report why, do NOT fabricate data
      evidenceSourceLabel = "missing";
      evidenceNote = artifactResult.reason;
    }

    // Determine owner routing from real data
    const ownerNames = artifactResult.artifact
      ? [...new Set(consumers.filter((c) => c.affected).flatMap((c) => c.owners.map((o) => o.name)).filter(Boolean))]
      : parsed.ownerRouting ? parsed.ownerRouting.split(",").map((s) => s.trim()).filter(Boolean) : [];

    const assetOwners = ownerNames.map((name) => ({ name }));

    const sources: SourceStatus = {
      github: "live_github",
      datahub: datahubStatus,
      evidence: evidenceSourceLabel,
    };

    const detailsUrl = sgCheck?.details_url ?? "";
    const workflowLinks = {
      runUrl: detailsUrl || undefined,
      jobUrl: undefined,
    };

    const viewModel: AnalysisViewModel = {
      owner,
      repo,
      prNumber,
      prUrl: (pr.html_url as string) ?? `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      prTitle: (pr.title as string) ?? "",
      prAuthor: (user?.login as string) ?? "unknown",
      baseBranch: (base?.ref as string) ?? "main",
      headBranch: (head?.ref as string) ?? "",
      baseSha,
      headSha,
      changedFiles,
      changedDatasets: [],
      datahubConnected: datahubStatus === "live",
      resolvedUrns,
      lineageNodes,
      lineageEdges,
      trueConsumers: consumers.filter((c) => c.affected),
      excludedFalsePositives: consumers.filter((c) => !c.affected),
      assetOwners,
      replayMeasurements,
      breachedChecks,
      riskLevel: (artifactResult.artifact?.decision?.severity ?? parsed.risk) as RiskLevel,
      checkResult: {
        name: sgCheck?.name ?? CHECK_NAME,
        status: sgCheck?.status ?? "missing",
        conclusion,
        title: sgCheck?.output?.title ?? "No check found",
        summary: sgCheck?.output?.summary ?? "",
        text: checkText,
      },
      workflowLinks,
      sources,
      evidenceSource: artifactResult.artifact ? "commit_scoped_evidence" : "live_github",
      analysisTimestamp: new Date().toISOString(),
    };

    return Response.json({ ok: true, data: viewModel, evidenceNote }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json(
        { ok: false, error: true, code: error.code, message: error.message },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    const isTimeout = message.includes("abort") || message.includes("timeout");
    return Response.json(
      {
        ok: false,
        error: true,
        code: isTimeout ? "TIMEOUT" : "INTERNAL",
        message: isTimeout ? "Request timed out" : message,
      },
      { status: isTimeout ? 504 : 500, headers: { "cache-control": "no-store" } },
    );
  }
}
