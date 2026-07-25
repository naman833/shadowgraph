/**
 * ShadowGraph's end-to-end pull-request entry point.
 *
 * Everything here is commit-scoped: the analysis, the replay, the evidence
 * artifact, and the GitHub Check payload all derive from one immutable head
 * SHA. External writes stay disabled unless explicitly enabled, and a missing
 * or ambiguous input produces a neutral result rather than an unsafe pass.
 */
import { spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";

import {
  DataHubEvidenceClient,
  DataHubGraphQLDocumentTransport,
} from "../datahub/evidence.js";
import { loadDataHubAdapter } from "../datahub/load.js";
import { buildReplayPlan, loadManifest, parseSeedCsv } from "../demo/index.js";
import { GitHubCheckPublisher } from "../github/checks.js";
import { OllamaAdvisor, loadOllamaConfig } from "../llm/ollama.js";
import { runShadowAnalysis } from "../pipeline/index.js";

const MAX_GIT_BUFFER = 8_000_000;
const ANALYZABLE = /\.(?:sql|ddl)$/i;

export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}

function git(args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (result.status !== 0) {
    if (allowFailure) return "";
    throw new CliError(
      result.stderr?.trim() || `git ${args.join(" ")} failed`,
    );
  }
  return result.stdout;
}

export function resolveCommit(reference, cwd) {
  return git(["rev-parse", "--verify", `${reference}^{commit}`], { cwd }).trim();
}

function fileAtCommit(sha, filePath, cwd) {
  return git(["show", `${sha}:${filePath}`], { cwd, allowFailure: true });
}

const GIT_STATUS = { A: "added", D: "removed", M: "modified" };

/**
 * Reads the exact set of files that differ between two immutable commits.
 */
export function changedFiles(baseSha, headSha, cwd) {
  const output = git(["diff", "--name-status", "-M", baseSha, headSha], { cwd });
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [rawStatus, firstPath, secondPath] = line.split("\t");
      if (rawStatus[0] === "R") {
        return {
          path: secondPath,
          status: "renamed",
          before: fileAtCommit(baseSha, firstPath, cwd),
          after: fileAtCommit(headSha, secondPath, cwd),
        };
      }
      const status = GIT_STATUS[rawStatus[0]];
      if (!status) {
        throw new CliError(`Unsupported git file status: ${rawStatus}`);
      }
      return {
        path: firstPath,
        status,
        before: status === "added" ? "" : fileAtCommit(baseSha, firstPath, cwd),
        after: status === "removed" ? "" : fileAtCommit(headSha, firstPath, cwd),
      };
    });
}

/**
 * Reads every model in the manifest at one commit, so replay compares two
 * complete project states rather than a single patched file.
 */
function projectSqlAtCommit(manifest, sha, projectDir, cwd) {
  const sql = {};
  for (const model of manifest.models) {
    const text = fileAtCommit(sha, `${projectDir}/${model.path}`, cwd);
    if (text.trim()) sql[model.name] = text;
  }
  return sql;
}

/**
 * Chooses which models to replay: every manifest model whose own file changed,
 * plus every model that transitively depends on a changed model.
 */
export function affectedModels(manifest, changedPaths, projectDir) {
  const changedNames = new Set();
  for (const path of changedPaths) {
    const relative = path.startsWith(`${projectDir}/`)
      ? path.slice(projectDir.length + 1)
      : path;
    const model = manifest.byPath.get(relative);
    if (model) changedNames.add(model.name);
  }
  if (changedNames.size === 0) return [];

  const dependsOn = new Map();
  for (const model of manifest.models) {
    dependsOn.set(model.name, new Set());
  }
  for (const model of manifest.models) {
    const sql = model.__sql ?? "";
    for (const match of sql.matchAll(
      /\{\{\s*ref\s*\(\s*['"]([\w.-]+)['"]\s*\)\s*\}\}/g,
    )) {
      dependsOn.get(model.name)?.add(match[1]);
    }
  }

  const affected = new Set(changedNames);
  let grew = true;
  while (grew) {
    grew = false;
    for (const model of manifest.models) {
      if (affected.has(model.name)) continue;
      for (const dependency of dependsOn.get(model.name) ?? []) {
        if (affected.has(dependency)) {
          affected.add(model.name);
          grew = true;
          break;
        }
      }
    }
  }
  return manifest.models
    .filter((model) => affected.has(model.name))
    .map((model) => model.name);
}

async function loadDemoProject(projectDir, cwd) {
  const manifestPath = resolvePath(cwd, projectDir, "shadowgraph.json");
  const manifest = loadManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  return manifest;
}

async function loadSeeds(manifest, projectDir, cwd) {
  const seeds = {};
  for (const [key, source] of Object.entries(manifest.sources)) {
    if (!source.seed) continue;
    const text = await readFile(
      resolvePath(cwd, projectDir, source.seed),
      "utf8",
    );
    seeds[source.table] = {
      key,
      columns: source.columns,
      rows: parseSeedCsv(text, source.columns),
    };
  }
  return seeds;
}

/**
 * Picks a locally installed Ollama model instead of assuming one exists.
 */
export async function detectOllamaModel(config, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.url}/api/tags`, {
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const payload = await response.json();
  const installed = (payload?.models ?? [])
    .map((model) => model?.name)
    .filter((name) => typeof name === "string" && !name.endsWith(":cloud"));
  if (installed.length === 0) throw new Error("No local Ollama model is installed");
  return installed.includes(config.model) ? config.model : installed[0];
}

async function buildAdvisor(options) {
  if (!options.explain) return undefined;
  const base = loadOllamaConfig({ ...process.env, OLLAMA_ENABLED: "true" });
  try {
    const model = await detectOllamaModel(base);
    return new OllamaAdvisor({ ...base, model });
  } catch (error) {
    // An unavailable advisor must never change the deterministic outcome, so
    // this degrades to the disabled advisor rather than failing the run.
    return {
      async summarize() {
        return {
          available: false,
          advisory: true,
          warning: `Ollama advisory unavailable: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        };
      },
    };
  }
}

