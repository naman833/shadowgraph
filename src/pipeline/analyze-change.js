import { classifyConsumers, decideMerge } from "../analysis/index.js";
import { buildDataHubEvidencePlan } from "../datahub/evidence.js";
import { buildGitHubCheckRun } from "../github/checks.js";
import { analyzePullRequest } from "../github/ingest.js";
import { replayCounterfactual } from "../replay/index.js";

function uniqueConsumers(resolvedChanges) {
  const consumers = new Map();
  for (const resolved of resolvedChanges) {
    for (const consumer of classifyConsumers(
      resolved.consumers ?? [],
      [resolved.change],
    )) {
      const existing = consumers.get(consumer.urn);
      if (!existing) {
        consumers.set(consumer.urn, consumer);
        continue;
      }
      const matchedChanges = [
        ...new Map(
          [...(existing.matchedChanges ?? []), ...(consumer.matchedChanges ?? [])].map(
            (match) => [
              `${match.dataset}:${match.column}:${match.changeKind}`,
              match,
            ],
          ),
        ).values(),
      ];
      consumers.set(consumer.urn, {
        ...existing,
        ...consumer,
        affected: existing.affected || consumer.affected,
        classification:
          existing.affected || consumer.affected
            ? "true_consumer"
            : "lineage_only",
        matchedChanges,
      });
    }
  }
  return [...consumers.values()];
}

function contextCompleteness(analysis, context) {
  const reasons = [];
  if (analysis.changes.length === 0) {
    reasons.push("No supported SQL or schema change was detected");
  }
  if (!context) {
    reasons.push("DataHub identity and lineage context is unavailable");
    return reasons;
  }
  if (context.source !== "live" && context.source !== "deterministic") {
    reasons.push("DataHub context did not come from a live catalog");
  }
  for (const resolved of context.changes ?? []) {
    if (!resolved.identity?.entity) {
      reasons.push(`Dataset identity was not resolved for ${resolved.identity?.hint ?? "a change"}`);
    }
    if (resolved.identity?.ambiguous) {
      reasons.push(`Dataset identity is ambiguous for ${resolved.identity.hint}`);
    }
    if (resolved.identity?.missingColumns?.length) {
      reasons.push(
        `DataHub schema is missing changed columns: ${resolved.identity.missingColumns.join(", ")}`,
      );
    }
    if (resolved.identity?.entity && (resolved.consumers?.length ?? 0) === 0) {
      reasons.push(
        `No downstream lineage evidence was returned for ${resolved.identity.entity.urn}`,
      );
    }
  }
  for (const warning of context.warnings ?? []) {
    if (/\b(?:limit|truncat|timeout|timed out|incomplete)\b/i.test(warning)) {
      reasons.push(`Lineage completeness warning: ${warning}`);
    }
  }
  return [...new Set(reasons)];
}

/**
 * Runs ShadowGraph's local, deterministic analysis pipeline. External writes
 * are intentionally out of scope: the returned GitHub and DataHub objects are
 * commit-scoped publication plans that callers may inspect before approval.
 */
export async function runShadowAnalysis({
  pullRequestInput,
  dataHubClient,
  dataHubContext,
  lineageDepth = 3,
  replayPlan,
  replay = replayCounterfactual,
  advisor,
  policy,
}) {
  const analysis = analyzePullRequest(pullRequestInput);
  let context = dataHubContext ?? null;
  const contextErrors = [];
  if (!context && dataHubClient && analysis.changes.length) {
    try {
      context = await dataHubClient.resolveChangeContext(
        analysis.changes,
        lineageDepth,
      );
    } catch (error) {
      contextErrors.push(
        error instanceof Error ? error.message : "DataHub context resolution failed",
      );
    }
  }

  const consumers = uniqueConsumers(context?.changes ?? []);
  const incompleteReasons = [
    ...contextCompleteness(analysis, context),
    ...contextErrors,
  ];

  let replayResult = null;
  let replayError = null;
  let executionStatus = "not_run";
  if (replayPlan) {
    try {
      replayResult = await replay(replayPlan);
      executionStatus = "passed";
    } catch (error) {
      executionStatus = "failed";
      replayError =
        error instanceof Error ? error.message : "Counterfactual replay failed";
    }
  }

  const decision = decideMerge({
    consumers,
    comparison: replayResult?.comparison ?? null,
    executionStatus,
    evidenceStatus: incompleteReasons.length ? "inconclusive" : "complete",
    inconclusiveReasons: incompleteReasons,
    policy,
  });
  if (replayError) decision.reasons.push(replayError);

  const relatedAssets = [
    ...new Set(
      (context?.changes ?? [])
        .flatMap((resolved) => [
          resolved.identity?.entity?.urn,
          ...(resolved.consumers ?? [])
            .filter((consumer) =>
              consumers.some(
                (classified) =>
                  classified.urn === consumer.urn && classified.affected,
              ),
            )
            .map((consumer) => consumer.urn),
        ])
        .filter(Boolean),
    ),
  ];
  const checkRun = buildGitHubCheckRun({ analysis, decision, consumers });
  const dataHubEvidence = buildDataHubEvidencePlan({
    analysis,
    decision,
    relatedAssets,
  });
  const advisory = advisor
    ? await advisor.summarize({
        analysis,
        context,
        consumers,
        replay: replayResult,
        decision,
      })
    : {
        available: false,
        advisory: true,
        warning: "No local Ollama advisor was configured.",
      };

  return {
    schemaVersion: "1",
    analysis,
    context,
    consumers,
    replay: replayResult,
    decision,
    advisory,
    publications: {
      githubCheck: checkRun,
      dataHubEvidence,
      dryRun: true,
    },
  };
}
