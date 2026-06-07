import { query } from '../../config/database.js';
import { ORDER_STATUS, STATUS_GROUPS } from './order-status.js';
import { env } from '../../config/env.js';
import { getProductStorageCapabilities } from '../products/product.repository.js';
import { getAuthStorageCapabilities, hasColumn } from '../auth/auth.storage.js';

const LOW_STOCK_THRESHOLD = env.lowStockThreshold;

async function getDashboardCapabilities() {
  const [product, auth, orderColumns] = await Promise.all([
    getProductStorageCapabilities(),
    getAuthStorageCapabilities(),
    tableColumns('orders'),
  ]);
  return { product, userColumns: auth.userColumns, orderColumns };
}

function activeProductCondition(capabilities, alias = 'p') {
  const conditions = [];
  if (hasColumn(capabilities.productColumns, 'status')) conditions.push(`${alias}.status = 1`);
  if (hasColumn(capabilities.productColumns, 'deleted_at')) conditions.push(`${alias}.deleted_at IS NULL`);
  return conditions.length ? conditions.join(' AND ') : '1 = 1';
}

function productColumn(capabilities, column, fallback = 'NULL', alias = 'p') {
  return hasColumn(capabilities.productColumns, column) ? `${alias}.${column}` : fallback;
}

function firstProductColumn(capabilities, columns, fallback = '0', alias = 'p') {
  const found = columns.find((column) => hasColumn(capabilities.productColumns, column));
  return found ? `${alias}.${found}` : fallback;
}

function productStockExpression(capabilities, alias = 'p') {
  return firstProductColumn(capabilities, ['stock', 'quantity'], '0', alias);
}

function topProductSql(capabilities) {
  const groupBy = ['p.id', 'p.name'];
  const selectColumn = (column, fallback, alias = column) => {
    if (hasColumn(capabilities.productColumns, column)) {
      groupBy.push(`p.${column}`);
      return `p.${column} AS ${alias}`;
    }
    return `${fallback} AS ${alias}`;
  };

  return {
    select: [
      'p.id',
      'p.name',
      selectColumn('image', 'NULL'),
      selectColumn(hasColumn(capabilities.productColumns, 'stock') ? 'stock' : 'quantity', '0', 'stock'),
      selectColumn('price', '0'),
      selectColumn('discount_price', '0'),
    ].join(', '),
    groupBy: groupBy.join(', '),
  };
}

function customerCondition(userColumns, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const conditions = [];
  if (hasColumn(userColumns, 'role')) conditions.push(`UPPER(${prefix}role) NOT IN ('ADMIN', 'STAFF')`);
  if (hasColumn(userColumns, 'status')) {
    conditions.push(`(${prefix}status IS NULL OR ${prefix}status NOT IN ('DISABLED', 'LOCKED'))`);
  }
  if (hasColumn(userColumns, 'deleted_at')) conditions.push(`${prefix}deleted_at IS NULL`);
  return conditions.length ? conditions.join(' AND ') : '1 = 1';
}

function activeVariantCondition(capabilities, alias = 'pv') {
  const conditions = [];
  if (hasColumn(capabilities.variantColumns, 'deleted_at')) conditions.push(`${alias}.deleted_at IS NULL`);
  if (hasColumn(capabilities.variantColumns, 'status')) conditions.push(`ISNULL(${alias}.status, 1) = 1`);
  return conditions.length ? conditions.join(' AND ') : '1 = 1';
}

/**
 * Build a SQL `IN (?, ?, ...)` clause while pushing the actual values into `collector`.
 * This keeps parameter ordering consistent with placeholder positions — the caller
 * doesn't need to remember which status array maps to which set of ? markers.
 */
function collectInClause(statuses, collector) {
  collector.push(...statuses);
  return statuses.map(() => '?').join(', ');
}

function monthStart(column) {
  return `DATEFROMPARTS(YEAR(${column}), MONTH(${column}), 1)`;
}

