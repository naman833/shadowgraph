# Hackathon judging alignment

ShadowGraph targets **Agents That Do Real Work**, with a secondary connection to
**Metadata-Aware Code Generation & Development** once repair generation lands.

## DataHub usage

The workflow depends on DataHub for canonical asset identity, schemas,
column-level lineage, downstream dashboards and ML assets, ownership, and durable
evidence writeback. The product cannot determine the minimal replay scope or the
responsible reviewers from a Git diff alone.

Verified against a local DataHub v1.5.0.6 quickstart:

- Live GraphQL reads for identity, schema, column-level lineage, and owners.
- The read-only MCP interface, checked by `npm run verify:datahub-mcp`.
- Approval-gated evidence writeback as a DataHub Document, read back after each
  write and idempotent across reruns of the same commit.

The one downstream consequence of that dependency is honest to state: without
DataHub the analysis returns `neutral`, which blocks the merge. It never
substitutes a guess.

## Technical execution

The end-to-end path runs: diff → DataHub resolution → DuckDB replay → GitHub
Check → DataHub evidence. It is exercised by two real pull requests on this
repository, one blocked and one passed, with the Checks published by the pipeline
itself from a self-hosted runner.

The remaining work is breadth rather than depth: more SQL dialects, more change
classes, and a hosted deployment.

## Originality

Most lineage tools report a possible blast radius. ShadowGraph's differentiator
is the executable counterfactual: it replays only the affected subgraph before
and after the proposed change, then attaches the measured evidence to the pull
request. Its second differentiator is false-positive reduction at
column-consumer level, which is what lets the safe refactor pass.

## Usefulness

The reference failure is deliberately semantic, not syntactic. It represents a
class of incidents that pass schema checks but silently corrupt business metrics
and ML inputs. A CI-native check puts the result where engineers already make
merge decisions and routes review using DataHub ownership.

## Submission quality

The repository includes:

- Apache 2.0 license
- Local setup and validation instructions
- Architecture and security boundaries
- Blocked and safe sample outputs
- A reproducible golden-path scenario
- An under-three-minute demo script
- Contribution and conduct guidance

## Honest status statement

Use this framing in the submission:

> ShadowGraph runs end to end against a live DataHub instance. Two real pull
> requests on this repository exercise the full path: the unsafe semantic change
> is blocked by a red GitHub Check and the equivalent refactor passes green, both
> published by the pipeline itself. DataHub evidence writeback is implemented,
> approval-gated, and verified by reading the record back.
>
> The interactive application page still renders deterministic reference values
> so it loads without DataHub. The merge decision is deterministic and never
> depends on a language model. Missing or ambiguous evidence returns `neutral`,
> which blocks the merge rather than passing it.

Two things are deliberately not claimed: there is no hosted deployment that can
reach a local DataHub instance, and GitHub webhook signature verification is not
implemented because the CI path uses Actions rather than webhooks.
