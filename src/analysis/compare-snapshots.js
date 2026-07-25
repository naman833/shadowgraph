const DEFAULT_THRESHOLDS = {
  rowCountPercent: 5,
  nullRatePoints: 2,
  numericPercent: 5,
  distributionDistance: 0.1,
};

function percentChange(before, after) {
  if (before === after) return 0;
  if (before === 0) return Number.POSITIVE_INFINITY;
  return ((after - before) / Math.abs(before)) * 100;
}

function compareMap(before, after, category, threshold, unit) {
  const differences = [];
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const previous = before?.[key];
    const current = after?.[key];
    if (previous === current) continue;
    if (typeof previous !== "number" || typeof current !== "number") {
      differences.push({
        category,
        metric: key,
        before: previous ?? null,
        after: current ?? null,
        magnitude: null,
        unit,
        breached: true,
      });
      continue;
    }
    const magnitude =
      unit === "percentage_points" ? current - previous : percentChange(previous, current);
    differences.push({
      category,
      metric: key,
      before: previous,
      after: current,
      magnitude,
      unit,
      breached: Math.abs(magnitude) > threshold,
    });
  }
  return differences;
}

/**
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [overrides]
 */
export function compareSnapshots(before, after, overrides = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...overrides };
  const differences = [];

  const beforeColumns = before.schema ?? {};
  const afterColumns = after.schema ?? {};
  for (const column of new Set([...Object.keys(beforeColumns), ...Object.keys(afterColumns)])) {
    if (!(column in beforeColumns)) {
      differences.push({
        category: "schema",
        metric: column,
        before: null,
        after: afterColumns[column],
        change: "added",
        breached: false,
      });
    } else if (!(column in afterColumns)) {
      differences.push({
        category: "schema",
        metric: column,
        before: beforeColumns[column],
        after: null,
        change: "dropped",
        breached: true,
      });
    } else if (beforeColumns[column] !== afterColumns[column]) {
      differences.push({
        category: "schema",
        metric: column,
        before: beforeColumns[column],
        after: afterColumns[column],
        change: "type_changed",
        breached: true,
      });
    }
  }

  if (before.rowCount !== after.rowCount) {
    const magnitude = percentChange(before.rowCount, after.rowCount);
    differences.push({
      category: "volume",
      metric: "rowCount",
      before: before.rowCount,
      after: after.rowCount,
      magnitude,
      unit: "percent",
      breached: Math.abs(magnitude) > thresholds.rowCountPercent,
    });
  }

  differences.push(
    ...compareMap(
      before.nullRates,
      after.nullRates,
      "null_rate",
      thresholds.nullRatePoints,
      "percentage_points",
    ),
    ...compareMap(
      before.metrics,
      after.metrics,
      "metric",
      thresholds.numericPercent,
      "percent",
    ),
    ...compareMap(
      before.distributions,
      after.distributions,
      "distribution",
      thresholds.distributionDistance * 100,
      "percent",
    ),
  );

  const breached = differences.filter((difference) => difference.breached);
  return {
    equivalent: differences.length === 0,
    passed: breached.length === 0,
    differences,
    breached,
    thresholds,
  };
}

export { DEFAULT_THRESHOLDS };

