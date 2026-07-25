# Architecture

ShadowGraph is designed as an explainable CI state machine around DataHub's
metadata graph. Each stage emits structured evidence so a failed check can be
reproduced and audited.

## System view

```mermaid
flowchart TB
    subgraph Trigger["Change plane"]
        GH["GitHub webhook / Action"]
        Diff["SQL and dbt diff classifier"]
    end

    subgraph Context["Context plane"]
        Adapter["DataHub adapter"]
        Graph["Schemas, URNs, lineage, owners, governance"]
    end

    subgraph Execution["Evidence plane"]
        Planner["Minimal lineage replay planner"]
        Duck["Isolated DuckDB before/after runs"]
        Compare["Schema, quality, metric, and ML comparison"]
    end

    subgraph Decision["Decision plane"]
        Policy["Merge policy"]
        Check["GitHub Check / PR comment"]
        Record["DataHub evidence writeback"]
    end

    GH --> Diff --> Adapter
    Adapter <--> Graph
    Adapter --> Planner --> Duck --> Compare --> Policy
    Policy --> Check
    Policy --> Record
```

## Stage contracts

| Stage | Input | Output | Failure behavior |
|---|---|---|---|
| Detect | Git diff and repository mapping | Changed asset, column, and change class | Mark analysis inconclusive |
| Resolve | Asset identity hints | Canonical DataHub URN and schema | Request mapping; do not guess |
| Trace | URN and changed columns | Bounded downstream lineage subgraph | Report incomplete context |
| Classify | Lineage plus consumer SQL | True consumers and exclusions with reasons | Prefer unknown over safe |
| Replay | Before/after code and sample data | Comparable output profiles | Block or mark inconclusive by policy |
| Decide | Static and runtime evidence | Pass, warn, block, or inconclusive | Default policy is fail closed for critical assets |
| Record | Decision bundle | PR check and DataHub evidence record | Preserve local report for retry |

## Current implementation

Every stage runs for real against two immutable commits. `npm run analyze:pr`
reads a pull request, resolves the changed dataset in DataHub, traverses
column-level lineage, replays the affected models in DuckDB, compares the
results, decides, and publishes a GitHub Check.

| Boundary | State | Notes |
| --- | --- | --- |
| GitHub PR ingestion | Live | Reads two immutable commit SHAs through `git`. |
| DataHub GraphQL queries | Live | Identity, schema, lineage, and ownership. |
| SQL/dbt semantic diff | Live | Detects changed column expressions. |
| DuckDB counterfactual replay | Live | Executes before and after in memory. |
| Decision policy | Deterministic | No LLM input; fails closed on missing evidence. |
| GitHub Check publishing | Live, opt-in | Dry run unless `--publish-check`. |
| DataHub evidence writeback | Live, approval-gated | Requires `--record-evidence`; reads the record back. |
| Ollama explanation | Optional, advisory | Never affects the decision. |

The interactive application remains a deterministic reference run for
demonstration, so it loads without any DataHub dependency. The CI path does not
use it.

## Evidence schema

`examples/blocked-check.json` captures the minimum stable result contract:

- Repository, PR, and immutable commit SHA
- Changed file, DataHub dataset URN, and column
- Change classification
- Lineage scope and true-consumer counts
- Replay row count and runtime
- Failed checks, thresholds, assets, and owners

Future versions should add an evidence hash, adapter versions, replay manifest,
source snapshot identifiers, and DataHub writeback URN.

## Trust and safety boundaries

- **Read before write:** DataHub discovery is read-only until the final evidence
  record is assembled.
- **No production mutation:** replay runs against static or isolated sample data.
- **Commit-scoped results:** a check belongs to one immutable SHA and becomes
  stale when the PR changes.
- **Explainable decisions:** every block names an asset, measured value,
  threshold, owner, and lineage path.
- **No invented identity:** unresolved assets produce an inconclusive result
  rather than a guessed URN.
- **Idempotent writeback:** the writeback key is repository + PR + full head SHA,
  so retries update one DataHub document instead of accumulating duplicates.
- **Verified writes:** every evidence write is read back and its idempotency
  marker re-checked, so a dropped mutation is reported as a failure rather than
  as a stored record.

## Deployment shape

The UI is Cloudflare-compatible. The live service will additionally require a
trusted backend/worker for webhook verification, GitHub credentials, DataHub
access, and isolated replay execution. Secrets must remain server-side and must
never be exposed to the browser bundle.
