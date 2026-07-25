/**
 * Extracts the data changes from a pull-request diff and writes them as an
 * evidence artifact. This is the DETECT stage on its own: it reads two
 * immutable commits and reports which datasets and columns changed.
 *
 * It does not resolve DataHub context, classify consumers, replay, or decide,
 * so it never produces a merge verdict. It is useful for inspecting detection
 * on a repository that has no ShadowGraph manifest. For the full pipeline and
 * a real decision, use `npm run analyze:pr`.
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { analyzePullRequest } from "../src/github/ingest.js";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function git(args, { allowMissing = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 4_000_000,
  });
  if (result.status !== 0) {
    if (allowMissing) return "";
    throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  }
  return result.stdout;
}

function snapshot(sha, filePath) {
  return git(["show", `${sha}:${filePath}`], { allowMissing: true });
}

function resolveCommit(reference) {
  return git(["rev-parse", "--verify", `${reference}^{commit}`]).trim();
}

function changedFiles(baseSha, headSha) {
  const output = git(["diff", "--name-status", "-M", baseSha, headSha]);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [rawStatus, firstPath, secondPath] = line.split("\t");
      const statusCode = rawStatus[0];
      if (statusCode === "R") {
        return {
          path: secondPath,
          status: "renamed",
          before: snapshot(baseSha, firstPath),
          after: snapshot(headSha, secondPath),
        };
      }

      const statuses = {
        A: "added",
        D: "removed",
        M: "modified",
      };
      const status = statuses[statusCode];
      if (!status) throw new Error(`Unsupported git file status: ${rawStatus}`);
      return {
        path: firstPath,
        status,
        before: status === "added" ? "" : snapshot(baseSha, firstPath),
        after: status === "removed" ? "" : snapshot(headSha, firstPath),
      };
    });
}

const baseSha = resolveCommit(requiredOption("--base"));
const headSha = resolveCommit(requiredOption("--head"));
const outputPath = option("--output", "outputs/pull-request-analysis.json");
const repository = option(
  "--repository",
  process.env.GITHUB_REPOSITORY ?? "local/shadowgraph",
);
const pullRequest = Number(
  option("--pull-request", process.env.GITHUB_EVENT_NUMBER ?? "1"),
);

const result = analyzePullRequest({
  repository,
  pullRequest,
  baseSha,
  headSha,
  files: changedFiles(baseSha, headSha),
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(
  `ShadowGraph analyzed ${result.files.analyzed} of ${result.files.received} changed files at ${result.headSha}.`,
);
console.log(`Detected ${result.changes.length} supported data changes.`);
console.log(`Evidence: ${outputPath}`);
