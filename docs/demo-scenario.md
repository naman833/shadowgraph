# Golden-path demo scenario

The demo is built around one silent semantic breaking change that ordinary
schema validation cannot detect.

## Setup

Repository: `acme-data/analytics`  
Pull request: `#184`  
Changed model: `models/staging/stg_orders.sql`  
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
 select
   order_id,
   gross_amount,
-  discount_percentage / 100 as discount_rate,
+  discount_percentage as discount_rate,
   gross_amount * (1 - discount_rate) as net_revenue
 from {{ ref('raw_orders') }}
```

## Expected analysis

1. The file and semantic scale change are detected.
2. `raw.orders.discount_percentage` resolves to a Snowflake DataHub URN.
3. Three lineage hops produce five candidate downstream assets.
4. Column-level analysis excludes one asset that does not consume the column.
5. Four true consumers remain: a dbt model, metric, Looker dashboard, and ML
   feature.
6. The reference replay compares 12,440 rows before and after.
7. Revenue changes by `−24.75%` and ML distribution drift reaches `0.31`.
8. Both exceed their policies, so the PR is blocked.
9. The report identifies Data Platform, Finance Analytics, Ecommerce Operations,
   and Risk ML as required reviewers.

## Safe-case counterexample

A credible CI gate must also avoid noisy false positives. The companion
`examples/safe-check.json` represents a documentation/alias update where:

- DataHub returns downstream candidates.
- Column-level analysis finds no dependency on the changed alias.
- No runtime threshold is exceeded.
- The check passes without requesting unrelated reviewers.

## Current versus live behavior

The hosted vertical slice displays this entire scenario with deterministic
reference evidence. It does not yet fetch live DataHub metadata, execute DuckDB,
or publish a GitHub Check. Those adapters are the next delivery milestone.

## Demo acceptance checklist

- [ ] The app loads without a DataHub dependency.
- [ ] **Run Shadow Analysis** visibly advances through all five stages.
- [ ] The graph shows four true consumers.
- [ ] The evidence view shows measured deltas and thresholds.
- [ ] The final state clearly says the merge is blocked.
- [ ] Both blocked and safe sample outputs are present in `examples/`.
- [ ] The presenter distinguishes current deterministic behavior from planned
      live adapters.
