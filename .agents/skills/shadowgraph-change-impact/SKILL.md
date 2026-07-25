---
name: shadowgraph-change-impact
description: Run ShadowGraph's evidence-backed pull-request safety workflow from immutable Git diffs through DataHub identity and lineage, deterministic replay, merge decision, GitHub evidence, and approved DataHub writeback. Use for data-impact analysis, dbt/SQL/schema PR review, dangerous-versus-safe change demonstrations, or requests to run ShadowGraph end to end.
---

# ShadowGraph Change Impact

Run one inspectable workflow:

`DETECT → RESOLVE → TRACE → REPLAY → COMPARE → DECIDE → RECORD`

## Guardrails

- Bind every result to a full immutable head commit SHA.
- Treat DataHub identity and lineage as required context, not decoration.
- Keep traversal, file input, and replay resources bounded.
- Return `inconclusive`, never `success`, when required identity, lineage, or
  replay evidence is missing.
- Let deterministic thresholds decide merge status. Ollama output is advisory.
- Do not publish a GitHub Check or mutate DataHub without explicit user
  authorization.
- Before DataHub writeback, use `datahub-enrich`: show current state and the
  exact idempotent plan, ask for approval, execute once, then re-read to verify.

## Workflow

1. **Inspect**
   - Run `git status --short` and identify the base/head commits.
   - Preserve unrelated changes and reject untrusted paths or mutable refs.

2. **Detect**
   - Run `npm run analyze:pr-diff -- --base <base> --head <head>`.
   - Review the generated file/dataset/column changes and confidence.
   - Stop with a neutral result if no supported data files were analyzed.

3. **Resolve**
   - Resolve each dataset and changed column to canonical DataHub URNs and
     schema fields.
   - For ambiguity, present candidates; do not silently pick a weak match.
   - Use `datahub-search` for metadata questions.

4. **Trace**
   - Use `datahub-lineage` for bounded downstream impact analysis.
   - Prefer the official MCP tools; use the local adapter/CLI when necessary.
   - Retain real parent→child edges, deduplicate nodes, and report truncation.

5. **Classify**
   - Use column lineage first, then declared inputs and parsed SQL.
   - Record why each candidate is a true consumer or a lineage-only exclusion.

6. **Replay and decide**
   - Replay only the affected deterministic subgraph in DuckDB.
   - Compare schema, row count, null rates, metrics, and distributions.
   - Use policy thresholds supplied with the replay plan; otherwise use the
     documented comparator defaults.
   - Produce a commit-scoped success, failure, or inconclusive decision.

7. **Explain**
   - Optionally ask local Ollama to summarize existing evidence.
   - Label the output advisory and never let it alter the decision.

8. **Record**
   - Generate the GitHub Check payload and local evidence bundle.
   - Publish only with explicit authorization and configured GitHub access.
   - Plan DataHub evidence writeback, obtain approval, execute idempotently, and
     verify by reading the resulting entity/document.

## Verification

After implementation or workflow changes, run:

```bash
npm run lint
npm test
npm run verify:datahub-mcp
```

Exercise both golden scenarios:

```bash
npm run demo:golden
```

- Dangerous: removing `/ 100` from `discount_percentage` keeps the schema but
  changes revenue, so ShadowGraph blocks the commit.
- Safe: an equivalent refactor reaches the same affected consumer but produces
  identical replay evidence, so it passes without a lineage false positive.

Report what was live, deterministic, advisory, skipped, or still unauthorized.
