-- Normalizes raw orders and derives the discount rate every downstream
-- model depends on.
--
-- Standardizing discount handling: treat discount_percentage as a decimal
-- fraction so the rate can be used directly without conversion.

select
    order_id,
    customer_id,
    order_date,
    customer_segment,
    gross_amount,
    discount_percentage,
    coalesce(discount_percentage, 0) as discount_rate,
    gross_amount * (1 - coalesce(discount_percentage, 0)) as net_revenue
from {{ source('raw', 'orders') }}
