function normalizeColumn(column) {
  return column.toLowerCase().replace(/^[`"[]|[`"\]]$/g, "");
}

function sqlIdentifiers(sql = "") {
  const scrubbed = sql
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, " ");
  return new Set(
    [...scrubbed.matchAll(/\b[a-zA-Z_][\w$]*\b/g)].map((match) =>
      normalizeColumn(match[0]),
    ),
  );
}

function changedColumns(change) {
  return [
    ...(change.column ? [change.column] : []),
    ...(change.columns ?? []),
  ].map(normalizeColumn);
}

function lineageReferences(consumer, dataset, column) {
  return (consumer.columnLineage ?? []).some((edge) => {
    const upstreamDataset = (edge.upstreamDataset ?? edge.dataset ?? "").toLowerCase();
    const upstreamColumn = normalizeColumn(edge.upstreamColumn ?? edge.column ?? "");
    return (
      upstreamColumn === column &&
      (!dataset || !upstreamDataset || upstreamDataset === dataset.toLowerCase())
    );
  });
}

/**
 * Separates real downstream consumers from assets which merely share dataset
 * lineage. Column-level lineage is authoritative; SQL parsing and declared
 * inputColumns are deterministic fallbacks.
 *
 * @param {Array<Record<string, any>>} consumers
 * @param {Array<Record<string, any>>} changes
 */
export function classifyConsumers(consumers, changes) {
  return consumers.map((consumer) => {
    const identifiers = sqlIdentifiers(consumer.sql);
    const declared = new Set((consumer.inputColumns ?? []).map(normalizeColumn));
    const matches = [];

    for (const change of changes) {
      const columns = changedColumns(change);
      for (const column of columns) {
        let evidence = null;
        if (lineageReferences(consumer, change.dataset, column)) {
          evidence = "column_lineage";
        } else if (declared.has(column)) {
          evidence = "declared_input";
        } else if (identifiers.has(column)) {
          evidence = "sql_reference";
        }
        if (evidence) {
          matches.push({
            dataset: change.dataset,
            column,
            changeKind: change.kind,
            evidence,
          });
        }
      }
    }

    const uniqueMatches = [
      ...new Map(
        matches.map((match) => [
          `${match.dataset}:${match.column}:${match.changeKind}`,
          match,
        ]),
      ).values(),
    ];

    return {
      ...consumer,
      affected: uniqueMatches.length > 0,
      classification: uniqueMatches.length ? "true_consumer" : "lineage_only",
      matchedChanges: uniqueMatches,
      reason: uniqueMatches.length
        ? `References ${[...new Set(uniqueMatches.map((match) => match.column))].join(", ")}`
        : "No changed column is referenced",
    };
  });
}

export function onlyAffectedConsumers(consumers, changes) {
  return classifyConsumers(consumers, changes).filter((consumer) => consumer.affected);
}

