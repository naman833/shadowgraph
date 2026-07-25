-- Feature table for the fraud-propensity model. order_discount_ratio is
-- expected to stay within [0, 1]; the model was trained on that range.

select
    order_id,
    customer_segment,
    discount_rate as order_discount_ratio,
    case when discount_rate > 0.20 then 1 else 0 end as is_high_discount
from {{ ref('stg_orders') }}