async function tableColumns(tableName) {
  const rows = await query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = ?`,
    [tableName],
  );
  return new Set(rows.map((row) => String(row.COLUMN_NAME || row.column_name || '').toLowerCase()));
}

function collectRevenueCondition(alias, collector) {
  const completed = collectInClause(STATUS_GROUPS.REVENUE, collector);
  const paidConfirmed = collectInClause(STATUS_GROUPS.PAID_CONFIRMED, collector);
  const paidMethods = collectInClause(STATUS_GROUPS.PAID_METHODS, collector);
  return `(${alias}.status IN (${completed})
       OR (${alias}.status IN (${paidConfirmed}) AND UPPER(ISNULL(${alias}.payment_method, '')) IN (${paidMethods})))`;
}

function orderItemRevenueExpression(product) {
  return hasColumn(product.orderItemColumns, 'price_at_purchase')
    ? 'ISNULL(oi.price_at_purchase, oi.price)'
    : 'oi.price';
}

function dateFilterSql(alias, dateFilter, collector) {
  if (!dateFilter?.start || !dateFilter?.end) return '';
  collector.push(dateFilter.start, dateFilter.end);
  return `AND ${alias}.created_at >= ? AND ${alias}.created_at < ?`;
}

// ────────────────────────────────────────────────────────────
//  Stats
// ────────────────────────────────────────────────────────────

/** Single-query order overview: revenue, counts by status, AOV. */
export async function fetchOrderStats() {
  const p = [];
  // Each collectInClause call must match exactly one occurrence in the SQL.
  // Re-using the same placeholder string (e.g. for REVENUE in both SUM and AVG)
  // would create ? markers with no corresponding param values → SQL error.
  const revSum = collectRevenueCondition('o', p);
  const excluded = collectInClause(STATUS_GROUPS.EXCLUDED_NON_ORDERS, p);
  const completed = collectInClause(STATUS_GROUPS.COMPLETED_MAPPING, p);
  const pending = collectInClause(STATUS_GROUPS.PENDING, p);
  const cancelled = collectInClause(STATUS_GROUPS.CANCELLED_OR_FAILED, p);
  const refunded = collectInClause(STATUS_GROUPS.REFUNDED, p);
  const revAvg = collectRevenueCondition('o', p);

  const [row] = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN ${revSum} THEN o.total ELSE 0 END), 0)                 AS totalRevenue,
       COUNT(CASE WHEN ISNULL(o.status, '') NOT IN (${excluded}) THEN 1 END)          AS totalOrders,
       COUNT(CASE WHEN o.status IN (${completed}) THEN 1 END)                         AS completedOrders,
       COUNT(CASE WHEN o.status IN (${pending}) THEN 1 END)                           AS pendingOrders,
       COUNT(CASE WHEN o.status IN (${cancelled}) THEN 1 END)                         AS cancelledOrders,
       COUNT(CASE WHEN o.status IN (${refunded}) THEN 1 END)                          AS refundedOrders,
       COALESCE(AVG(CASE WHEN ${revAvg} THEN o.total END), 0)                         AS averageOrderValue
     FROM orders o`,
    p,
  );
  return row || {};
}

export async function fetchTotalProducts() {
  const { product } = await getDashboardCapabilities();
  const [row] = await query(
    `SELECT COUNT(*) AS total FROM products p WHERE ${activeProductCondition(product)}`,
  );
  return Number(row?.total || 0);
}

export async function fetchTotalUsers() {
  const { userColumns } = await getDashboardCapabilities();
  const [row] = await query(
    `SELECT COUNT(*) AS total FROM users u
     WHERE ${customerCondition(userColumns, 'u')}`,
  );
  return Number(row?.total || 0);
}

export async function fetchNewUsersThisMonth() {
  const { userColumns } = await getDashboardCapabilities();
  const [row] = await query(
    `SELECT COUNT(*) AS total FROM users u
     WHERE u.created_at >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
       AND ${customerCondition(userColumns, 'u')}`,
  );
  return Number(row?.total || 0);
}

