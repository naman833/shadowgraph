/**
 * Deterministic change detection for SQL and dbt model files.
 *
 * This module intentionally uses conservative heuristics. It only reports changes
 * that can be supported by the supplied text and leaves ambiguous edits as
 * `logic_change` rather than inventing schema changes.
 */

const SQL_KEYWORDS = new Set([
  "all",
  "and",
  "as",
  "asc",
  "by",
  "case",
  "cast",
  "desc",
  "distinct",
  "else",
  "end",
  "false",
  "from",
  "group",
  "having",
  "in",
  "is",
  "join",
  "limit",
  "not",
  "null",
  "on",
  "or",
  "order",
  "over",
  "partition",
  "select",
  "then",
  "true",
  "union",
  "when",
  "where",
]);

function cleanIdentifier(value) {
  return value?.replace(/^[`"[]|[`"\]]$/g, "").trim();
}

function normalizeSql(sql) {
  return sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractSourceDatasets(sql) {
  const sources = new Set();
  const sourcePattern =
    /\b(?:from|join)\s+(?:\{\{\s*(?:ref|source)\s*\(\s*)?['"`]?([\w.-]+)['"`]?(?:\s*,\s*['"`]([\w.-]+)['"`])?\s*\)?\s*\}\}?/gi;

  for (const match of sql.matchAll(sourcePattern)) {
    const source = match[2] ? `${match[1]}.${match[2]}` : match[1];
    if (source && !["select", "unnest"].includes(source.toLowerCase())) {
      sources.add(source);
    }
  }
  return [...sources];
}

function splitSelectList(sql) {
  const normalized = sql.replace(/--.*$/gm, " ");
  const selectMatch = /\bselect\b([\s\S]*?)\bfrom\b/i.exec(normalized);
  if (!selectMatch) return [];

  const entries = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (const character of selectMatch[1]) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
    } else if (character === "(") {
      depth += 1;
      current += character;
    } else if (character === ")") {
      depth = Math.max(0, depth - 1);
      current += character;
    } else if (character === "," && depth === 0) {
      if (current.trim()) entries.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

function expressionOutputName(expression) {
  const alias = /\bas\s+([`"\[]?[\w$]+[`"\]]?)\s*$/i.exec(expression);
  if (alias) return cleanIdentifier(alias[1]);

  const unqualified = /(?:^|\.)[ `"\[]?([\w$]+)[`"\]]?\s*$/i.exec(expression);
  return unqualified ? cleanIdentifier(unqualified[1]) : null;
}

function expressionSourceColumns(expression) {
  const withoutStrings = expression.replace(/'(?:''|[^'])*'/g, " ");
  const columns = new Set();
  for (const match of withoutStrings.matchAll(/\b([a-zA-Z_][\w$]*)\b/g)) {
    const token = match[1].toLowerCase();
    if (!SQL_KEYWORDS.has(token) && !/^\d/.test(token)) columns.add(match[1]);
  }
  const output = expressionOutputName(expression)?.toLowerCase();
  if (output) columns.delete(output);
  return [...columns];
}

function parseProjection(sql) {
  const projection = new Map();
  for (const expression of splitSelectList(sql)) {
    const output = expressionOutputName(expression);
    if (output) {
      projection.set(output.toLowerCase(), {
        output,
        expression: normalizeSql(expression),
        sourceColumns: expressionSourceColumns(expression),
      });
    }
  }
  return projection;
}

function whereClause(sql) {
  const match = /\bwhere\b([\s\S]*?)(?=\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|$)/i.exec(
    sql,
  );
  return match ? normalizeSql(match[1]) : "";
}

function inferDataset(filePath, after, before) {
  const configured = /--\s*shadowgraph:dataset\s*=\s*([\w.-]+)/i.exec(
    `${after}\n${before}`,
  );
  if (configured) return configured[1];
  const base = filePath.split("/").pop()?.replace(/\.(sql|ddl)$/i, "");
  return base || "unknown";
}

/**
 * @param {{filePath: string, before: string, after: string}} input
 */
export function detectChanges(input) {
  const { filePath, before = "", after = "" } = input;
  if (normalizeSql(before) === normalizeSql(after)) return [];

  const dataset = inferDataset(filePath, after, before);
  const sources = [...new Set([...extractSourceDatasets(before), ...extractSourceDatasets(after)])];
  const changes = [];

  for (const match of after.matchAll(
    /\balter\s+table\s+([`"\[]?[\w.-]+[`"\]]?)\s+rename\s+column\s+([`"\[]?[\w$]+[`"\]]?)\s+to\s+([`"\[]?[\w$]+[`"\]]?)/gi,
  )) {
    changes.push({
      kind: "column_renamed",
      dataset: cleanIdentifier(match[1]),
      column: cleanIdentifier(match[2]),
      newColumn: cleanIdentifier(match[3]),
      sources,
      confidence: 1,
    });
  }

  for (const match of after.matchAll(
    /\balter\s+table\s+([`"\[]?[\w.-]+[`"\]]?)\s+drop\s+column\s+([`"\[]?[\w$]+[`"\]]?)/gi,
  )) {
    changes.push({
      kind: "column_dropped",
      dataset: cleanIdentifier(match[1]),
      column: cleanIdentifier(match[2]),
      sources,
      confidence: 1,
    });
  }

  for (const match of after.matchAll(
    /\balter\s+table\s+([`"\[]?[\w.-]+[`"\]]?)\s+alter\s+column\s+([`"\[]?[\w$]+[`"\]]?)\s+(?:set\s+data\s+)?type\s+([\w(),\s]+)/gi,
  )) {
    changes.push({
      kind: "column_type_changed",
      dataset: cleanIdentifier(match[1]),
      column: cleanIdentifier(match[2]),
      afterType: match[3].trim(),
      sources,
      confidence: 1,
    });
  }

  const beforeProjection = parseProjection(before);
  const afterProjection = parseProjection(after);

  for (const [name, previous] of beforeProjection) {
    if (!afterProjection.has(name)) {
      const rename = [...afterProjection.values()].find(
        (candidate) =>
          candidate.expression !== previous.expression &&
          candidate.sourceColumns.join(",").toLowerCase() ===
            previous.sourceColumns.join(",").toLowerCase(),
      );
      if (rename && !beforeProjection.has(rename.output.toLowerCase())) {
        changes.push({
          kind: "column_renamed",
          dataset,
          column: previous.output,
          newColumn: rename.output,
          sources,
          confidence: 0.9,
        });
      } else {
        changes.push({
          kind: "column_dropped",
          dataset,
          column: previous.output,
          sources,
          confidence: 0.95,
        });
      }
    }
  }

  for (const [name, current] of afterProjection) {
    const previous = beforeProjection.get(name);
    if (!previous || previous.expression === current.expression) continue;
    const beforeCast = /\bcast\s*\([^)]*\bas\s+([\w() ,]+)/i.exec(previous.expression);
    const afterCast = /\bcast\s*\([^)]*\bas\s+([\w() ,]+)/i.exec(current.expression);
    changes.push({
      kind:
        afterCast && afterCast[1] !== beforeCast?.[1]
          ? "column_type_changed"
          : "column_expression_changed",
      dataset,
      column: current.output,
      ...(beforeCast ? { beforeType: beforeCast[1].trim() } : {}),
      ...(afterCast ? { afterType: afterCast[1].trim() } : {}),
      sources,
      confidence: afterCast ? 0.9 : 0.85,
    });
  }

  const beforeWhere = whereClause(before);
  const afterWhere = whereClause(after);
  if (beforeWhere !== afterWhere) {
    changes.push({
      kind: "filter_changed",
      dataset,
      columns: [
        ...new Set([
          ...expressionSourceColumns(beforeWhere),
          ...expressionSourceColumns(afterWhere),
        ]),
      ],
      before: beforeWhere || null,
      after: afterWhere || null,
      sources,
      confidence: 0.95,
    });
  }

  return deduplicateChanges(changes);
}

function deduplicateChanges(changes) {
  const ranked = new Map();
  for (const change of changes) {
    const key = `${change.kind}:${change.dataset}:${change.column ?? ""}:${change.newColumn ?? ""}`;
    const existing = ranked.get(key);
    if (!existing || existing.confidence < change.confidence) ranked.set(key, change);
  }
  return [...ranked.values()];
}

/**
 * Reconstructs the old and new text from a unified diff, then applies the same
 * detector used for repository snapshots.
 *
 * @param {{filePath: string, patch: string}} input
 */
export function detectChangesFromUnifiedDiff(input) {
  const before = [];
  const after = [];
  for (const line of input.patch.split(/\r?\n/)) {
    if (/^(diff --git|index |--- |\+\+\+ |@@)/.test(line)) continue;
    if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith("+")) after.push(line.slice(1));
    else if (line.startsWith(" ")) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    }
  }
  return detectChanges({ filePath: input.filePath, before: before.join("\n"), after: after.join("\n") });
}

