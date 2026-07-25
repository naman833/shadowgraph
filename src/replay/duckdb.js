import { DuckDBInstance } from "@duckdb/node-api";

import { compareSnapshots } from "../analysis/compare-snapshots.js";

export const DEFAULT_REPLAY_LIMITS = Object.freeze({
  maxTables: 8,
  maxInputRows: 10_000,
  maxInputColumns: 100,
  maxResultRows: 100_000,
  maxResultColumns: 100,
  maxSqlBytes: 100_000,
  maxCellBytes: 1_000_000,
  maxExecutionMs: 10_000,
  memoryLimit: "256MB",
});

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COLUMN_TYPE =
  /^(?:BOOLEAN|TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|REAL|FLOAT|DOUBLE|DATE|TIMESTAMP|TIMESTAMPTZ|TIME|VARCHAR(?:\(\d{1,9}\))?|DECIMAL\(\d{1,3}\s*,\s*\d{1,3}\))$/i;
const MUTATING_SQL =
  /\b(?:alter|attach|call|copy|create|delete|detach|drop|export|import|insert|install|load|pragma|replace|set|truncate|update|vacuum)\b/i;

export class ReplayLimitError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ReplayLimitError";
  }
}

function quoteIdentifier(identifier, label = "identifier") {
  if (!IDENTIFIER.test(identifier)) {
    throw new TypeError(`${label} must match ${IDENTIFIER}`);
  }
  return `"${identifier}"`;
}

function normalizeSql(sql, label, limits) {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new TypeError(`${label} must be a non-empty SQL string`);
  }
  if (Buffer.byteLength(sql, "utf8") > limits.maxSqlBytes) {
    throw new ReplayLimitError(`${label} exceeds maxSqlBytes (${limits.maxSqlBytes})`);
  }

  const withoutCommentsAndStrings = sql
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .trim();
  if (!/^(?:select|with)\b/i.test(withoutCommentsAndStrings)) {
    throw new TypeError(`${label} must be a read-only SELECT or WITH query`);
  }
  if (MUTATING_SQL.test(withoutCommentsAndStrings)) {
    throw new TypeError(`${label} contains a statement not allowed during replay`);
  }

  // Statement separators are counted on the stripped text so that a semicolon
  // inside a comment or string literal is not mistaken for a second statement.
  if (withoutCommentsAndStrings.replace(/;\s*$/, "").includes(";")) {
    throw new TypeError(`${label} must contain exactly one statement`);
  }
  return sql.trim().replace(/;\s*$/, "");
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeLimits(overrides = {}) {
  const limits = { ...DEFAULT_REPLAY_LIMITS, ...overrides };
  for (const key of [
    "maxTables",
    "maxInputRows",
    "maxInputColumns",
    "maxResultRows",
    "maxResultColumns",
    "maxSqlBytes",
    "maxCellBytes",
    "maxExecutionMs",
  ]) {
    positiveInteger(limits[key], `limits.${key}`);
  }
  if (!/^\d+(?:\.\d+)?(?:KB|MB|GB)$/i.test(limits.memoryLimit)) {
    throw new TypeError("limits.memoryLimit must be a DuckDB byte-size such as 256MB");
  }
  return limits;
}

function validateCell(value, limits, location) {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    typeof value !== "boolean"
  ) {
    throw new TypeError(`${location} must be null, a string, a number, a bigint, or a boolean`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`${location} must be finite`);
  }
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") > limits.maxCellBytes) {
    throw new ReplayLimitError(`${location} exceeds maxCellBytes (${limits.maxCellBytes})`);
  }
}