/** 6-month chart series for the stats overview. */
export async function fetchStatsChartSeries() {
  const { userColumns } = await getDashboardCapabilities();
  const sixMonthsAgo = `DATEADD(MONTH, -5, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))`;
  const p1 = [];
  const rev = collectRevenueCondition('o', p1);
  const p2 = [];
  const valid = collectInClause(STATUS_GROUPS.VALID_ORDERS, p2);

  const [revenue, orders, users] = await Promise.all([
    query(
      `SELECT ${monthStart('o.created_at')} AS monthStart, COALESCE(SUM(o.total), 0) AS revenue
       FROM orders o WHERE ${rev} AND o.created_at >= ${sixMonthsAgo}
       GROUP BY ${monthStart('o.created_at')} ORDER BY monthStart ASC`,
      p1,
    ),
    query(
      `SELECT ${monthStart('o.created_at')} AS monthStart, COUNT(*) AS orders
       FROM orders o WHERE o.status IN (${valid}) AND o.created_at >= ${sixMonthsAgo}
       GROUP BY ${monthStart('o.created_at')} ORDER BY monthStart ASC`,
      p2,
    ),
    query(
      `SELECT ${monthStart('u.created_at')} AS monthStart, COUNT(*) AS users
       FROM users u
       WHERE u.created_at >= ${sixMonthsAgo}
         AND ${customerCondition(userColumns, 'u')}
       GROUP BY ${monthStart('u.created_at')} ORDER BY monthStart ASC`,
    ),
  ]);
  return { revenue, orders, users };
}

export async function fetchRecentOrderTrend(days = 14) {
  const safeDays = Math.max(2, Math.min(60, Number(days) || 14));
  const daysBack = safeDays - 1;
  const p = [];
  const rev = collectRevenueCondition('o', p);
  const valid = collectInClause(STATUS_GROUPS.VALID_ORDERS, p);

  return query(
    `WITH day_series AS (
       SELECT CAST(DATEADD(day, -${daysBack}, CAST(GETDATE() AS date)) AS date) AS dayDate
       UNION ALL
       SELECT DATEADD(day, 1, dayDate)
       FROM day_series
       WHERE dayDate < CAST(GETDATE() AS date)
     ),
     daily_orders AS (
       SELECT CONVERT(date, o.created_at) AS dayDate,
              COUNT(*) AS orders,
              COALESCE(SUM(CASE WHEN ${rev} THEN o.total ELSE 0 END), 0) AS revenue
       FROM orders o
       WHERE o.status IN (${valid})
         AND o.created_at >= DATEADD(day, -${daysBack}, CAST(GETDATE() AS date))
         AND o.created_at < DATEADD(day, 1, CAST(GETDATE() AS date))
       GROUP BY CONVERT(date, o.created_at)
     )
     SELECT ds.dayDate AS date,
            ISNULL(d.orders, 0) AS orders,
            ISNULL(d.revenue, 0) AS revenue
     FROM day_series ds
     LEFT JOIN daily_orders d ON d.dayDate = ds.dayDate
     ORDER BY ds.dayDate ASC`,
    p,
  );
}

/** Top N products by sold quantity, optionally filtered by date range. */
export async function fetchTopProducts(limit, dateFilter) {
  const { product } = await getDashboardCapabilities();
  const p = [];
  const rev = collectRevenueCondition('o', p);
  const itemRevenue = hasColumn(product.orderItemColumns, 'price_at_purchase')
    ? 'oi.price_at_purchase'
    : 'oi.price';
  const productSql = topProductSql(product);
  let dateCondition = '';
  if (dateFilter) {
    p.push(dateFilter.start, dateFilter.end);
    dateCondition = 'AND o.created_at >= ? AND o.created_at < ?';
  }

  return query(
    `SELECT TOP ${Number(limit)} ${productSql.select},
            COALESCE(SUM(oi.quantity), 0) AS totalSold,
            COALESCE(SUM(oi.quantity * ${itemRevenue}), 0) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     WHERE ${rev} ${dateCondition}
       AND ${activeProductCondition(product)}
     GROUP BY ${productSql.groupBy}
     ORDER BY totalSold DESC`,
    p,
  );
}

