import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  affectedModels,
  changedFiles,
  CliError,
  detectOllamaModel,
  parseArgs,
  resolveCommit,
} from "../src/cli/analyze-pr.js";

function baseArgs(extra = []) {
  return [
    "--repository",
    "acme/analytics",
    "--base",
    "main",
    "--head",
    "topic",
    "--pull-request",
    "7",
    ...extra,
  ];
}

test("parseArgs reads every documented flag", () => {
  const options = parseArgs(
    baseArgs([
      "--project-dir",
      "warehouse",
      "--output",
      "outputs/evidence.json",
      "--lineage-depth",
      "1",
      "--details-url",
      "https://ci.example/run/1",
      "--publish-check",
      "--explain",
    ]),
  );

  assert.equal(options.repository, "acme/analytics");
  assert.equal(options.base, "main");
  assert.equal(options.head, "topic");
  assert.equal(options.pullRequest, 7);
  assert.equal(options.projectDir, "warehouse");
  assert.equal(options.output, "outputs/evidence.json");
  assert.equal(options.lineageDepth, 1);
  assert.equal(options.detailsUrl, "https://ci.example/run/1");
  assert.equal(options.publishCheck, true);
  assert.equal(options.explain, true);
});

test("parseArgs keeps external writes disabled by default", () => {
  const options = parseArgs(baseArgs());

  assert.equal(options.publishCheck, false);
  assert.equal(options.explain, false);
  assert.equal(options.lineageDepth, 3);
  assert.equal(options.projectDir, "demo-project");
});

