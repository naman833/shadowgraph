# Hackathon judging alignment

ShadowGraph targets **Agents That Do Real Work**, with a secondary connection to
**Metadata-Aware Code Generation & Development** once repair generation lands.

## DataHub usage

The intended live workflow depends on DataHub for canonical asset identity,
schemas, column-level lineage, downstream dashboards and ML assets, ownership,
and durable evidence writeback. The product cannot determine the minimal replay
scope or responsible reviewers from a Git diff alone.

Current evidence:

- The interactive product surface communicates DataHub URNs, lineage scope, and
  affected owners.
- Sample outputs preserve DataHub entity identity.
- The adapter contract and trust boundaries are documented.

Work in progress:

- Live MCP/GraphQL reads
- Live evidence writeback

## Technical execution

The application is a working, testable vertical slice with a deterministic
analysis state machine and responsive interface. Machine-readable examples make
the decision contract inspectable without running the app.

The highest-value remaining work is the live end-to-end path: diff → DataHub
resolution → DuckDB replay → GitHub Check → DataHub record.

## Originality

Most lineage tools report a possible blast radius. ShadowGraph's differentiator
is the planned executable counterfactual: replay only the affected subgraph
before and after the proposed change, then attach measured evidence to the PR.
Its second differentiator is false-positive reduction at column-consumer level.

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

Use this exact framing in the submission until the adapters are complete:

> ShadowGraph currently ships a working interactive vertical slice with
> deterministic reference evidence. Live DataHub context, DuckDB replay,
> GitHub Check publishing, and DataHub evidence writeback are in active
> development.

Update this statement only after an integration is implemented and verified.