/**
 * Replays every affected model and merges the results into one comparison, so a
 * breach anywhere in the affected subgraph is visible to the decision policy.
 */
async function replayAffectedModels({ manifest, before, after, seeds, models }) {
  const perModel = [];
  const tables = Object.fromEntries(
    Object.entries(seeds).map(([name, seed]) => [
      name,
      { columns: seed.columns, rows: seed.rows },
    ]),
  );

  for (const modelName of models) {
    if (!before[modelName] || !after[modelName]) continue;
    const plan = buildReplayPlan({
      manifest,
      modelName,
      before,
      after,
      seeds: tables,
    });
    const { replayCounterfactual } = await import("../replay/index.js");
    const result = await replayCounterfactual(plan);
    perModel.push({
      model: modelName,
      dataset: plan.dataset,
      urn: plan.urn,
      before: result.before,
      after: result.after,
      comparison: result.comparison,
      execution: result.execution,
    });
  }
  return perModel;
}

/** Namespaces each model's differences so merged metric names cannot collide. */
function mergeComparisons(perModel) {
  const differences = [];
  for (const entry of perModel) {
    for (const difference of entry.comparison.differences) {
      differences.push({ ...difference, model: entry.model });
    }
  }
  const breached = differences.filter((difference) => difference.breached);
  return {
    equivalent: differences.length === 0,
    passed: breached.length === 0,
    differences,
    breached,
    thresholds: perModel[0]?.comparison.thresholds ?? null,
  };
}

/**
 * Records the decision in DataHub, but only with explicit approval.
 *
 * Without `--record-evidence` this returns the plan and writes nothing. A failed
 * write is reported as a failed write: it never degrades into a claim that the
 * evidence was stored, and it never changes the merge decision, which was
 * already made from the replay and lineage evidence.
 */
async function recordDataHubEvidence({ plan, dataHubClient, approved }) {
  const { graphqlRequest } = await loadDataHubAdapter();
  const client = new DataHubEvidenceClient({
    transport: new DataHubGraphQLDocumentTransport({
      graphql: (query, variables) =>
        graphqlRequest(dataHubClient.config, query, variables),
    }),
  });
  try {
    return await client.write(plan, { dryRun: !approved, approved });
  } catch (error) {
    return {
      dryRun: false,
      approved,
      written: false,
      idempotencyKey: plan.idempotencyKey,
      error: error instanceof Error ? error.message : "DataHub writeback failed",
    };
  }
}

export function parseArgs(argv) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY ?? "",
    base: "",
    head: "",
    pullRequest: 0,
    projectDir: "demo-project",
    output: "outputs/shadowgraph-evidence.json",
    lineageDepth: 3,
    cwd: process.cwd(),
    publishCheck: false,
    recordEvidence: false,
    explain: false,
    detailsUrl: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--repository":
        options.repository = value;
        index += 1;
        break;
      case "--base":
        options.base = value;
        index += 1;
        break;
      case "--head":
        options.head = value;
        index += 1;
        break;
      case "--pull-request":
        options.pullRequest = Number(value);
        index += 1;
        break;
      case "--project-dir":
        options.projectDir = value;
        index += 1;
        break;
      case "--output":
        options.output = value;
        index += 1;
        break;
      case "--lineage-depth":
        options.lineageDepth = Number(value);
        index += 1;
        break;
      case "--details-url":
        options.detailsUrl = value;
        index += 1;
        break;
      case "--publish-check":
        options.publishCheck = true;
        break;
      case "--record-evidence":
        // This is the explicit approval for the only DataHub write ShadowGraph
        // performs. Without it the writeback stays a dry run.
        options.recordEvidence = true;
        break;
      case "--explain":
        options.explain = true;
        break;
      default:
        if (flag.startsWith("--")) {
          throw new CliError(`Unknown option: ${flag}`);
        }
    }
  }
  if (!options.repository) throw new CliError("--repository is required");
  if (!options.base) throw new CliError("--base is required");
  if (!options.head) throw new CliError("--head is required");
  if (!Number.isInteger(options.pullRequest) || options.pullRequest <= 0) {
    throw new CliError("--pull-request must be a positive integer");
  }
  if (
    !Number.isInteger(options.lineageDepth) ||
    options.lineageDepth < 1 ||
    options.lineageDepth > 20
  ) {
    throw new CliError("--lineage-depth must be between 1 and 20");
  }
  return options;
}

