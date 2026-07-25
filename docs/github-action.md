# GitHub pull-request ingestion

ShadowGraph includes a real GitHub Actions ingestion path in
`.github/workflows/shadowgraph.yml`.

For every opened, synchronized, or reopened pull request, the workflow:

1. Checks out full Git history with read-only repository permissions.
2. Builds and tests ShadowGraph.
3. Resolves the PR's base and head commits to immutable full Git object IDs.
4. Reads before/after snapshots directly from Git.
5. Analyzes changed `.sql` and `.ddl` files with the deterministic change
   detector.
6. Uploads `pull-request-analysis.json` as a 14-day workflow artifact.

The analyzer does not execute pull-request code and does not require repository
secrets, an LLM, or a paid service. Inputs are bounded to 100 files, 1 MB per
file, and 2 MB total; unsafe paths, duplicate paths, unsupported file states,
and non-immutable commit identifiers are rejected.

## Local verification

Analyze any two local Git commits:

```bash
npm run analyze:pr-diff -- \
  --base HEAD~1 \
  --head HEAD \
  --repository local/shadowgraph \
  --pull-request 1 \
  --output outputs/pull-request-analysis.json
```

The command prints the number of changed files and detected data changes. The
JSON evidence records:

- repository and PR identity
- full base and head SHAs
- received, analyzed, and ignored file counts
- detected dataset/column changes with their source file and confidence

## Publication boundary

`src/github/checks.js` builds and publishes commit-scoped Check Runs, routes
only owners of proven affected assets, and defaults to dry-run. It supports:

- `success` for complete evidence below policy thresholds
- `failure` for a deterministic unsafe change
- `neutral` when identity, lineage, or replay evidence is incomplete

The checked-in workflow currently uploads the immutable detection artifact
without GitHub write permissions. Connecting the publisher requires a real
GitHub repository, granting `checks: write`, and explicitly opting out of dry
run. This local repository has not performed that external operation.
