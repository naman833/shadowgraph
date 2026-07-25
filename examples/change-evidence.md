# ShadowGraph change evidence

**Decision:** Block merge  
**Pull request:** `acme-data/analytics#184`  
**Changed field:** `raw.orders.discount_percentage`

## Causal finding

The proposed transformation changes `discount_percentage` from a whole-number
percentage to a decimal fraction without changing the field name or type.
DataHub column lineage identifies four true downstream consumers.

The shadow replay produced the following material differences:

- `fct_order_revenue.net_revenue`: −24.75%
- `monthly_net_revenue`: −$482,129.72
- `Executive Revenue`: three affected tiles
- `order_discount_ratio`: distribution drift score 0.31

## Required reviewers

- Data Platform
- Finance Analytics
- Ecommerce Operations
- Risk ML

## Resolution

Preserve the existing normalization step or migrate all true consumers in the
same pull request. Rerun ShadowGraph before merging.