/**
 * Runs the full pipeline for one pull request and returns the evidence bundle.
 */
export async function analyzePullRequestCommand(options, { log = () => {} } = {}) {
  const baseSha = resolveCommit(options.base, options.cwd);
  const headSha = resolveCommit(options.head, options.cwd);
  if (baseSha === headSha) {
    throw new CliError("Base and head resolve to the same commit");
  }

  const files = changedFiles(baseSha, headSha, options.cwd);
  const analyzable = files.filter((file) => ANALYZABLE.test(file.path));
  log(
    `Comparing ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}: ${files.length} changed ${
      files.length === 1 ? "file" : "files"
    }, ${analyzable.length} analyzable.`,
  );

  const manifest = await loadDemoProject(options.projectDir, options.cwd);
  const beforeSql = projectSqlAtCommit(
    manifest,
    baseSha,
    options.projectDir,
    options.cwd,
  );
  const afterSql = projectSqlAtCommit(
    manifest,
    headSha,
    options.projectDir,
    options.cwd,
  );
  for (const model of manifest.models) {
    model.__sql = afterSql[model.name] ?? beforeSql[model.name] ?? "";
  }

  const models = affectedModels(
    manifest,
    files.map((file) => file.path),
    options.projectDir,
  );
  log(
    models.length
      ? `Affected models: ${models.join(", ")}.`
      : "No manifest model was affected; replay will not run.",
  );

  let perModel = [];
  let replayError = null;
  if (models.length) {
    try {
      const seeds = await loadSeeds(manifest, options.projectDir, options.cwd);
      perModel = await replayAffectedModels({
        manifest,
        before: beforeSql,
        after: afterSql,
        seeds,
        models,
      });
    } catch (error) {
      replayError = error instanceof Error ? error.message : "Replay failed";
    }
  }

  const { createDataHubClient } = await loadDataHubAdapter();
  const dataHubClient = createDataHubClient();
  const advisor = await buildAdvisor(options);

  // The pipeline owns detection, DataHub resolution, classification, and the
  // decision. Replay is supplied here because the plan is project-specific.
  const merged = perModel.length ? mergeComparisons(perModel) : null;
  const result = await runShadowAnalysis({
    pullRequestInput: {
      repository: options.repository,
      pullRequest: options.pullRequest,
      baseSha,
      headSha,
      files,
    },
    dataHubClient,
    lineageDepth: options.lineageDepth,
    replayPlan: merged ? { merged } : undefined,
    replay: async () => {
      if (replayError) throw new CliError(replayError);
      return { comparison: merged };
    },
    advisor,
  });

  const evidence = {
    ...result,
    replay: merged
      ? { comparison: merged, models: perModel }
      : { comparison: null, models: [], error: replayError },
    dataHub: {
      graphqlUrl: dataHubClient.config.graphqlUrl,
      source: result.context?.source ?? "unavailable",
      lineageDepth: options.lineageDepth,
      warnings: result.context?.warnings ?? [],
    },
    generatedFor: {
      repository: options.repository,
      pullRequest: options.pullRequest,
      baseSha,
      headSha,
    },
  };

  const outputPath = resolvePath(options.cwd, options.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  const checkRun = { ...result.publications.githubCheck };
  if (options.detailsUrl) checkRun.details_url = options.detailsUrl;

  // Publication is opt-in. Without --publish-check this only returns the
  // request that would have been sent.
  const publisher = new GitHubCheckPublisher({
    token: process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
  });
  const publication = await publisher.publish({
    repository: options.repository,
    checkRun,
    dryRun: !options.publishCheck,
  });

  const evidenceRecord = await recordDataHubEvidence({
    plan: result.publications.dataHubEvidence,
    dataHubClient,
    approved: options.recordEvidence,
  });
  evidence.publications = {
    ...evidence.publications,
    dataHubEvidenceRecord: evidenceRecord,
    dryRun: !options.publishCheck && !options.recordEvidence,
  };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  return { evidence, checkRun, publication, evidenceRecord, outputPath, perModel };
}
