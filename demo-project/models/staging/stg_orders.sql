-- Normalizes raw orders and derives the discount rate every downstream
-- model depends on.
--
-- raw.orders.discount_percentage is a WHOLE PERCENTAGE (25 means 25%), so it
-- must be divided by 100 to become a rate usable in arithmetic.

select
    order_id,
    customer_id,
    order_date,
    customer_segment,
    gross_amount,
    discount_percentage,
    coalesce(discount_percentage, 0) / 100.0 as discount_rate,
    gross_amount * (1 - coalesce(discount_percentage, 0) / 100.0) as net_revenue
from {{ source('raw', 'orders') }}