/** Combined low-stock count: simple products + variants below threshold. */
export async function fetchLowStockCount() {
  const { product } = await getDashboardCapabilities();
  const stockExpr = productStockExpression(product);
  const variantFilter = product.hasVariants
    ? `AND NOT EXISTS (
         SELECT 1 FROM product_variants pv
         WHERE pv.product_id = p.id AND ${activeVariantCondition(product)}
       )`
    : '';
  const products = await query(
    `SELECT COUNT(*) AS total FROM products p
     WHERE ${activeProductCondition(product)} AND ISNULL(${stockExpr}, 0) < ?
       ${variantFilter}`,
    [LOW_STOCK_THRESHOLD],
  );
  const variants = product.hasVariants && hasColumn(product.variantColumns, 'stock_quantity')
    ? await query(
        `SELECT COUNT(*) AS total FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
         WHERE ${activeProductCondition(product)}
           AND ${activeVariantCondition(product)}
           AND pv.stock_quantity < ?`,
        [LOW_STOCK_THRESHOLD],
      )
    : [];
  return Number(products[0]?.total || 0) + Number(variants[0]?.total || 0);
}

export async function fetchLowStockProductCount() {
  const { product } = await getDashboardCapabilities();
  const stockExpr = productStockExpression(product);
  const [row] = await query(
    `SELECT COUNT(*) AS total
     FROM products p
     WHERE ${activeProductCondition(product)}
       AND ISNULL(${stockExpr}, 0) <= 5`,
  );
  return Number(row?.total || 0);
}

export async function fetchOperationalOrderCounts() {
  const p = [];
  const newStatuses = collectInClause([
    ORDER_STATUS.PENDING_PAYMENT,
    ORDER_STATUS.PENDING,
    ORDER_STATUS.CONFIRMED,
    'Waiting',
    'Paid',
    'Chờ xác nhận',
  ], p);
  const shippingStatuses = collectInClause([
    ORDER_STATUS.SHIPPING,
    'Shipped',
    'Đang giao',
  ], p);
  const completed = collectInClause(STATUS_GROUPS.COMPLETED_MAPPING, p);
  const cancelled = collectInClause(STATUS_GROUPS.CANCELLED_OR_FAILED, p);
  const excluded = collectInClause(STATUS_GROUPS.EXCLUDED_NON_ORDERS, p);

  const [row] = await query(
    `SELECT
       COUNT(CASE WHEN o.status IN (${newStatuses}) THEN 1 END) AS newOrdersToProcess,
       COUNT(CASE WHEN o.status IN (${shippingStatuses}) THEN 1 END) AS shippingOrders,
       COUNT(CASE WHEN o.status IN (${completed}) THEN 1 END) AS completedOrders,
       COUNT(CASE WHEN o.status IN (${cancelled}) THEN 1 END) AS cancelledOrders,
       COUNT(CASE WHEN ISNULL(o.status, '') NOT IN (${excluded}) THEN 1 END) AS totalOrders
     FROM orders o`,
    p,
  );
  return row || {};
}

