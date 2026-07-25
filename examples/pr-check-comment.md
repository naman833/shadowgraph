# ShadowGraph blocked this merge

**2 critical policies failed** for commit `7f39a41`.

`models/staging/stg_orders.sql` changes the semantic scale of
`raw.orders.discount_percentage` from `0–100` to `0–1`.

| Downstream asset | Owner | Observed change | Policy |
|---|---|---:|---:|
| `fct_order_revenue` | Data Platform | net revenue `−24.75%` | maximum `±1%` |
| `monthly_net_revenue` | Finance Analytics | `−$482,129.72` | material change |
| Executive Revenue | Ecommerce Operations | 3 tiles affected | critical dashboard |
| `order_discount_ratio` | Risk ML | drift `0.31` | maximum `0.10` |

DataHub lineage returned five downstream candidates. Column-level analysis
excluded one asset that does not consume the changed field.

**Required action:** preserve the existing `/ 100` normalization or migrate all
true consumers in this pull request, then rerun ShadowGraph.

<details>
<summary>Replay details</summary>

- DataHub URN:
  `urn:li:dataset:(urn:li:dataPlatform:snowflake,acme.analytics.stg_orders,PROD)`
- Lineage depth: 3
- Rows replayed: 12,440
- Reference runtime: 1.84 seconds

</details>

> This file is a sample of the planned GitHub Check presentation. Live Check
> publishing is not implemented in the current vertical slice.
