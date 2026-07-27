-- Normalizes raw orders and derives the discount rate every downstream
-- model depends on.
--
-- raw.orders.discount_percentage is a WHOLE PERCENTAGE (25 means 25%), so it
-- must be divided by 100 to become a rate usable in arithmetic.
--
-- Refactored to compute the rate once in a CTE instead of repeating the
-- conversion expression. Behavior is unchanged.

with normalized as (

    select
        order_id,
        customer_id,
        order_date,
        customer_segment,
        gross_amount,
        discount_percentage,
        coalesce(discount_percentage, 0) / 100.0 as computed_discount_rate
    from {{ source('raw', 'orders') }}

)

select
    order_id,
    customer_id,
    order_date,
    customer_segment,
    gross_amount,
    discount_percentage,
    computed_discount_rate as discount_rate,
    gross_amount - (gross_amount * computed_discount_rate) as net_revenue
from normalized