function normalizeTables(tables, limits) {
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new TypeError("tables must contain at least one source table");
  }
  if (tables.length > limits.maxTables) {
    throw new ReplayLimitError(`tables exceeds maxTables (${limits.maxTables})`);
  }

  let inputRows = 0;
  let inputColumns = 0;
  return tables.map((table, tableIndex) => {
    const name = quoteIdentifier(table?.name, `tables[${tableIndex}].name`);
    const columnEntries = Object.entries(table?.columns ?? {});
    if (columnEntries.length === 0) {
      throw new TypeError(`tables[${tableIndex}].columns must not be empty`);
    }
    inputColumns += columnEntries.length;
    if (inputColumns > limits.maxInputColumns) {
      throw new ReplayLimitError(
        `source columns exceed maxInputColumns (${limits.maxInputColumns})`,
      );
    }
    const columns = columnEntries.map(([columnName, columnType]) => {
      const quotedName = quoteIdentifier(
        columnName,
        `tables[${tableIndex}].columns column name`,
      );
      if (typeof columnType !== "string" || !COLUMN_TYPE.test(columnType.trim())) {
        throw new TypeError(
          `tables[${tableIndex}].columns.${columnName} has an unsupported type`,
        );
      }
      return {
        rawName: columnName,
        quotedName,
        type: columnType.trim().toUpperCase(),
      };
    });

    const rows = table?.rows ?? [];
    if (!Array.isArray(rows)) {
      throw new TypeError(`tables[${tableIndex}].rows must be an array`);
    }
    inputRows += rows.length;
    if (inputRows > limits.maxInputRows) {
      throw new ReplayLimitError(`source rows exceed maxInputRows (${limits.maxInputRows})`);
    }
    const values = rows.map((row, rowIndex) => {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw new TypeError(`tables[${tableIndex}].rows[${rowIndex}] must be an object`);
      }
      const unknown = Object.keys(row).filter(
        (key) => !columns.some((column) => column.rawName === key),
      );
      if (unknown.length > 0) {
        throw new TypeError(
          `tables[${tableIndex}].rows[${rowIndex}] has unknown columns: ${unknown.join(", ")}`,
        );
      }
      return columns.map((column) => {
        const value = row[column.rawName] ?? null;
        validateCell(
          value,
          limits,
          `tables[${tableIndex}].rows[${rowIndex}].${column.rawName}`,
        );
        return value;
      });
    });

    return { name, columns, values };
  });
}

function normalizeExpressions(expressions, label, limits) {
  if (expressions === undefined) return {};
  if (expressions === null || typeof expressions !== "object" || Array.isArray(expressions)) {
    throw new TypeError(`snapshot.${label} must be an object`);
  }

  return Object.fromEntries(
    Object.entries(expressions).map(([name, sql]) => {
      quoteIdentifier(name, `snapshot.${label} name`);
      if (typeof sql !== "string" || sql.trim() === "") {
        throw new TypeError(`snapshot.${label}.${name} must be a SQL expression`);
      }
      if (Buffer.byteLength(sql, "utf8") > limits.maxSqlBytes || /;/.test(sql)) {
        throw new ReplayLimitError(`snapshot.${label}.${name} is not a bounded expression`);
      }
      return [name, sql.trim()];
    }),
  );
}

