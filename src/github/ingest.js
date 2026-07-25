import { detectChanges } from "../analysis/index.js";

export const MAX_PULL_REQUEST_FILES = 100;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 2_000_000;

const ANALYZABLE_FILE = /\.(?:sql|ddl)$/i;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const FILE_STATUSES = new Set(["added", "modified", "removed", "renamed"]);

export class PullRequestInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "PullRequestInputError";
    this.code = "INVALID_PULL_REQUEST_INPUT";
  }
}

function assertInput(condition, message) {
  if (!condition) throw new PullRequestInputError(message);
}

function validatePath(filePath) {
  assertInput(typeof filePath === "string" && filePath.length > 0, "File path is required");
  assertInput(filePath.length <= 500, "File path exceeds 500 characters");
  assertInput(!filePath.startsWith("/") && !filePath.startsWith("\\"), "File path must be relative");
  assertInput(!filePath.includes("\0"), "File path contains a null byte");
  assertInput(!filePath.split(/[\\/]/).includes(".."), "File path cannot traverse directories");
}

function contentBytes(value) {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Validates and normalizes immutable before/after file snapshots supplied by a
 * GitHub pull-request workflow.
 */
export function normalizePullRequestInput(input) {
  assertInput(input && typeof input === "object", "Pull request input is required");
  assertInput(REPOSITORY.test(input.repository ?? ""), "Repository must be owner/name");
  assertInput(
    Number.isInteger(input.pullRequest) && input.pullRequest > 0,
    "Pull request number must be a positive integer",
  );
  assertInput(SHA.test(input.baseSha ?? ""), "Base SHA must be a full Git object ID");
  assertInput(SHA.test(input.headSha ?? ""), "Head SHA must be a full Git object ID");
  assertInput(input.baseSha !== input.headSha, "Base and head SHAs must differ");
  assertInput(Array.isArray(input.files), "Files must be an array");
  assertInput(
    input.files.length <= MAX_PULL_REQUEST_FILES,
    `Pull request exceeds the ${MAX_PULL_REQUEST_FILES}-file safety limit`,
  );

  const seenPaths = new Set();
  let totalBytes = 0;
  const files = input.files.map((file, index) => {
    assertInput(file && typeof file === "object", `File ${index + 1} must be an object`);
    validatePath(file.path);
    assertInput(!seenPaths.has(file.path), `Duplicate file path: ${file.path}`);
    seenPaths.add(file.path);
    assertInput(FILE_STATUSES.has(file.status), `Unsupported status for ${file.path}`);
    assertInput(typeof file.before === "string", `Before content is required for ${file.path}`);
    assertInput(typeof file.after === "string", `After content is required for ${file.path}`);
    assertInput(
      file.status !== "added" || file.before === "",
      `Added file ${file.path} must have empty before content`,
    );
    assertInput(
      file.status !== "removed" || file.after === "",
      `Removed file ${file.path} must have empty after content`,
    );

    const bytes = contentBytes(file.before) + contentBytes(file.after);
    assertInput(bytes <= MAX_FILE_BYTES, `${file.path} exceeds the per-file safety limit`);
    totalBytes += bytes;
    assertInput(totalBytes <= MAX_TOTAL_BYTES, "Pull request exceeds the total content safety limit");

    return {
      path: file.path,
      status: file.status,
      before: file.before,
      after: file.after,
      analyzable: ANALYZABLE_FILE.test(file.path),
    };
  });

  return {
    repository: input.repository,
    pullRequest: input.pullRequest,
    baseSha: input.baseSha.toLowerCase(),
    headSha: input.headSha.toLowerCase(),
    files,
  };
}

/**
 * Runs deterministic change detection over a normalized GitHub PR snapshot.
 */
export function analyzePullRequest(input) {
  const normalized = normalizePullRequestInput(input);
  const analyzableFiles = normalized.files.filter((file) => file.analyzable);
  const changes = analyzableFiles.flatMap((file) =>
    detectChanges({
      filePath: file.path,
      before: file.before,
      after: file.after,
    }).map((change) => ({
      ...change,
      filePath: file.path,
      fileStatus: file.status,
    })),
  );

  return {
    schemaVersion: "1",
    source: "github_pull_request",
    analysisId: `${normalized.repository}#${normalized.pullRequest}@${normalized.headSha}`,
    repository: normalized.repository,
    pullRequest: normalized.pullRequest,
    baseSha: normalized.baseSha,
    headSha: normalized.headSha,
    files: {
      received: normalized.files.length,
      analyzed: analyzableFiles.length,
      ignored: normalized.files.length - analyzableFiles.length,
    },
    changes,
  };
}
