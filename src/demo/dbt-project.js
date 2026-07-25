/**
 * Minimal dbt-compatible compiler for the ShadowGraph demo project.
 *
 * This is deliberately not a dbt implementation. It resolves only the two Jinja
 * constructs the demo project uses -- `{{ ref('model') }}` and
 * `{{ source('schema', 'table') }}` -- so a model's before/after text can be
 * flattened into one bounded, read-only DuckDB query. Anything else is an
 * error rather than a silent pass, because an unresolved template would make
 * the replay evidence meaningless.
 */

const REF = /\{\{\s*ref\s*\(\s*['"]([\w.-]+)['"]\s*\)\s*\}\}/g;
const SOURCE =
  /\{\{\s*source\s*\(\s*['"]([\w.-]+)['"]\s*,\s*['"]([\w.-]+)['"]\s*\)\s*\}\}/g;
const REMAINING_JINJA = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/;
const MAX_MODELS = 25;

export class DemoProjectError extends Error {
  constructor(message) {
    super(message);
    this.name = "DemoProjectError";
    this.code = "INVALID_DEMO_PROJECT";
  }
}

function assert(condition, message) {
  if (!condition) throw new DemoProjectError(message);
}

/**
 * @param {Record<string, any>} manifest Parsed `demo-project/shadowgraph.json`.
 */
export function loadManifest(manifest) {
  assert(manifest && typeof manifest === "object", "Manifest must be an object");
  assert(manifest.version === "1", "Unsupported manifest version");
  assert(Array.isArray(manifest.models) && manifest.models.length > 0, "Manifest must declare models");
  assert(manifest.models.length <= MAX_MODELS, `Manifest exceeds ${MAX_MODELS} models`);
  assert(
    manifest.sources && typeof manifest.sources === "object",
    "Manifest must declare sources",
  );

  const byName = new Map();
  const byPath = new Map();
  for (const model of manifest.models) {
    assert(typeof model.name === "string" && model.name, "Each model needs a name");
    assert(typeof model.path === "string" && model.path, `Model ${model.name} needs a path`);
    assert(!byName.has(model.name), `Duplicate model: ${model.name}`);
    byName.set(model.name, model);
    byPath.set(model.path, model);
  }
  return { ...manifest, byName, byPath };
}

/** Resolves `{{ source(...) }}` to the flat table name the seed is loaded as. */
function sourceTableName(manifest, schema, table) {
  const key = `${schema}.${table}`;
  const source = manifest.sources[key];
  assert(source, `Manifest does not declare source ${key}`);
  assert(typeof source.table === "string" && source.table, `Source ${key} needs a table name`);
  return source.table;
}

function directDependencies(sql) {
  const refs = new Set();
  for (const match of sql.matchAll(REF)) refs.add(match[1]);
  return [...refs];
}

/**
 * Rewrites one model body into plain SQL against CTE/table names.
 */
function inlineTemplates(manifest, sql) {
  const rewritten = sql
    .replace(REF, (_match, name) => {
      assert(manifest.byName.has(name), `Model references unknown ref: ${name}`);
      return name;
    })
    .replace(SOURCE, (_match, schema, table) =>
      sourceTableName(manifest, schema, table),
    );
  assert(
    !REMAINING_JINJA.test(rewritten),
    "Demo compiler supports only ref() and source() templates",
  );
  return rewritten.trim().replace(/;\s*$/, "");
}

/**
 * Flattens a model and its transitive `ref()` dependencies into a single
 * `WITH ... SELECT` statement. Cycles are rejected rather than truncated.
 *
 * @param {ReturnType<typeof loadManifest>} manifest
 * @param {string} modelName
 * @param {Record<string, string>} sqlByModel Model name to raw model SQL.
 */
export function compileModel(manifest, modelName, sqlByModel) {
  assert(manifest.byName.has(modelName), `Unknown model: ${modelName}`);

  const order = [];
  const state = new Map();
  const visit = (name) => {
    const seen = state.get(name);
    if (seen === "done") return;
    assert(seen !== "visiting", `Model dependency cycle at ${name}`);
    state.set(name, "visiting");

    const sql = sqlByModel[name];
    assert(typeof sql === "string" && sql.trim(), `Missing SQL for model ${name}`);
    for (const dependency of directDependencies(sql)) visit(dependency);

    state.set(name, "done");
    order.push(name);
  };
  visit(modelName);

  const dependencies = order.filter((name) => name !== modelName);
  const target = inlineTemplates(manifest, sqlByModel[modelName]);
  if (dependencies.length === 0) return target;

  const ctes = dependencies
    .map((name) => `${name} AS (\n${inlineTemplates(manifest, sqlByModel[name])}\n)`)
    .join(",\n");
  return `WITH ${ctes}\n${target}`;
}

const CSV_NEWLINE = /\r?\n/;

/**
 * Parses the demo seed CSV. Only unquoted scalar fields are supported, which is
 * all the committed seed uses; a quote character is an error rather than a
 * silently mis-parsed row.
 */
export function parseSeedCsv(text, columnTypes) {
  const lines = text.split(CSV_NEWLINE).filter((line) => line.trim() !== "");
  assert(lines.length > 1, "Seed CSV must contain a header and at least one row");
  assert(!text.includes('"'), "Seed CSV must not contain quoted fields");

  const header = lines[0].split(",").map((name) => name.trim());
  for (const name of header) {
    assert(
      Object.prototype.hasOwnProperty.call(columnTypes, name),
      `Seed column ${name} is not declared in the manifest`,
    );
  }

  return lines.slice(1).map((line, index) => {
    const fields = line.split(",");
    assert(
      fields.length === header.length,
      `Seed row ${index + 1} has ${fields.length} fields, expected ${header.length}`,
    );
    const row = {};
    header.forEach((name, position) => {
      const raw = fields[position].trim();
      const type = columnTypes[name].toUpperCase();
      if (raw === "") {
        row[name] = null;
      } else if (type === "BIGINT" || type === "INTEGER") {
        // DuckDB integer columns are bound as BigInt to avoid precision loss.
        row[name] = BigInt(raw);
      } else if (type === "DOUBLE" || type === "REAL" || type === "FLOAT") {
        const value = Number(raw);
        assert(Number.isFinite(value), `Seed row ${index + 1} column ${name} is not numeric`);
        row[name] = value;
      } else {
        row[name] = raw;
      }
    });
    return row;
  });
}

/**
 * Builds a bounded replay plan for one model from before/after model text.
 *
 * @param {{
 *   manifest: ReturnType<typeof loadManifest>,
 *   modelName: string,
 *   before: Record<string, string>,
 *   after: Record<string, string>,
 *   seeds: Record<string, {columns: Record<string, string>, rows: Array<Record<string, unknown>>}>,
 * }} input
 */
export function buildReplayPlan({ manifest, modelName, before, after, seeds }) {
  const model = manifest.byName.get(modelName);
  assert(model, `Unknown model: ${modelName}`);

  const beforeSql = compileModel(manifest, modelName, before);
  const afterSql = compileModel(manifest, modelName, after);
  const tables = Object.entries(seeds).map(([name, table]) => ({
    name,
    columns: table.columns,
    rows: table.rows,
  }));
  assert(tables.length > 0, "Replay requires at least one seeded source table");

  return {
    model: modelName,
    dataset: model.dataset,
    urn: model.urn,
    tables,
    beforeSql,
    afterSql,
    snapshot: {
      metrics: model.replay?.metrics ?? {},
      distributions: model.replay?.distributions ?? {},
    },
  };
}
