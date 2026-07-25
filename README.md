<p align="center">
  <img src="public/media/shadowgraph-logo.png" alt="ShadowGraph logo" width="156">
</p>

<h1 align="center">ShadowGraph</h1>

<p align="center"><strong>The pre-merge safety system for organizational data.</strong></p>

ShadowGraph is a DataHub-powered CI gate that turns a proposed data change into
an evidence-backed merge decision. It resolves changed datasets and columns
against DataHub, traverses their true downstream consumers, replays the affected
lineage subgraph, and blocks pull requests that silently alter critical metrics,
dashboards, or ML features.

## Proof: two real pull requests

Both change the same file. Both keep every column name and type identical, so
ordinary schema validation passes either way. ShadowGraph separates them:

| Pull request | Change | ShadowGraph Check |
| --- | --- | --- |
| [#1 Treat discount_percentage as a decimal fraction](https://github.com/naman833/shadowgraph/pull/1) | Removes the `/ 100.0` conversion | **Failure — merge blocked** |
| [#2 Compute the discount rate once in a CTE](https://github.com/naman833/shadowgraph/pull/2) | Moves the same conversion into a CTE | **Success** |

The measured evidence behind #1, from DuckDB replay of the real models against
the committed seed data:

```text
metric/total_net_revenue      17311.4075 -> -445403.95
metric/average_discount_rate       0.149 -> 14.9
distribution/max_discount_rate      0.35 -> 35
Severity: critical    Affected downstream assets: 2 (live DataHub)
Decision: FAILURE - Merge blocked: critical data change risk
```

#2 produces zero breached checks across all three models, which is the
false-positive guard: an equivalent refactor must not be blocked.

## See it work

<p align="center">
  <img src="public/media/shadowgraph-demo.gif" alt="ShadowGraph tracing a semantic SQL change and blocking the unsafe merge" width="960">
</p>

The captured product flow shows the proposed SQL change moving through DataHub
lineage resolution, counterfactual execution evidence, and a deterministic
merge-blocking decision.

## The problem

Schema checks catch dropped columns and incompatible types. They do not catch a
field whose name and type stay the same while its meaning changes.

ShadowGraph's reference scenario changes `discount_percentage` from a whole
percentage (`25`) to a decimal fraction (`0.25`). Ordinary schema CI stays green,
but downstream revenue calculations and an ML feature silently change behavior.

ShadowGraph uses DataHub to answer *what is connected?* and an isolated replay
engine to answer *what actually changes?*

## How it works

![ShadowGraph architecture: GitHub PR detection, DataHub context, true-consumer classification, replay, decision, and publication](public/media/shadowgraph-architecture.svg)

The state machine is deliberately small and inspectable:

```text
DETECT → RESOLVE → TRACE → REPLAY → COMPARE → DECIDE → RECORD
```

### What is live, what is deterministic, what needs approval

ShadowGraph is explicit about this, because a safety tool that overstates its
own guarantees is not a safety tool.

| Capability | Mode | Meaning |
| --- | --- | --- |
| Pull-request ingestion | **Live** | Reads two immutable commit SHAs with `git`. |
| DataHub identity, schema, lineage, owners | **Live** | GraphQL against a real instance. |
| DuckDB counterfactual replay | **Live** | Executes both revisions in memory. |
| Decision policy | **Deterministic** | Pure function of the evidence. Never an LLM. |
| GitHub Check publishing | **Dry run by default** | Writes only with `--publish-check`. |
| DataHub evidence writeback | **Approval-gated** | Writes only with `--record-evidence`, then reads the record back. |
| Ollama explanation | **Optional, advisory** | Cannot change the decision. Absent by default. |
| Application page evidence | **Deterministic reference data** | So the demo loads without DataHub. |

Two properties matter most. The decision **never** depends on an LLM: no model
can talk ShadowGraph into passing an unsafe change. And missing or ambiguous
evidence produces `neutral` with `mergeable: false`, never a pass — if
ShadowGraph cannot prove a change is safe, it does not claim it is.

## Analyze a real pull request

Requirements: Node.js 22.13 or newer, npm, and a running DataHub instance for
live context.

```bash
git clone https://github.com/naman833/shadowgraph.git
cd shadowgraph
npm install

# Ingest the demo project's datasets, lineage, and owners into local DataHub.
npm run ingest:demo-lineage

# Reproduce the blocked decision. Exit code 1.
npm run analyze:pr -- \
  --repository naman833/shadowgraph \
  --pull-request 1 \
  --base main \
  --head demo/dangerous-discount-scale \
  --output outputs/dangerous.json

# Reproduce the passing decision. Exit code 0.
npm run analyze:pr -- \
  --repository naman833/shadowgraph \
  --pull-request 2 \
  --base main \
  --head demo/safe-sql-refactor \
  --output outputs/safe.json
```

Exit codes are the gate contract: `0` safe, `1` blocked, `2` inconclusive,
`3` the command itself failed. `2` is deliberately distinct from `0` so an
inconclusive run can never be mistaken for a pass.

Publishing a Check is opt-in. Without `--publish-check` the command prints the
request it would have sent and writes nothing:

```bash
GITHUB_TOKEN=... npm run analyze:pr -- ... --publish-check
```

Recording the decision in DataHub is separately opt-in. `--record-evidence` is
the approval:

```bash
npm run analyze:pr -- ... --record-evidence
```

The record is one DataHub Document whose URN is derived from repository, pull
request, and full head SHA, so a rerun of the same commit updates that document
instead of adding another. Each write is read back and its idempotency marker
re-checked before the run reports success:

```text
DataHub evidence: created and read back (urn:li:document:shadowgraph_bb0027b6…)
DataHub evidence: updated and read back (urn:li:document:shadowgraph_b7cb305a…)
```

Add `--explain` for an optional local Ollama summary. It is advisory only, it
detects an installed model rather than assuming one, and if Ollama is
unavailable the run proceeds unchanged.

## Try the interactive application

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), select **Run Shadow
Analysis**, watch the five analysis stages complete, then switch between
**Impact graph** and **Execution evidence**.

The page walks through the same scenario visually: the changed SQL, the impacted
lineage graph, owners, before/after evidence, and the merge decision.

Its displayed evidence values are deterministic reference data, so the page loads
whether or not DataHub is running. The application's DataHub routes do query the
live instance when it is configured:

```bash
curl 'http://localhost:3000/api/datahub/health'
curl 'http://localhost:3000/api/datahub/entity?q=stg_orders'
curl -X POST 'http://localhost:3000/api/datahub/lineage' \
  -H 'content-type: application/json' \
  -d '{"urn":"urn:li:dataset:(urn:li:dataPlatform:dbt,acme_analytics.staging.stg_orders,PROD)","depth":3}'
```

Each response carries a `source` field of `live` or `demo`, so it is always clear
which one produced the answer.

Run the executable dangerous and safe golden paths:

```bash
npm run demo:golden
```

The dangerous path keeps the same schema while changing total revenue from
`357` to `-6870` and produces a failed Check payload. The equivalent refactor
keeps revenue at `357` and produces a successful Check payload. Both external
publication operations remain dry runs.

## Validation

```bash
npm test
npm run lint
npm run demo:golden
```

`npm test` creates the Cloudflare-compatible production build and verifies the
rendered product surface. See [docs/setup.md](docs/setup.md) for the DataHub
Quickstart and live integration environment.

With local DataHub running, verify the official read-only MCP interface:

```bash
npm run verify:datahub-mcp
```

## Running it in CI

[`.github/workflows/shadowgraph.yml`](.github/workflows/shadowgraph.yml) runs on
every pull request with least-privilege permissions: `contents: read` to read the
code and `checks: write` to publish the result, nothing more.

It checks out the immutable head SHA rather than the moving merge ref, so the
analysis, the evidence artifact, and the Check all describe one commit. The
evidence JSON uploads on every run, including failures. The job fails on both
`failure` and `neutral`, so an inconclusive analysis blocks the merge instead of
sliding through as a pass.

The workflow targets a **self-hosted runner**, because ShadowGraph reads a
DataHub instance that a GitHub-hosted runner cannot reach. See
[docs/self-hosted-runner.md](docs/self-hosted-runner.md) for registration. No
runner files, tokens, or credentials belong in this repository.

## DataHub's role

DataHub is not a decorative catalog in ShadowGraph. It is the context and memory
layer that supplies:

- Dataset and column identity through DataHub URNs
- Table- and column-level lineage
- Downstream dashboards, metrics, features, and models
- Ownership and governance context for review routing
- A durable home for the final decision and validation evidence

Without that graph, the system would not know which subset of the data estate to
analyze or who needs to act on the result.

## Reference scenario

```diff
- discount_percentage / 100 as discount_rate
+ discount_percentage as discount_rate
```

The type and name remain valid, but the semantic scale changes. On the real
pull request above, DataHub's column-level lineage resolves two true consumers —
a revenue mart and an ML feature table — and the DuckDB replay breaches eight
policy thresholds, so the merge is blocked.

Sample artifacts are available in [`examples/`](examples/):

- [`blocked-check.json`](examples/blocked-check.json) — machine-readable failed check
- [`safe-check.json`](examples/safe-check.json) — false-positive-free passing check
- [`change-evidence.md`](examples/change-evidence.md) — human-readable evidence record
- [`pr-check-comment.md`](examples/pr-check-comment.md) — proposed GitHub PR presentation

## Repository map

```text
app/                  Interactive ShadowGraph application
docs/                 Architecture, setup, demo, and judging notes
examples/             Sample reports and evidence outputs
public/media/          Logo, architecture diagram, and animated product demo
tests/                Render and product-contract tests
.openai/              Sites deployment configuration
```

## Documentation

- [Architecture and trust boundaries](docs/architecture.md)
- [Local and integration setup](docs/setup.md)
- [Official DataHub MCP and Skills integration](docs/datahub-agent-integration.md)
- [GitHub pull-request ingestion](docs/github-action.md)
- [Golden-path demo scenario](docs/demo-scenario.md)
- [Under-three-minute demo script](docs/demo-script.md)
- [Hackathon judging alignment](docs/judging-alignment.md)
- [Roadmap](docs/roadmap.md)

## Implemented pipeline

1. DataHub MCP/Skills and live GraphQL context adapter
2. SQL/dbt immutable-diff classifier
3. Column-level true-consumer resolver
4. Bounded DuckDB before/after replay engine
5. Deterministic pass/block/inconclusive policy
6. Approval-gated GitHub Check publisher
7. Approval-gated, idempotent DataHub document writeback
8. Optional local Ollama explanation (`qwen2.5:7b` by default)

Every stage has been exercised against live DataHub and two real pull requests on
this repository. The remaining submission work is presentational: a hosted
deployment and the recorded video. See [docs/roadmap.md](docs/roadmap.md).

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening
a pull request and report vulnerabilities according to [SECURITY.md](SECURITY.md).
Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
