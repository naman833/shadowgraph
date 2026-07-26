/**
 * ShadowGraph evidence API route.
 *
 * GET /api/shadowgraph/evidence?owner=naman833&repo=shadowgraph&pull=1
 *
 * Combines GitHub PR metadata, the ShadowGraph Check result, and committed
 * evidence into a single AnalysisViewModel for the UI.
 */
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

async function checkDataHubHealth(): Promise<"live" | "unavailable" | "not_configured"> {
  const gmsUrl = process.env.DATAHUB_GMS_URL;
  if (!gmsUrl) return "not_configured";
  try {
    const response = await fetch(`${gmsUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok ? "live" : "unavailable";
  } catch {
    return "unavailable";
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

    // Parse evidence from the check text
    const checkText = sgCheck?.output?.text ?? "";
    const parsed = parseCheckText(checkText);
    const conclusion = (sgCheck?.conclusion ?? "neutral") as CheckConclusion;

    // Extract consumers and lineage from check text evidence
    const consumers: Consumer[] = [];
    const lineageNodes: LineageNode[] = [];
    const lineageEdges: LineageEdge[] = [];
    const breachedChecks: BreachedCheck[] = [];
    const replayMeasurements: ReplayMeasurement[] = [];

    // Build breached checks from evidence reasons
    for (const reason of parsed.reasons) {
      if (reason.includes("exceeded") || reason.includes("check")) {
        breachedChecks.push({
          model: "aggregate",
          metric: reason,
          category: "policy",
          before: "within threshold",
          after: "exceeded",
          breached: true,
        });
      }
    }

    // Determine owner routing
    const ownerNames = parsed.ownerRouting
      ? parsed.ownerRouting.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const assetOwners = ownerNames.map((name) => ({ name }));

    // DataHub health check
    const datahubStatus = await checkDataHubHealth();

    // Determine evidence source status
    const hasCheck = sgCheck !== null && sgCheck !== undefined;
    const evidenceStatus: SourceStatus["evidence"] = hasCheck
      ? sgCheck!.output?.text?.includes(`Commit: \`${headSha}\``)
        ? "commit_scoped_evidence"
        : "stale"
      : "missing";

    const sources: SourceStatus = {
      github: "live_github",
      datahub: datahubStatus,
      evidence: evidenceStatus,
    };

    // Workflow links from check details URL
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
      resolvedUrns: [],
      lineageNodes,
      lineageEdges,
      trueConsumers: consumers,
      excludedFalsePositives: [],
      assetOwners,
      replayMeasurements,
      breachedChecks,
      riskLevel: parsed.risk,
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
      evidenceSource: "live_github",
      analysisTimestamp: new Date().toISOString(),
    };

    // Re-parse detailed evidence from the check text for richer display
    if (checkText) {
      const affectedLine = parsed.reasons.find((r) => r.includes("downstream"));
      const breachedLine = parsed.reasons.find((r) => r.includes("counterfactual"));

      // Extract counts from structured text
      if (affectedLine) {
        const countMatch = affectedLine.match(/^(\d+)/);
        if (countMatch) {
          // Create placeholder consumers based on count
          const count = Number(countMatch[1]);
          for (let i = 0; i < count; i++) {
            consumers.push({
              urn: `urn:li:dataset:affected-${i}`,
              name: `Affected asset ${i + 1}`,
              type: "dataset",
              affected: true,
              owners: assetOwners,
              classification: "true_consumer",
            });
          }
        }
      }

      if (breachedLine) {
        const countMatch = breachedLine.match(/^(\d+)/);
        if (countMatch) {
          const count = Number(countMatch[1]);
          // Ensure we have enough breached checks
          while (breachedChecks.length < count) {
            breachedChecks.push({
              model: "policy",
              metric: `check-${breachedChecks.length + 1}`,
              category: "threshold",
              before: "within",
              after: "exceeded",
              breached: true,
            });
          }
        }
      }
    }

    return Response.json({ ok: true, data: viewModel }, {
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
