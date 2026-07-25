# Demo project: `acme_analytics`

A deliberately small dbt-style project that ShadowGraph analyzes end to end. It
exists so the two demonstration pull requests operate on real files, real Git
commits, and a real DuckDB execution — not on hard-coded results.

## The contract that makes the demo interesting

`raw.orders.discount_percentage` is a **whole percentage**: `25` means 25%.

Every consumer must therefore divide it by 100 before using it in arithmetic.
That rule lives in `models/sources.yml` as documentation, which is exactly the
problem: nothing enforces it. The column's name and type never change, so schema
CI has nothing to fail on.

## Lineage

```text
raw.orders (Snowflake)
  └── stg_orders (dbt)          discount_rate, net_revenue
        ├── fct_order_revenue (dbt)         net_revenue, average_discount_rate
        └── order_discount_features (dbt)   order_discount_ratio, is_high_discount
```

`stg_orders` is the only place the `/ 100.0` conversion happens, so a change
there propagates to both a finance-facing mart and an ML feature table.

## Files

| Path | Purpose |
|---|---|
| `dbt_project.yml` | dbt project declaration |
| `models/sources.yml` | Declares `raw.orders` and documents the whole-percentage contract |
| `models/staging/stg_orders.sql` | Normalizes orders; owns the `/ 100.0` conversion |
| `models/marts/fct_order_revenue.sql` | Revenue by customer segment |
| `models/features/order_discount_features.sql` | Fraud-model features |
| `models/schema.yml` | dbt tests (uniqueness, not-null) |
| `seeds/orders.csv` | 20 bounded rows used as replay input |
| `shadowgraph.json` | Dataset identity and replay manifest |

## `shadowgraph.json`

This manifest is the seam between the repository and DataHub. For each model it
declares the canonical DataHub dataset URN, and the bounded aggregate
expressions ShadowGraph compares before and after a change:

- **metrics** — business values such as `SUM(net_revenue)`
- **distributions** — shape checks such as `MAX(order_discount_ratio)`

Replay compares schema, row count, null rates, metrics, and distributions. A
change that alters any of them beyond its threshold is reported with the
measured before/after values.

## The two demonstration scenarios

### Dangerous: semantic scale change

Remove the `/ 100.0` in `stg_orders`, keeping the column names and types
identical.

```diff
- coalesce(discount_percentage, 0) / 100.0 as discount_rate,
- gross_amount * (1 - coalesce(discount_percentage, 0) / 100.0) as net_revenue
+ coalesce(discount_percentage, 0) as discount_rate,
+ gross_amount * (1 - coalesce(discount_percentage, 0)) as net_revenue
```

Measured on the committed seed, with an unchanged output schema:

| Model | Metric | Before | After |
|---|---|---|---|
| `fct_order_revenue` | `total_net_revenue` | `17311.4075` | `-445403.95` |
| `order_discount_features` | `average_discount_ratio` | `0.149` | `14.9` |
| `order_discount_features` | `max_discount_ratio` | `0.35` | `35` |

Revenue goes negative and the ML feature leaves its trained `[0, 1]` range, so
the merge is blocked.

### Safe: behavior-preserving refactor

Restructure `stg_orders` to compute the rate once in a CTE. Every metric and
distribution is unchanged, so ShadowGraph passes it. This is the false-positive
guard: a gate that blocks safe refactors would be turned off in a week.

## Running the scenarios

Both scenarios are executed by the repository's own CLI against real Git
commits. See the root [README](../README.md) for the commands and the live
DataHub setup.

The seed rows are deterministic committed fixtures — metadata alone cannot
supply warehouse rows. Dataset identity, schemas, column-level lineage, and
ownership come from live DataHub.
