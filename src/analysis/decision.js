const LEVELS = ["none", "low", "medium", "high", "critical"];

function maxSeverity(left, right) {
  return LEVELS[Math.max(LEVELS.indexOf(left), LEVELS.indexOf(right))];
}

function impactSeverity(consumer) {
  if (!consumer.affected) return "none";
  const type = (consumer.type ?? "").toLowerCase();
  const tier = (consumer.tier ?? "").toLowerCase();
  if (consumer.production === true && ["mlmodel", "ml_model", "feature_table"].includes(type)) {
    return "critical";
  }
  if (tier === "tier_1" || tier === "critical" || consumer.businessCritical === true) {
    return "critical";
  }
  if (["dashboard", "chart", "data_product", "mlmodel", "ml_model"].includes(type)) {
    return "high";
  }
  return "medium";
}

function differenceSeverity(difference) {
  if (!difference.breached) return "none";
  if (difference.category === "schema") return "critical";
  const magnitude = Math.abs(difference.magnitude ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(magnitude) || magnitude >= 25) return "critical";
  if (magnitude >= 10) return "high";
  return "medium";
}

/**
 * Produces a stable CI decision from static lineage analysis and optional
 * counterfactual execution evidence.
 *
 * @param {{
 *  consumers?: Array<Record<string, any>>,
 *  comparison?: Record<string, any> | null,
 *  executionStatus?: "passed" | "failed" | "not_run",
 *  evidenceStatus?: "complete" | "inconclusive",
 *  inconclusiveReasons?: string[],
 *  policy?: {blockAt?: "medium" | "high" | "critical", requireExecution?: boolean}
 * }} input
 */
export function decideMerge(input) {
  const {
    consumers = [],
    comparison = null,
    executionStatus = comparison ? "passed" : "not_run",
    evidenceStatus = "complete",
    inconclusiveReasons = [],
    policy = {},
  } = input;
  const blockAt = policy.blockAt ?? "high";
  const requireExecution = policy.requireExecution ?? true;
  const affected = consumers.filter((consumer) => consumer.affected);
  let severity = "none";
  let potentialImpactSeverity = "none";
  const reasons = [];

  for (const consumer of affected) {
    potentialImpactSeverity = maxSeverity(
      potentialImpactSeverity,
      impactSeverity(consumer),
    );
  }
  if (affected.length) {
    reasons.push(
      `${affected.length} downstream ${affected.length === 1 ? "asset references" : "assets reference"} the changed field`,
    );
  }

  for (const difference of comparison?.breached ?? []) {
    severity = maxSeverity(severity, differenceSeverity(difference));
  }
  if (comparison?.breached?.length) {
    severity = maxSeverity(severity, potentialImpactSeverity);
    reasons.push(
      `${comparison.breached.length} counterfactual ${comparison.breached.length === 1 ? "check exceeded" : "checks exceeded"} policy thresholds`,
    );
  }

  if (executionStatus === "failed") {
    severity = maxSeverity(maxSeverity(severity, potentialImpactSeverity), "critical");
    reasons.push("Counterfactual execution failed");
  } else if (requireExecution && executionStatus === "not_run" && affected.length) {
    reasons.push("Execution evidence is required for affected assets");
  }

  const missingEvidence = [
    ...(evidenceStatus === "inconclusive" ? inconclusiveReasons : []),
    ...(requireExecution && executionStatus === "not_run" && affected.length
      ? ["Required counterfactual replay was not run"]
      : []),
  ].filter(Boolean);
  if (missingEvidence.length > 0 && executionStatus !== "failed") {
    const uniqueReasons = [...new Set([...reasons, ...missingEvidence])];
    return {
      conclusion: "neutral",
      mergeable: false,
      severity: severity === "none" ? "unknown" : severity,
      affectedAssetCount: affected.length,
      reasons: uniqueReasons,
      summary: "Shadow analysis inconclusive: required evidence is missing",
    };
  }

  const shouldBlock = LEVELS.indexOf(severity) >= LEVELS.indexOf(blockAt);
  return {
    conclusion: shouldBlock ? "failure" : "success",
    mergeable: !shouldBlock,
    severity,
    affectedAssetCount: affected.length,
    reasons: reasons.length ? reasons : ["No breaking downstream impact detected"],
    summary: shouldBlock
      ? `Merge blocked: ${severity} data change risk`
      : "Shadow analysis passed",
  };
}

export { LEVELS as SEVERITY_LEVELS };
