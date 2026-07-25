# Roadmap

The roadmap prioritizes one complete, defensible golden path over broad but
shallow platform support.

## Phase 0 — Product vertical slice

Status: **implemented**

- Interactive PR analysis
- Five-stage deterministic state machine
- Impact graph and true-consumer presentation
- Before/after evidence presentation
- Merge-blocking decision and owner routing
- Sample machine-readable evidence
- Production build and rendered-surface test

## Phase 1 — Live DataHub context

Status: **implemented and live-verified locally**

- [x] Resolve dataset hints to canonical DataHub URNs
- [x] Retrieve ownership and bounded downstream lineage
- [x] Integrate and verify the official DataHub MCP Server and Skills
- [x] Resolve column hints and retrieve live schema fields
- [ ] Persist raw adapter responses for reproducible fixtures
- [x] Return an explicit inconclusive decision when identity cannot be resolved

Acceptance: one showcase-ecommerce asset can be resolved and its downstream
lineage and owners appear in a structured ShadowGraph result.

## Phase 2 — Change intelligence

Status: **implemented**

- [x] Ingest immutable GitHub PR before/after snapshots
- [x] Parse dbt and raw SQL diffs
- [x] Detect drops, renames, type changes, filters, and semantic-expression changes
- [x] Map file-level edits to canonical DataHub datasets and columns
- [x] Classify live true consumers using column-level lineage and parsed SQL

Acceptance: the reference change produces four true consumers and excludes the
known unrelated candidate with a machine-readable reason.

## Phase 3 — Executable replay

Status: **implemented**

- [x] Load bounded typed fixtures into in-memory DuckDB
- [x] Materialize before/after read-only transformations
- [x] Compare schemas, row counts, null rates, distributions, and metrics
- [x] Add dangerous and safe deterministic fixtures

Acceptance: the same commit and fixture produce the same evidence bundle, and a
known semantic break exceeds its configured threshold.

## Phase 4 — CI and memory

Status: **implementation complete; external authorization pending**

- [x] Run change ingestion in a least-privilege GitHub Action
- [x] Upload commit-scoped analysis evidence as a workflow artifact
- [ ] Verify GitHub webhook signatures for webhook deployments
- [x] Build and publish commit-scoped Check runs behind dry-run
- [x] Route review using DataHub owners
- [x] Build an idempotent DataHub MCP `save_document` write behind approval

The remaining acceptance evidence requires a connected GitHub repository and
explicit approval to perform the two external writes. Neither has been claimed
from the local-only verification.

Acceptance: an unsafe PR receives a red check, a safe PR receives green, and
rerunning the same SHA does not duplicate the DataHub record.

## Phase 5 — Assisted remediation

- Generate a compatibility patch
- Generate dbt tests and migration notes
- Validate the patch through the same replay engine
- Require human approval; never auto-merge

Acceptance: the reference repair restores expected metrics and passes the
original failed policies.

## Explicit hackathon non-goals

- Every SQL dialect
- Arbitrary production warehouse execution
- General Airflow DAG execution
- Automatic merge or production mutation
- Enterprise authentication and permissions
- A complex multi-agent framework