export async function fetchRevenueSplitByItemType(dateFilter = null) {
  const { product } = await getDashboardCapabilities();
  const p = [];
  const rev = collectRevenueCondition('o', p);
  const itemRevenue = orderItemRevenueExpression(product);
  const hasItemType = hasColumn(product.orderItemColumns, 'item_type');
  const hasSelectedVolume = hasColumn(product.orderItemColumns, 'selected_volume_ml');
  const hasOrderItemVariantId = hasColumn(product.orderItemColumns, 'product_variant_id');
  const hasVariantType = product.hasVariants && hasColumn(product.variantColumns, 'variant_type');
  const joinVariant = hasOrderItemVariantId && hasVariantType
    ? 'LEFT JOIN product_variants pv ON pv.id = oi.product_variant_id'
    : '';
  const itemTypeExpr = hasItemType ? "UPPER(ISNULL(oi.item_type, N'FULL_BOTTLE'))" : "N'FULL_BOTTLE'";
  const variantTypeExpr = joinVariant ? "UPPER(ISNULL(pv.variant_type, N''))" : "N''";
  const selectedVolumeExpr = hasSelectedVolume ? 'ISNULL(oi.selected_volume_ml, 0)' : '0';
  const decantCondition = `(${itemTypeExpr} = N'DECANT' OR ${variantTypeExpr} = N'DECANT' OR ${selectedVolumeExpr} > 0)`;
  const dateSql = dateFilterSql('o', dateFilter, p);

  const [row] = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN ${decantCondition} THEN oi.quantity * ${itemRevenue} ELSE 0 END), 0) AS decantRevenue,
       COALESCE(SUM(CASE WHEN ${decantCondition} THEN 0 ELSE oi.quantity * ${itemRevenue} END), 0) AS fullBottleRevenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     ${joinVariant}
     WHERE ${rev} ${dateSql}`,
    p,
  );
  return row || {};
}

export async function fetchPaymentMethodBreakdown(dateFilter = null) {
  const p = [];
  const rev = collectRevenueCondition('o', p);
  const valid = collectInClause(STATUS_GROUPS.VALID_ORDERS, p);
  const dateSql = dateFilterSql('o', dateFilter, p);

  return query(
    `SELECT UPPER(ISNULL(NULLIF(LTRIM(RTRIM(o.payment_method)), ''), 'UNKNOWN')) AS method,
            COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN ${rev} THEN o.total ELSE 0 END), 0) AS revenue
     FROM orders o
     WHERE o.status IN (${valid}) ${dateSql}
     GROUP BY UPPER(ISNULL(NULLIF(LTRIM(RTRIM(o.payment_method)), ''), 'UNKNOWN'))
     ORDER BY orders DESC`,
    p,
  );
}

export async function fetchTopBrands(limit = 5, dateFilter = null) {
  const { product } = await getDashboardCapabilities();
  if (!product.hasBrand || !hasColumn(product.productColumns, 'id_brand')) return [];

  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
  const p = [];
  const rev = collectRevenueCondition('o', p);
  const itemRevenue = orderItemRevenueExpression(product);
  const dateSql = dateFilterSql('o', dateFilter, p);
  const brandName = hasColumn(product.brandColumns, 'name') ? 'b.name' : 'CONVERT(nvarchar(50), b.id)';

  return query(
    `SELECT TOP ${safeLimit} b.id,
            ${brandName} AS name,
            COALESCE(SUM(oi.quantity), 0) AS totalSold,
            COALESCE(SUM(oi.quantity * ${itemRevenue}), 0) AS revenue,
            COUNT(DISTINCT o.id) AS orders
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     JOIN brand b ON b.id = p.id_brand
     WHERE ${rev} ${dateSql}
       AND ${activeProductCondition(product)}
     GROUP BY b.id, ${brandName}
     ORDER BY revenue DESC, totalSold DESC`,
    p,
  );
}

export async function fetchTopCustomers(limit = 5, dateFilter = null) {
  const { userColumns } = await getDashboardCapabilities();
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
  const p = [];
  const rev = collectRevenueCondition('o', p);
  const valid = collectInClause(STATUS_GROUPS.VALID_ORDERS, p);
  const dateSql = dateFilterSql('o', dateFilter, p);

  return query(
    `SELECT TOP ${safeLimit}
            u.id,
            COALESCE(u.name, u.email, N'Khách hàng') AS name,
            COALESCE(u.email, '') AS email,
            COUNT(DISTINCT o.id) AS orders,
            COALESCE(SUM(CASE WHEN ${rev} THEN o.total ELSE 0 END), 0) AS totalSpent
     FROM orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.status IN (${valid}) ${dateSql}
       AND ${customerCondition(userColumns, 'u')}
     GROUP BY u.id, u.name, u.email
     ORDER BY totalSpent DESC, orders DESC`,
    p,
  );
}

export async function fetchLowStockProducts(limit = 5, { threshold = LOW_STOCK_THRESHOLD, outOfStock = false } = {}) {
  const { product } = await getDashboardCapabilities();
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 5));
  const safeThreshold = outOfStock ? 0 : Number(threshold ?? LOW_STOCK_THRESHOLD);
  const operator = outOfStock ? '<=' : '<=';
  const stockExpr = productStockExpression(product);
  const productVariantExclusion = product.hasVariants
    ? `AND NOT EXISTS (
         SELECT 1 FROM product_variants pv
         WHERE pv.product_id = p.id AND ${activeVariantCondition(product)}
       )`
    : '';

  const productRows = await query(
    `SELECT TOP ${safeLimit}
            p.id,
            p.name,
            ${productColumn(product, 'image', 'NULL')} AS image,
            ${productColumn(product, 'sku', 'NULL')} AS sku,
            CAST(NULL AS INT) AS variantId,
            CAST(NULL AS NVARCHAR(120)) AS variantLabel,
            ISNULL(${stockExpr}, 0) AS stock,
            ${productColumn(product, 'price', '0')} AS price,
            ${productColumn(product, 'discount_price', '0')} AS discount_price
     FROM products p
     WHERE ${activeProductCondition(product)}
       AND ISNULL(${stockExpr}, 0) ${operator} ?
       ${productVariantExclusion}
     ORDER BY stock ASC, p.name ASC`,
    [safeThreshold],
  );

  let variantRows = [];
  if (product.hasVariants && hasColumn(product.variantColumns, 'stock_quantity')) {
    const labelCandidates = [];
    if (hasColumn(product.variantColumns, 'volume_label')) labelCandidates.push("NULLIF(pv.volume_label, N'')");
    if (hasColumn(product.variantColumns, 'volume_ml')) labelCandidates.push("CONCAT(pv.volume_ml, N'ml')");
    if (hasColumn(product.variantColumns, 'sku')) labelCandidates.push("NULLIF(pv.sku, N'')");
    const variantLabel = labelCandidates.length ? `COALESCE(${labelCandidates.join(', ')}, N'')` : "N''";
    const variantPrice = hasColumn(product.variantColumns, 'price') ? 'pv.price' : '0';
    const variantSalePrice = hasColumn(product.variantColumns, 'sale_price') ? 'pv.sale_price' : '0';

    variantRows = await query(
      `SELECT TOP ${safeLimit}
              p.id,
              p.name,
              ${productColumn(product, 'image', 'NULL')} AS image,
              ${productColumn(product, 'sku', 'NULL')} AS sku,
              pv.id AS variantId,
              ${variantLabel} AS variantLabel,
              ISNULL(pv.stock_quantity, 0) AS stock,
              ${variantPrice} AS price,
              ${variantSalePrice} AS discount_price
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE ${activeProductCondition(product)}
         AND ${activeVariantCondition(product)}
         AND ISNULL(pv.stock_quantity, 0) ${operator} ?
       ORDER BY stock ASC, p.name ASC`,
      [safeThreshold],
    );
  }

  return [...productRows, ...variantRows]
    .sort((a, b) => Number(a.stock || 0) - Number(b.stock || 0))
    .slice(0, safeLimit);
}

export async function fetchPendingReviews(limit = 5) {
  const { product } = await getDashboardCapabilities();
  if (!product.hasProductReviews) return [];

  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
  const reviewColumns = await tableColumns('product_reviews');
  const deletedFilter = hasColumn(reviewColumns, 'deleted_at') ? 'AND r.deleted_at IS NULL' : '';
  return query(
    `SELECT TOP ${safeLimit}
            r.id,
            r.product_id,
            r.user_id,
            r.rating,
            r.title,
            r.comment,
            r.created_at,
            p.name AS product_name,
            p.image AS product_image,
            u.name AS user_name
     FROM product_reviews r
     LEFT JOIN products p ON p.id = r.product_id
     LEFT JOIN users u ON u.id = r.user_id
     WHERE r.status = N'PENDING' ${deletedFilter}
     ORDER BY r.created_at DESC, r.id DESC`,
  );
}

export async function fetchRevenueLastDays(days = 7) {
  const safeDays = Math.max(2, Math.min(31, Number(days) || 7));
  const daysBack = safeDays - 1;
  const p = [];
  const rev = collectRevenueCondition('o', p);
  const valid = collectInClause(STATUS_GROUPS.VALID_ORDERS, p);

  return query(
    `WITH day_series AS (
       SELECT CAST(DATEADD(day, -${daysBack}, CAST(GETDATE() AS date)) AS date) AS dayDate
       UNION ALL
       SELECT DATEADD(day, 1, dayDate)
       FROM day_series
       WHERE dayDate < CAST(GETDATE() AS date)
     ),
     daily AS (
       SELECT CONVERT(date, o.created_at) AS dayDate,
              COALESCE(SUM(CASE WHEN ${rev} THEN o.total ELSE 0 END), 0) AS revenue,
              COUNT(CASE WHEN o.status IN (${valid}) THEN 1 END) AS orders
       FROM orders o
       WHERE o.created_at >= DATEADD(day, -${daysBack}, CAST(GETDATE() AS date))
         AND o.created_at < DATEADD(day, 1, CAST(GETDATE() AS date))
       GROUP BY CONVERT(date, o.created_at)
     )
     SELECT ds.dayDate AS date,
            ISNULL(d.revenue, 0) AS revenue,
            ISNULL(d.orders, 0) AS orders
     FROM day_series ds
     LEFT JOIN daily d ON d.dayDate = ds.dayDate
     ORDER BY ds.dayDate ASC`,
    p,
  );
}

export async function fetchRevenueByMonth(months = 12) {
  const safeMonths = Math.max(2, Math.min(24, Number(months) || 12));
  const p = [];
  const rev = collectRevenueCondition('o', p);
  const valid = collectInClause(STATUS_GROUPS.VALID_ORDERS, p);
  const startExpr = `DATEADD(MONTH, -${safeMonths - 1}, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))`;

  return query(
    `SELECT ${monthStart('o.created_at')} AS monthStart,
            COALESCE(SUM(CASE WHEN ${rev} THEN o.total ELSE 0 END), 0) AS revenue,
            COUNT(CASE WHEN o.status IN (${valid}) THEN 1 END) AS orders
     FROM orders o
     WHERE o.created_at >= ${startExpr}
     GROUP BY ${monthStart('o.created_at')}
     ORDER BY monthStart ASC`,
    p,
  );
}

// ────────────────────────────────────────────────────────────
//  Summary (date-window aware)
// ────────────────────────────────────────────────────────────

export async function fetchRevenueInPeriod(start, end) {
  const p = [];
  const rev = collectRevenueCondition('o', p);
  p.push(start, end);
  const [row] = await query(
    `SELECT COALESCE(SUM(o.total), 0) AS value
     FROM orders o
     WHERE ${rev} AND o.created_at >= ? AND o.created_at < ?`,
    p,
  );
  return Number(row?.value || 0);
}

export async function fetchOrderCountInPeriod(start, end) {
  const p = [];
  const valid = collectInClause(STATUS_GROUPS.VALID_ORDERS, p);
  p.push(start, end);
  const [row] = await query(
    `SELECT COUNT(*) AS value FROM orders
     WHERE status IN (${valid}) AND created_at >= ? AND created_at < ?`,
    p,
  );
  return Number(row?.value || 0);
}

export async function fetchCustomerCountInPeriod(start, end) {
  const p = [];
  const valid = collectInClause(STATUS_GROUPS.VALID_ORDERS, p);
  p.push(start, end);
  const [row] = await query(
    `SELECT COUNT(DISTINCT user_id) AS value FROM orders
     WHERE status IN (${valid}) AND user_id IS NOT NULL
       AND created_at >= ? AND created_at < ?`,
    p,
  );
  return Number(row?.value || 0);
}

export async function fetchNewProductsInPeriod(start, end) {
  const { product } = await getDashboardCapabilities();
  const [row] = await query(
    `SELECT COUNT(*) AS value FROM products p
     WHERE ${activeProductCondition(product)} AND p.created_at >= ? AND p.created_at < ?`,
    [start, end],
  );
  return Number(row?.value || 0);
}

/** All four order status counts in one query. */
export async function fetchOrderStatusBreakdown(start, end) {
  const p = [];
  const pending = collectInClause(STATUS_GROUPS.PENDING, p);
  const completed = collectInClause(STATUS_GROUPS.COMPLETED_MAPPING, p);
  const cancelled = collectInClause(STATUS_GROUPS.CANCELLED_OR_FAILED, p);
  const refunded = collectInClause(STATUS_GROUPS.REFUNDED, p);
  const dateCondition = start && end ? 'WHERE o.created_at >= ? AND o.created_at < ?' : '';
  if (dateCondition) p.push(start, end);

  const [row] = await query(
    `SELECT
       COUNT(CASE WHEN o.status IN (${pending}) THEN 1 END)   AS pendingOrders,
       COUNT(CASE WHEN o.status IN (${completed}) THEN 1 END) AS completedOrders,
       COUNT(CASE WHEN o.status IN (${cancelled}) THEN 1 END) AS cancelledOrders,
       COUNT(CASE WHEN o.status IN (${refunded}) THEN 1 END)  AS refundedOrders
     FROM orders o
     ${dateCondition}`,
    p,
  );
  return row || {};
}

export async function fetchTopCategories(limit, start, end) {
  const { product } = await getDashboardCapabilities();
  if (!product.hasCategories || !hasColumn(product.productColumns, 'id_category')) {
    return [];
  }

  const p = [];
  const rev = collectRevenueCondition('o', p);
  p.push(start, end);
  const categoryName = hasColumn(product.categoryColumns, 'name')
    ? 'c.name'
    : 'CONVERT(nvarchar(50), c.id)';
  return query(
    `SELECT TOP ${Number(limit)} c.id, ${categoryName} AS name,
            COALESCE(SUM(oi.quantity), 0) AS totalSold
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     JOIN categories c ON c.id = p.id_category
     WHERE ${rev}
       AND o.created_at >= ? AND o.created_at < ?
       AND ${activeProductCondition(product)}
     GROUP BY c.id, ${categoryName}
     ORDER BY totalSold DESC`,
    p,
  );
}

export async function fetchRecentOrders(limit) {
  const { orderColumns } = await getDashboardCapabilities();
  const orderCodeSelect = hasColumn(orderColumns, 'order_code')
    ? "COALESCE(NULLIF(o.order_code, N''), CONCAT(N'#', o.id)) AS order_code"
    : "CONCAT(N'#', o.id) AS order_code";
  return query(
    `SELECT TOP ${Number(limit)} o.id, o.total, o.status, o.payment_method, o.created_at,
            ${orderCodeSelect},
            COALESCE(u.name, N'Khách vãng lai') AS customer_name,
            COALESCE(u.email, '') AS customer_email
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     WHERE LOWER(ISNULL(o.status, '')) <> 'cart'
     ORDER BY o.created_at DESC, o.id DESC`,
  );
}

// ────────────────────────────────────────────────────────────
//  Charts
// ────────────────────────────────────────────────────────────

export async function fetchChartRevenue(groupExpr, start, end) {
  const p = [];
  const rev = collectRevenueCondition('o', p);
  p.push(start, end);
  return query(
    `SELECT ${groupExpr} AS period, COALESCE(SUM(total), 0) AS revenue
     FROM orders o
     WHERE ${rev} AND o.created_at >= ? AND o.created_at < ?
     GROUP BY ${groupExpr} ORDER BY period`,
    p,
  );
}

export async function fetchChartOrders(groupExpr, start, end) {
  const p = [];
  const valid = collectInClause(STATUS_GROUPS.VALID_ORDERS, p);
  p.push(start, end);
  return query(
    `SELECT ${groupExpr} AS period, COUNT(*) AS orders
     FROM orders o
     WHERE o.status IN (${valid}) AND o.created_at >= ? AND o.created_at < ?
     GROUP BY ${groupExpr} ORDER BY period`,
    p,
  );
}

export async function fetchChartCustomers(groupExpr, start, end) {
  const p = [];
  const valid = collectInClause(STATUS_GROUPS.VALID_ORDERS, p);
  p.push(start, end);
  return query(
    `SELECT ${groupExpr} AS period, COUNT(DISTINCT user_id) AS customers
     FROM orders o
     WHERE o.status IN (${valid}) AND o.user_id IS NOT NULL
       AND o.created_at >= ? AND o.created_at < ?
     GROUP BY ${groupExpr} ORDER BY period`,
    p,
  );
}
