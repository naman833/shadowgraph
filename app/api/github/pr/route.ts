/**
 * GitHub PR metadata API route.
 *
 * GET /api/github/pr?owner=naman833&repo=shadowgraph&pull=1
 *
 * Fetches PR metadata, changed files, and Check Runs from the GitHub API.
 * Uses GITHUB_TOKEN server-side when available; supports public repos without
 * auth (subject to rate limits). Never exposes tokens to the browser.
 */

const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const OWNER_REPO_RE = /^[a-z0-9_.-]+$/i;
const CHECK_NAME = "ShadowGraph change impact";

interface GitHubFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  output: {
    title: string | null;
    summary: string | null;
    text: string | null;
  };
  html_url: string;
  details_url: string | null;
}

function getToken(): string | undefined {
  return process.env.GITHUB_TOKEN || undefined;
}

function headers(): Record<string, string> {
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
  const url = `${GITHUB_API}${path}`;
  const response = await fetch(url, {
    headers: headers(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = response.headers.get("x-ratelimit-reset");
    const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : "unknown";
    throw new GitHubApiError(
      `GitHub API rate limit exceeded. Resets at ${resetAt}. Configure GITHUB_TOKEN for higher limits.`,
      "RATE_LIMITED",
      403,
    );
  }

  if (response.status === 404) {
    throw new GitHubApiError("Repository or pull request not found", "NOT_FOUND", 404);
  }

  if (!response.ok) {
    throw new GitHubApiError(
      `GitHub API returned ${response.status}`,
      "GITHUB_ERROR",
      response.status,
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new GitHubApiError("Response too large", "RESPONSE_TOO_LARGE", 413);
  }

  return response;
}

class GitHubApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "GitHubApiError";
    this.code = code;
    this.status = status;
  }
}

function validateParams(params: URLSearchParams) {
  const owner = params.get("owner");
  const repo = params.get("repo");
  const pull = params.get("pull");

  if (!owner || !OWNER_REPO_RE.test(owner)) {
    throw new GitHubApiError("Invalid owner parameter", "INVALID_INPUT", 400);
  }
  if (!repo || !OWNER_REPO_RE.test(repo)) {
    throw new GitHubApiError("Invalid repo parameter", "INVALID_INPUT", 400);
  }
  if (!pull || !Number.isInteger(Number(pull)) || Number(pull) < 1) {
    throw new GitHubApiError("Invalid pull parameter", "INVALID_INPUT", 400);
  }

  return { owner, repo, pull: Number(pull) };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const { owner, repo, pull } = validateParams(url.searchParams);

    // Fetch PR metadata
    const prResponse = await ghFetch(`/repos/${owner}/${repo}/pulls/${pull}`);
    const pr = await prResponse.json() as Record<string, unknown>;

    const base = pr.base as Record<string, unknown>;
    const head = pr.head as Record<string, unknown>;
    const user = pr.user as Record<string, unknown>;

    // Fetch changed files
    const filesResponse = await ghFetch(
      `/repos/${owner}/${repo}/pulls/${pull}/files?per_page=100`,
    );
    const files = (await filesResponse.json()) as GitHubFile[];

    // Fetch check runs for the head SHA
    const headSha = head.sha as string;
    const checksResponse = await ghFetch(
      `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
    );
    const checksData = await checksResponse.json() as { check_runs: GitHubCheckRun[] };

    // Find the ShadowGraph check
    const sgCheck = checksData.check_runs.find(
      (c) => c.name.toLowerCase() === CHECK_NAME.toLowerCase(),
    );

    const result = {
      ok: true,
      pr: {
        number: pull,
        title: pr.title as string,
        author: (user?.login as string) ?? "unknown",
        url: pr.html_url as string,
        state: pr.state as string,
        baseBranch: (base?.ref as string) ?? "",
        headBranch: (head?.ref as string) ?? "",
        baseSha: (base?.sha as string) ?? "",
        headSha: headSha,
      },
      files: files.map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? "",
      })),
      check: sgCheck
        ? {
            name: sgCheck.name,
            status: sgCheck.status,
            conclusion: sgCheck.conclusion ?? "pending",
            title: sgCheck.output?.title ?? "",
            summary: sgCheck.output?.summary ?? "",
            text: sgCheck.output?.text ?? "",
            url: sgCheck.html_url,
            detailsUrl: sgCheck.details_url ?? "",
          }
        : null,
      source: "live_github" as const,
      fetchedAt: new Date().toISOString(),
    };

    return Response.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof GitHubApiError) {
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
        message: isTimeout ? "GitHub API request timed out" : message,
      },
      { status: isTimeout ? 504 : 500, headers: { "cache-control": "no-store" } },
    );
  }
}
