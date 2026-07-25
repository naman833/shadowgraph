const orders = [
  {
    order_id: 1001n,
    gross_amount: 100,
    discount_percentage: 25,
    customer_segment: "enterprise",
  },
  {
    order_id: 1002n,
    gross_amount: 80,
    discount_percentage: 10,
    customer_segment: "consumer",
  },
  {
    order_id: 1003n,
    gross_amount: 200,
    discount_percentage: 20,
    customer_segment: "enterprise",
  },
  {
    order_id: 1004n,
    gross_amount: 50,
    discount_percentage: null,
    customer_segment: "consumer",
  },
];

export const goldenReplayBase = {
  tables: [
    {
      name: "orders",
      columns: {
        order_id: "BIGINT",
        gross_amount: "DOUBLE",
        discount_percentage: "DOUBLE",
        customer_segment: "VARCHAR",
      },
      rows: orders,
    },
  ],
  beforeSql: `
    SELECT
      order_id,
      gross_amount,
      customer_segment,
      gross_amount * (1 - COALESCE(discount_percentage, 0) / 100.0) AS net_revenue
    FROM orders
  `,
  snapshot: {
    metrics: {
      total_revenue: "SUM(net_revenue)",
      average_revenue: "AVG(net_revenue)",
    },
    distributions: {
      median_revenue: "MEDIAN(net_revenue)",
      enterprise_revenue_share:
        "SUM(net_revenue) FILTER (WHERE customer_segment = 'enterprise') / SUM(net_revenue)",
    },
  },
};

export const dangerousSemanticReplay = {
  ...goldenReplayBase,
  afterSql: `
    SELECT
      order_id,
      gross_amount,
      customer_segment,
      gross_amount * (1 - COALESCE(discount_percentage, 0)) AS net_revenue
    FROM orders
  `,
};

export const safeRefactorReplay = {
  ...goldenReplayBase,
  afterSql: `
    WITH normalized_orders AS (
      SELECT
        order_id,
        gross_amount,
        customer_segment,
        COALESCE(discount_percentage, 0) / 100.0 AS discount_fraction
      FROM orders
    )
    SELECT
      order_id,
      gross_amount,
      customer_segment,
      gross_amount - (gross_amount * discount_fraction) AS net_revenue
    FROM normalized_orders
  `,
};
