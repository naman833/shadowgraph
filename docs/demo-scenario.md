# Golden-path demo scenario

The demo is built around one silent semantic breaking change that ordinary
schema validation cannot detect.

## Setup

Repository: `naman833/shadowgraph`  
Pull request: [`#1`](https://github.com/naman833/shadowgraph/pull/1)  
Changed model: `demo-project/models/staging/stg_orders.sql`  
Changed column: `discount_percentage`

The source value historically uses whole percentages:

```text
25 means 25%
```

The proposed transformation assumes decimal fractions:

```text
0.25 means 25%
```

The field name and type are unchanged.

## Proposed change

```diff
-    coalesce(discount_percentage, 0) / 100.0 as discount_rate,
-    gross_amount * (1 - coalesce(discount_percentage, 0) / 100.0) as net_revenue
+    coalesce(discount_percentage, 0) as discount_rate,
+    gross_amount * (1 - coalesce(discount_percentage, 0)) as net_revenue
```

## Measured analysis

These are the values `npm run analyze:pr` produces against live DataHub, not
expectations:

1. The semantic scale change in `discount_rate` is detected with confidence
   `0.85`; the file's schema is unchanged.
2. `stg_orders` resolves to
   `urn:li:dataset:(urn:li:dataPlatform:dbt,acme_analytics.staging.stg_orders,PROD)`
   and all eight changed columns match the catalogued schema.
3. Column-level lineage on `discount_rate` returns two true consumers:
   `fct_order_revenue` (revenue mart) and `order_discount_features` (ML
   features).
4. Three models replay in DuckDB against the committed 20-row seed.
5. Eight checks breach policy across those models:

   ```text
   stg_orders              4 breached  total_net_revenue 17311.4075 -> -445403.95
   fct_order_revenue       1 breached  total_net_revenue 17311.4075 -> -445403.95
   order_discount_features 3 breached  high_discount_orders 6 -> 17
   ```

6. Severity is `critical`, the conclusion is `failure`, and the exit code is `1`.
7. Review routes to Analytics Engineering and ML Platform, taken from DataHub
   corpGroup ownership.

## Safe-case counterexample

A credible CI gate must also avoid noisy false positives, and the harder case is
not an unrelated change — it is a change to the *same expression* that happens to
be correct.

[Pull request #2](https://github.com/naman833/shadowgraph/pull/2) rewrites
`stg_orders.sql` to compute the discount rate once in a CTE and derives net
revenue from it. Different SQL, same arithmetic:

- The same file and the same column are detected as changed.
- DataHub returns the same two true consumers.
- All three models replay, and every metric, distribution, and null rate matches.
- Zero thresholds are breached, so the conclusion is `success` and the exit code
  is `0`.

`examples/safe-check.json` holds the corresponding Check payload.

## Current versus live behavior

The scenario runs for real. `demo-project/` is a dbt project with three models
and a 20-row seed; the two pull requests below change one file each, and the
pipeline resolves DataHub context, replays both revisions in DuckDB, and
publishes a GitHub Check:

| Pull request | Change | Check |
| --- | --- | --- |
| [#1](https://github.com/naman833/shadowgraph/pull/1) | Drops the `/ 100.0` percent conversion | Failure, merge blocked |
| [#2](https://github.com/naman833/shadowgraph/pull/2) | Moves the same conversion into a CTE | Success |

Both changes leave column names and types identical, so schema validation
passes either way. The measured difference is behavioural:
`total_net_revenue` moves from `17311.4075` to `-445403.95` on #1 and is
unchanged on #2.

The interactive application still renders this scenario from deterministic
reference evidence so it loads without DataHub. Its `/api/datahub/*` routes do
query the live instance.

## Demo acceptance checklist

- [x] Both real pull-request Checks are visible: #1 failing, #2 passing.
- [x] The blocked run names the assets, measured values, thresholds, and owners.
- [x] The safe refactor passes with zero breached checks.
- [x] Both blocked and safe sample outputs are present in `examples/`.
- [x] Exit codes match the gate contract: `1` blocked, `0` safe.
- [x] The app loads without a DataHub dependency.
- [ ] The presenter distinguishes the live CI path from the application's
      deterministic reference run.