test("parseArgs falls back to GITHUB_REPOSITORY so CI need not pass it", (t) => {
  const inherited = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = "acme/from-environment";
  t.after(() => {
    if (inherited === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = inherited;
  });

  const options = parseArgs([
    "--base",
    "main",
    "--head",
    "topic",
    "--pull-request",
    "7",
  ]);

  assert.equal(options.repository, "acme/from-environment");
});

test("parseArgs rejects missing, malformed, and unknown inputs", (t) => {
  // parseArgs defaults --repository from GITHUB_REPOSITORY, which CI sets, so
  // the variable is cleared here to test the flag rather than the environment.
  const inherited = process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_REPOSITORY;
  t.after(() => {
    if (inherited === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = inherited;
  });

  assert.throws(
    () => parseArgs(["--base", "main", "--head", "topic", "--pull-request", "1"]),
    /--repository is required/,
  );
  assert.throws(
    () => parseArgs(["--repository", "a/b", "--head", "topic", "--pull-request", "1"]),
    /--base is required/,
  );
  assert.throws(
    () => parseArgs(["--repository", "a/b", "--base", "main", "--pull-request", "1"]),
    /--head is required/,
  );
  for (const value of ["0", "-3", "1.5", "abc"]) {
    assert.throws(
      () =>
        parseArgs([
          "--repository",
          "a/b",
          "--base",
          "main",
          "--head",
          "topic",
          "--pull-request",
          value,
        ]),
      /--pull-request must be a positive integer/,
      `pull request ${value} should be rejected`,
    );
  }
  for (const value of ["0", "21", "2.5"]) {
    assert.throws(
      () => parseArgs(baseArgs(["--lineage-depth", value])),
      /--lineage-depth must be between 1 and 20/,
      `lineage depth ${value} should be rejected`,
    );
  }
  assert.throws(() => parseArgs(baseArgs(["--publish-evidence"])), /Unknown option/);
});

const MANIFEST = {
  byPath: new Map([
    ["models/staging/stg_orders.sql", { name: "stg_orders" }],
    ["models/marts/fct_order_revenue.sql", { name: "fct_order_revenue" }],
    ["models/features/order_discount_features.sql", { name: "order_discount_features" }],
    ["models/marts/dim_customer.sql", { name: "dim_customer" }],
  ]),
  models: [
    { name: "stg_orders", path: "models/staging/stg_orders.sql", __sql: "select 1" },
    {
      name: "fct_order_revenue",
      path: "models/marts/fct_order_revenue.sql",
      __sql: "select * from {{ ref('stg_orders') }}",
    },
    {
      name: "order_discount_features",
      path: "models/features/order_discount_features.sql",
      __sql: "select * from {{ ref('fct_order_revenue') }}",
    },
    {
      name: "dim_customer",
      path: "models/marts/dim_customer.sql",
      __sql: "select * from {{ source('raw', 'customers') }}",
    },
  ],
};

test("affectedModels follows ref() edges transitively", () => {
  const affected = affectedModels(
    MANIFEST,
    ["demo-project/models/staging/stg_orders.sql"],
    "demo-project",
  );

  assert.deepEqual(affected, [
    "stg_orders",
    "fct_order_revenue",
    "order_discount_features",
  ]);
});

test("affectedModels excludes models on an unrelated branch of the graph", () => {
  const affected = affectedModels(
    MANIFEST,
    ["demo-project/models/marts/dim_customer.sql"],
    "demo-project",
  );

  assert.deepEqual(affected, ["dim_customer"]);
});

test("affectedModels ignores files outside the project", () => {
  assert.deepEqual(
    affectedModels(MANIFEST, ["README.md", "src/cli/analyze-pr.js"], "demo-project"),
    [],
  );
});

/**
 * The diff walk is the boundary between Git and the pipeline, so it is exercised
 * against a real repository rather than a stub.
 */
async function fixtureRepo() {
  const dir = await mkdtemp(join(tmpdir(), "shadowgraph-cli-"));
  const run = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  run("init", "--quiet", "--initial-branch", "main");
  run("config", "user.name", "Fixture");
  run("config", "user.email", "fixture@example.invalid");
  return { dir, run };
}

test("changedFiles reports content on both sides of two immutable commits", async () => {
  const { dir, run } = await fixtureRepo();
  await mkdir(join(dir, "models"), { recursive: true });
  await writeFile(join(dir, "models/kept.sql"), "select 1\n");
  await writeFile(join(dir, "models/gone.sql"), "select 2\n");
  await writeFile(join(dir, "models/moved.sql"), "select 3 as stable_body\n");
  run("add", ".");
  run("commit", "--quiet", "-m", "base");
  const baseSha = run("rev-parse", "HEAD");

  await writeFile(join(dir, "models/kept.sql"), "select 10\n");
  await writeFile(join(dir, "models/added.sql"), "select 4\n");
  run("rm", "--quiet", "models/gone.sql");
  run("mv", "models/moved.sql", "models/renamed.sql");
  run("add", ".");
  run("commit", "--quiet", "-m", "head");
  const headSha = run("rev-parse", "HEAD");

  const files = changedFiles(baseSha, headSha, dir);
  const byPath = new Map(files.map((file) => [file.path, file]));

  assert.equal(byPath.get("models/kept.sql").status, "modified");
  assert.equal(byPath.get("models/kept.sql").before, "select 1\n");
  assert.equal(byPath.get("models/kept.sql").after, "select 10\n");

  assert.equal(byPath.get("models/added.sql").status, "added");
  assert.equal(byPath.get("models/added.sql").before, "");
  assert.equal(byPath.get("models/added.sql").after, "select 4\n");

  assert.equal(byPath.get("models/gone.sql").status, "removed");
  assert.equal(byPath.get("models/gone.sql").before, "select 2\n");
  assert.equal(byPath.get("models/gone.sql").after, "");

  const renamed = byPath.get("models/renamed.sql");
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.before, "select 3 as stable_body\n");
  assert.equal(renamed.after, "select 3 as stable_body\n");
});

test("resolveCommit pins a branch name to its commit and rejects unknown refs", async () => {
  const { dir, run } = await fixtureRepo();
  await writeFile(join(dir, "a.sql"), "select 1\n");
  run("add", ".");
  run("commit", "--quiet", "-m", "base");

  assert.equal(resolveCommit("main", dir), run("rev-parse", "HEAD"));
  assert.throws(() => resolveCommit("no-such-branch", dir), CliError);
});

function tagsResponse(names) {
  return {
    ok: true,
    async json() {
      return { models: names.map((name) => ({ name })) };
    },
  };
}

const OLLAMA_CONFIG = { url: "http://ollama.test", model: "qwen2.5:7b", timeoutMs: 500 };

test("detectOllamaModel prefers the configured model when it is installed", async () => {
  const model = await detectOllamaModel(OLLAMA_CONFIG, async () =>
    tagsResponse(["llama3.2:3b", "qwen2.5:7b"]),
  );

  assert.equal(model, "qwen2.5:7b");
});

test("detectOllamaModel falls back to an installed model instead of assuming one", async () => {
  const model = await detectOllamaModel(OLLAMA_CONFIG, async () =>
    tagsResponse(["mistral:7b"]),
  );

  assert.equal(model, "mistral:7b");
});

test("detectOllamaModel ignores remote models that are not installed locally", async () => {
  await assert.rejects(
    detectOllamaModel(OLLAMA_CONFIG, async () => tagsResponse(["qwen3.5:cloud"])),
    /No local Ollama model is installed/,
  );
});

test("detectOllamaModel reports an unreachable or empty Ollama host", async () => {
  await assert.rejects(
    detectOllamaModel(OLLAMA_CONFIG, async () => ({ ok: false, status: 503 })),
    /HTTP 503/,
  );
  await assert.rejects(
    detectOllamaModel(OLLAMA_CONFIG, async () => tagsResponse([])),
    /No local Ollama model is installed/,
  );
});
