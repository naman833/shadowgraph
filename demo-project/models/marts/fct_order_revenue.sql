-- Revenue fact consumed by the executive revenue dashboard and by the
-- monthly_net_revenue metric.

select
    customer_segment,
    count(*) as order_count,
    sum(gross_amount) as gross_revenue,
    sum(net_revenue) as net_revenue,
    avg(discount_rate) as average_discount_rate
from {{ ref('stg_orders') }}
group by customer_segment
