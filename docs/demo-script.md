# Demo script — under three minutes

Target runtime: **2 minutes 40 seconds**. Every number below is produced by the
real pipeline, so the recording can be a single take with nothing staged.

## Before recording

1. DataHub is running and healthy: `curl http://localhost:8080/health`
2. The demo graph is ingested: `npm run ingest:demo-lineage`
3. The evidence documents exist, so the writeback beat has something to open:
   `npm run analyze:pr -- --repository naman833/shadowgraph --pull-request 1 --base main --head demo/dangerous-discount-scale --record-evidence`
4. Two browser tabs open, both real pull requests on this repository:
   - <https://github.com/naman833/shadowgraph/pull/1> (blocked)
   - <https://github.com/naman833/shadowgraph/pull/2> (passing)
5. A terminal in the repository root, font large enough to read.

## 0:00–0:25 — The change that passes every schema check

Open pull request #1 and show the diff. It is one file.

> "This pull request changes how `discount_percentage` is interpreted: it stops
> dividing by a hundred. The column name is the same. The type is the same. Every
> schema test in the world passes this. And every revenue number downstream is now
> wrong by a factor of a hundred."

## 0:25–0:50 — The Check that catches it

Scroll to the checks section. Show the red **ShadowGraph change impact —
Unsafe data change blocked**, then click **Details**.

> "ShadowGraph blocked the merge. Not with a warning about blast radius — with a
> measurement."

## 0:50–1:30 — The evidence

Show the analysis output in the run log.

> "It asked DataHub what actually consumes this column, and got two real
> downstream assets: a revenue mart and an ML feature table. Then it replayed both
> versions of the SQL in DuckDB against the project's seed data."

Point at the numbers:

```text
metric/total_net_revenue      17311.4075 -> -445403.95
metric/average_discount_rate       0.149 -> 14.9
distribution/max_discount_rate      0.35 -> 35
Severity: critical
Decision: FAILURE - Merge blocked: critical data change risk
```

> "Total net revenue goes negative. That is not an estimate, it is the query
> result."

## 1:30–2:05 — The part that makes it trustworthy

Switch to pull request #2. Show the green check.

> "A gate that blocks everything is useless. This second pull request refactors
> the *same file* and the same expression — it moves the conversion into a CTE and
> rewrites the arithmetic. Different SQL, identical results. Zero breached checks
> across all three models. It passes."

> "That is the hard half: knowing the difference between a change that looks
> dangerous and one that is."

## 2:05–2:30 — DataHub as the context and memory layer

Open DataHub at <http://localhost:9002> and search `stg_orders`. Show the
column-level lineage and the owning team.

> "DataHub is what makes this possible. It supplies dataset identity, the
> column-level lineage that separates true consumers from coincidental
> neighbours, and the owners who need to review."

Search DataHub for `ShadowGraph` and open the decision document.

> "And the decision goes back in. One document per commit, so the next engineer
> inherits the reasoning instead of rediscovering it. Rerun the same commit and
> it updates that record rather than piling up duplicates."

## 2:30–2:40 — Close

> "DataHub tells ShadowGraph what is connected. ShadowGraph proves what will
> change — before production finds out."

## Honesty notes

State these plainly if asked; they are in the README's capability matrix.

- The decision is deterministic. No language model can influence it.
- Missing or ambiguous evidence returns `neutral`, which blocks the merge. It is
  never reported as a pass.
- The application page shows deterministic reference values so it loads without
  DataHub. The pull-request Checks in this demo are the live path.
- Say "replay" or "counterfactual", not "simulation": the SQL really executes.

## Recording notes

- Fresh browser window, 1440×900 or similar.
- Increase cursor size, avoid rapid panning.
- Keep setup commands out of the final cut.
- Record in one take, then add captions.