async function withTimeout(connection, maxExecutionMs, operation) {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    connection.interrupt();
  }, maxExecutionMs);
  try {
    const result = await operation();
    if (timedOut) {
      throw new ReplayLimitError(
        `DuckDB replay exceeded maxExecutionMs (${maxExecutionMs})`,
      );
    }
    return result;
  } catch (error) {
    if (timedOut) {
      throw new ReplayLimitError(`DuckDB replay exceeded maxExecutionMs (${maxExecutionMs})`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readRows(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjectsJson();
}

function asFiniteNumber(value, label) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new TypeError(`${label} did not produce a finite numeric value`);
}

function asNullableFiniteNumber(value, label) {
  return value === null ? null : asFiniteNumber(value, label);
}

async function createSourceTables(connection, tables) {
  for (const table of tables) {
    const definitions = table.columns
      .map((column) => `${column.quotedName} ${column.type}`)
      .join(", ");
    await connection.run(`CREATE TABLE ${table.name} (${definitions})`);
    if (table.values.length === 0) continue;

    const placeholders = table.columns.map(() => "?").join(", ");
    for (const values of table.values) {
      await connection.run(
        `INSERT INTO ${table.name} VALUES (${placeholders})`,
        values,
      );
    }
  }
}

async function snapshotResult(connection, tableName, snapshot, limits) {
  const described = await readRows(connection, `DESCRIBE SELECT * FROM ${tableName}`);
  if (described.length > limits.maxResultColumns) {
    throw new ReplayLimitError(
      `${tableName} exceeds maxResultColumns (${limits.maxResultColumns})`,
    );
  }
  const schema = Object.fromEntries(
    described.map((column) => [column.column_name, column.column_type]),
  );
  const quotedColumns = described.map((column) =>
    quoteIdentifier(column.column_name, `${tableName} result column`),
  );

  const aggregateExpressions = [
    "COUNT(*) AS __row_count",
    ...quotedColumns.map(
      (column, index) =>
        `COALESCE(100.0 * COUNT(*) FILTER (WHERE ${column} IS NULL) / NULLIF(COUNT(*), 0), 0.0) AS "__null_${index}"`,
    ),
    ...Object.entries(snapshot.metrics).map(
      ([name, expression]) => `(${expression}) AS ${quoteIdentifier(name)}`,
    ),
    ...Object.entries(snapshot.distributions).map(
      ([name, expression]) => `(${expression}) AS ${quoteIdentifier(name)}`,
    ),
  ];
  const [aggregates] = await readRows(
    connection,
    `SELECT ${aggregateExpressions.join(", ")} FROM ${tableName}`,
  );
  const rowCount = asFiniteNumber(aggregates.__row_count, `${tableName}.rowCount`);
  const nullRates = Object.fromEntries(
    described.map((column, index) => [
      column.column_name,
      asFiniteNumber(aggregates[`__null_${index}`], `${tableName}.${column.column_name} null rate`),
    ]),
  );
  const readExpressionMap = (expressions, label) =>
    Object.fromEntries(
      Object.keys(expressions).map((name) => [
        name,
        asNullableFiniteNumber(aggregates[name], `${tableName}.${label}.${name}`),
      ]),
    );

  return {
    schema,
    rowCount,
    nullRates,
    metrics: readExpressionMap(snapshot.metrics, "metrics"),
    distributions: readExpressionMap(snapshot.distributions, "distributions"),
  };
}

async function materializeResult(connection, tableName, sql, limits) {
  await connection.run(
    `CREATE TEMP TABLE ${tableName} AS SELECT * FROM (${sql}) AS replay_query LIMIT ${
      limits.maxResultRows + 1
    }`,
  );
  const [{ row_count: rawRowCount }] = await readRows(
    connection,
    `SELECT COUNT(*) AS row_count FROM ${tableName}`,
  );
  const rowCount = asFiniteNumber(rawRowCount, `${tableName}.rowCount`);
  if (rowCount > limits.maxResultRows) {
    throw new ReplayLimitError(`${tableName} exceeds maxResultRows (${limits.maxResultRows})`);
  }
}

/**
 * Executes before and after read-only transformations over the same bounded inputs.
 * Snapshot metric and distribution values are trusted DuckDB aggregate expressions.
 */
export async function replayCounterfactual({
  tables,
  beforeSql,
  afterSql,
  snapshot = {},
  thresholds,
  limits: limitOverrides,
}) {
  const limits = normalizeLimits(limitOverrides);
  const normalizedTables = normalizeTables(tables, limits);
  const before = normalizeSql(beforeSql, "beforeSql", limits);
  const after = normalizeSql(afterSql, "afterSql", limits);
  const normalizedSnapshot = {
    metrics: normalizeExpressions(snapshot.metrics, "metrics", limits),
    distributions: normalizeExpressions(
      snapshot.distributions,
      "distributions",
      limits,
    ),
  };
  const expressionCount =
    Object.keys(normalizedSnapshot.metrics).length +
    Object.keys(normalizedSnapshot.distributions).length;
  if (expressionCount > limits.maxResultColumns) {
    throw new ReplayLimitError(
      `snapshot expressions exceed maxResultColumns (${limits.maxResultColumns})`,
    );
  }

  const instance = await DuckDBInstance.create(":memory:", {
    threads: "1",
    memory_limit: limits.memoryLimit,
    enable_external_access: "false",
    allow_unsigned_extensions: "false",
  });
  const connection = await instance.connect();
  try {
    const startedAt = Date.now();
    const { beforeSnapshot, afterSnapshot } = await withTimeout(
      connection,
      limits.maxExecutionMs,
      async () => {
        await createSourceTables(connection, normalizedTables);
        await materializeResult(connection, "before_result", before, limits);
        await materializeResult(connection, "after_result", after, limits);
        return {
          beforeSnapshot: await snapshotResult(
            connection,
            "before_result",
            normalizedSnapshot,
            limits,
          ),
          afterSnapshot: await snapshotResult(
            connection,
            "after_result",
            normalizedSnapshot,
            limits,
          ),
        };
      },
    );

    return {
      before: beforeSnapshot,
      after: afterSnapshot,
      comparison: compareSnapshots(beforeSnapshot, afterSnapshot, thresholds),
      execution: {
        engine: "duckdb",
        durationMs: Date.now() - startedAt,
        sourceTables: normalizedTables.length,
        sourceRows: normalizedTables.reduce((total, table) => total + table.values.length, 0),
        limits,
      },
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
