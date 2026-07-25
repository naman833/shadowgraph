/**
 * Command-line wrapper for the ShadowGraph pull-request pipeline.
 *
 * Exit codes are chosen so CI can gate on them directly:
 *   0  the change is safe to merge
 *   1  the change is blocked
 *   2  the analysis is inconclusive and must not be read as a pass
 *   3  the command itself failed
 */
import {
  analyzePullRequestCommand,
  CliError,
  parseArgs,
} from "../src/cli/analyze-pr.js";

const EXIT = { success: 0, failure: 1, neutral: 2 };

function log(message) {
  process.stdout.write(`${message}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  const { evidence, checkRun, publication, evidenceRecord, outputPath, perModel } =
    await analyzePullRequestCommand(options, { log });

  const { decision } = evidence;
  log("");
  for (const entry of perModel) {
    const breached = entry.comparison.breached;
    log(
      `  ${entry.model}: ${breached.length} breached ${
        breached.length === 1 ? "check" : "checks"
      }`,
    );
    for (const difference of breached) {
      log(
        `    ${difference.category}/${difference.metric}: ${difference.before} -> ${difference.after}`,
      );
    }
  }

  log("");
  log(`DataHub context: ${evidence.dataHub.source} (${evidence.dataHub.graphqlUrl})`);
  log(`Affected downstream assets: ${decision.affectedAssetCount}`);
  log(`Severity: ${decision.severity}`);
  log(`Decision: ${decision.conclusion.toUpperCase()} - ${decision.summary}`);
  for (const reason of decision.reasons) log(`  - ${reason}`);

  if (evidence.advisory?.available) {
    log("");
    log(`Advisory (${evidence.advisory.model}, non-binding): ${evidence.advisory.summary}`);
  }

  log("");
  log(`Evidence: ${outputPath}`);
  log(
    publication.dryRun
      ? `GitHub Check: dry run, would POST ${checkRun.conclusion} to ${publication.endpoint}`
      : `GitHub Check: published ${publication.conclusion} (${publication.url})`,
  );
  if (evidenceRecord.dryRun) {
    log(
      `DataHub evidence: dry run, would upsert ${evidenceRecord.request.targetUrn}`,
    );
  } else if (evidenceRecord.error) {
    log(`DataHub evidence: NOT recorded - ${evidenceRecord.error}`);
  } else {
    log(
      `DataHub evidence: ${evidenceRecord.action} and read back (${evidenceRecord.urn})`,
    );
  }

  process.exit(EXIT[decision.conclusion] ?? EXIT.neutral);
} catch (error) {
  const message =
    error instanceof CliError || error instanceof Error
      ? error.message
      : "ShadowGraph analysis failed";
  process.stderr.write(`ShadowGraph error: ${message}\n`);
  process.exit(3);
}
