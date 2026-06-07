import * as repo from './dashboard.repository.js';
import * as mapper from './dashboard.mapper.js';
import { getLowStockAlerts } from '../../models/adminInventoryModel.js';
import { normalizeOrderStatus } from '../../constants/orderStatus.js';

// ────────────────────────────────────────────────────────────
//  Date helpers
// ────────────────────────────────────────────────────────────

function subtractDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() - days);
  return d;
}

function subtractMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() - months);
  return d;
}

function toSqlDate(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDateString(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toMonthStartString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

function buildRecentMonthStarts(months = 6) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  return Array.from({ length: months }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth() + index, 1);
    return toMonthStartString(date);
  });
}

function normalizeMonthlySeries(rows = [], valueField, outputField) {
  const values = new Map(
    rows.map((row) => [toMonthStartString(row.monthStart), Number(row[valueField] || 0)])
  );
  return buildRecentMonthStarts(6).map((monthStart) => ({
    monthStart,
    [outputField]: values.get(monthStart) || 0,
  }));
}

function normalizeMonthlyRevenueRows(rows = [], months = 12) {
  const values = new Map(
    rows.map((row) => [toMonthStartString(row.monthStart), {
      revenue: Number(row.revenue || 0),
      orders: Number(row.orders || 0),
    }])
  );
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  return Array.from({ length: months }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth() + index, 1);
    const monthStart = toMonthStartString(date);
    return {
      monthStart,
      revenue: values.get(monthStart)?.revenue || 0,
      orders: values.get(monthStart)?.orders || 0,
    };
  });
}

function toPercent(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((Number(numerator || 0) / Number(denominator || 0)) * 100).toFixed(1));
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Resolve { range, from, to } into four SQL-date boundaries:
 * currentStart, currentEnd, previousStart, previousEnd.
 *
 * Rules:
 *  - If `from` is given, use it as currentStart; `to` defaults to tomorrow.
 *  - Otherwise use `range` (7d / 30d / 90d / 12m) anchored to today.
 *  - The previous window has the same duration as the current window,
 *    ending exactly where the current window begins.
 */
function resolveDateWindows({ range, from, to }) {
  const now = new Date();
  let currentStart, currentEnd;

  if (from) {
    currentStart = startOfDay(new Date(from + 'T00:00:00'));
    if (to) {
      const toDate = startOfDay(new Date(to + 'T00:00:00'));
      toDate.setDate(toDate.getDate() + 1);
      currentEnd = toDate;
    } else {
      currentEnd = startOfDay(new Date(now.getTime() + 86400000));
    }
  } else {
    const tomorrow = startOfDay(new Date(now.getTime() + 86400000));
    switch (range || '30d') {
      case '7d':
        currentStart = startOfDay(subtractDays(tomorrow, 7));
        break;
      case '90d':
        currentStart = startOfDay(subtractDays(tomorrow, 90));
        break;
      case '12m':
        currentStart = startOfDay(subtractMonths(now, 12));
        break;
      case '30d':
      default:
        currentStart = startOfDay(subtractDays(tomorrow, 30));
        break;
    }
    currentEnd = tomorrow;
  }

  const periodMs = currentEnd.getTime() - currentStart.getTime();
  const previousEnd = new Date(currentStart.getTime());
  const previousStart = new Date(previousEnd.getTime() - periodMs);

  return {
    currentStart: toSqlDate(currentStart),
    currentEnd: toSqlDate(currentEnd),
    previousStart: toSqlDate(previousStart),
    previousEnd: toSqlDate(previousEnd),
  };
}

function calcGrowth(current, previous) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function calcTrendGrowth(rows = []) {
  const midpoint = Math.floor(rows.length / 2);
  const previous = rows.slice(0, midpoint).reduce((sum, row) => sum + Number(row.orders || 0), 0);
  const current = rows.slice(midpoint).reduce((sum, row) => sum + Number(row.orders || 0), 0);
  return calcGrowth(current, previous);
}

// ────────────────────────────────────────────────────────────
//  Chart helpers (group-by & zero-fill)
// ────────────────────────────────────────────────────────────

function groupByExpr(column, groupBy) {
  switch (groupBy) {
    case 'day':
      return `CONVERT(date, ${column})`;
    case 'week':
      return `DATEADD(DAY, 1 - DATEPART(WEEKDAY, ${column}), CONVERT(date, ${column}))`;
    case 'month':
      return `DATEFROMPARTS(YEAR(${column}), MONTH(${column}), 1)`;
    default:
      return `CONVERT(date, ${column})`;
  }
}

function buildSeriesMap(rows, keyField, valueField) {
  const map = new Map();
  for (const row of rows) {
    const key = row[keyField];
    const d = key instanceof Date ? key : new Date(key);
    map.set(toDateString(d), Number(row[valueField] || 0));
  }
  return map;
}

function generatePeriods(startDate, endDate, groupBy) {
  const periods = [];
  const current = new Date(startDate);
  const end = new Date(endDate);

  while (current < end) {
    switch (groupBy) {
      case 'day':
        periods.push(toDateString(current));
        current.setDate(current.getDate() + 1);
        break;
      case 'week': {
        const dayOfWeek = current.getDay();
        const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const mon = new Date(current);
        mon.setDate(mon.getDate() - daysFromMonday);
        periods.push(toDateString(mon));
        current.setDate(current.getDate() + 7);
        break;
      }
      case 'month':
        periods.push(toDateString(new Date(current.getFullYear(), current.getMonth(), 1)));
        current.setMonth(current.getMonth() + 1);
        break;
      default:
        periods.push(toDateString(current));
        current.setDate(current.getDate() + 1);
    }
  }
  return periods;
}

function mergeChartSeries(periods, revenueMap, ordersMap, customersMap) {
  return periods.map((period) => ({
    date: period,
    revenue: revenueMap.get(period) || 0,
    orders: ordersMap.get(period) || 0,
    customers: customersMap.get(period) || 0,
  }));
}

// ────────────────────────────────────────────────────────────
//  Public API
// ────────────────────────────────────────────────────────────

/**
 * Quick overview stats — revenue, orders, users, products, low-stock,
 * plus 6-month sparkline data and top 10 products.
 */
export async function getStats() {
  const now = new Date();
  const todayStart = toSqlDate(startOfDay(now));
  const tomorrow = startOfDay(new Date(now.getTime() + 86400000));
  const tomorrowStart = toSqlDate(tomorrow);
  const monthStart = toSqlDate(startOfMonth(now));
  const currentMonthFilter = { start: monthStart, end: tomorrowStart };

  const [
    orderStats,
    operationalCounts,
    revenueToday,
    revenueThisMonth,
    totalProducts,
    totalUsers,
    newUsersThisMonth,
    chartSeries,
    orderTrendRows,
    revenue7DaysRows,
    monthlyRevenueRows,
    topProductRows,
    topBrandRows,
    revenueSplit,
    paymentMethodRows,
    lowStockProducts,
    lowStockRows,
    outOfStockRows,
    topCustomerRows,
    pendingReviewRows,
    recentOrderRows,
  ] = await Promise.all([
    repo.fetchOrderStats(),
    repo.fetchOperationalOrderCounts(),
    repo.fetchRevenueInPeriod(todayStart, tomorrowStart),
    repo.fetchRevenueInPeriod(monthStart, tomorrowStart),
    repo.fetchTotalProducts(),
    repo.fetchTotalUsers(),
    repo.fetchNewUsersThisMonth(),
    repo.fetchStatsChartSeries(),
    repo.fetchRecentOrderTrend(14),
    repo.fetchRevenueLastDays(7),
    repo.fetchRevenueByMonth(12),
    repo.fetchTopProducts(10, null),
    repo.fetchTopBrands(5, currentMonthFilter),
    repo.fetchRevenueSplitByItemType(currentMonthFilter),
    repo.fetchPaymentMethodBreakdown(currentMonthFilter),
    repo.fetchLowStockProductCount(),
    repo.fetchLowStockProducts(5),
    repo.fetchLowStockProducts(5, { outOfStock: true }),
    repo.fetchTopCustomers(5, currentMonthFilter),
    repo.fetchPendingReviews(5),
    repo.fetchRecentOrders(8),
  ]);

  const stats = mapper.toOrderStats(orderStats);
  const totalOperationalOrders = Number(operationalCounts.totalOrders || stats.totalOrders || 0);
  const cancelledOperationalOrders = Number(operationalCounts.cancelledOrders || stats.cancelledOrders || 0);
  return {
    ...stats,
    revenueToday,
    revenueThisMonth,
    newOrdersToProcess: Number(operationalCounts.newOrdersToProcess || 0),
    shippingOrders: Number(operationalCounts.shippingOrders || 0),
    cancelRate: toPercent(cancelledOperationalOrders, totalOperationalOrders),
    fullBottleRevenue: Number(revenueSplit.fullBottleRevenue || 0),
    decantRevenue: Number(revenueSplit.decantRevenue || 0),
    totalProducts,
    totalUsers,
    newUsersThisMonth,
    lowStockProducts,
    lowStockCount: lowStockProducts,
    outOfStockProducts: outOfStockRows.length,
    charts: {
      revenue: normalizeMonthlySeries(chartSeries.revenue, 'revenue', 'revenue'),
      orders: normalizeMonthlySeries(chartSeries.orders, 'orders', 'orders'),
      users: normalizeMonthlySeries(chartSeries.users, 'users', 'users'),
      revenue7Days: revenue7DaysRows.map((row) => ({
        date: toDateString(row.date),
        revenue: Number(row.revenue || 0),
        orders: Number(row.orders || 0),
      })),
      monthlyRevenue: normalizeMonthlyRevenueRows(monthlyRevenueRows, 12),
      paymentMethods: paymentMethodRows.map(mapper.toPaymentMethod),
    },
    orderGrowth: calcTrendGrowth(orderTrendRows),
    orderTrend: orderTrendRows.map((row) => ({
      date: toDateString(row.date),
      orders: Number(row.orders || 0),
      revenue: Number(row.revenue || 0),
    })),
    topProducts: topProductRows.map(mapper.toTopProduct),
    topBrands: topBrandRows.map(mapper.toTopBrand),
    lowStockItems: lowStockRows.map(mapper.toLowStockProduct),
    outOfStockItems: outOfStockRows.map(mapper.toLowStockProduct),
    topCustomers: topCustomerRows.map(mapper.toTopCustomer),
    pendingReviews: pendingReviewRows.map(mapper.toPendingReview),
    recentOrders: recentOrderRows.map((row) => ({
      id: Number(row.id),
      orderCode: row.order_code || `#${row.id}`,
      userName: row.customer_name || 'Khách vãng lai',
      total: Number(row.total || 0),
      status: normalizeOrderStatus(row.status),
      createdAt: row.created_at,
    })),
  };
}

/**
 * Detailed summary within a configurable date window.
 * Includes growth percentages (current vs previous period).
 */
export async function getSummary(params = {}) {
  const { currentStart, currentEnd, previousStart, previousEnd } = resolveDateWindows(params);

  const [
    revenueCurr,
    revenuePrev,
    ordersCurr,
    ordersPrev,
    customersCurr,
    customersPrev,
    totalProducts,
    newProductsCurr,
    newProductsPrev,
    statusBreakdown,
    lowStockCount,
    topProductRows,
    topCategoryRows,
    recentOrderRows,
    alerts,
  ] = await Promise.all([
    repo.fetchRevenueInPeriod(currentStart, currentEnd),
    repo.fetchRevenueInPeriod(previousStart, previousEnd),
    repo.fetchOrderCountInPeriod(currentStart, currentEnd),
    repo.fetchOrderCountInPeriod(previousStart, previousEnd),
    repo.fetchCustomerCountInPeriod(currentStart, currentEnd),
    repo.fetchCustomerCountInPeriod(previousStart, previousEnd),
    repo.fetchTotalProducts(),
    repo.fetchNewProductsInPeriod(currentStart, currentEnd),
    repo.fetchNewProductsInPeriod(previousStart, previousEnd),
    repo.fetchOrderStatusBreakdown(currentStart, currentEnd),
    repo.fetchLowStockCount(),
    repo.fetchTopProducts(5, { start: currentStart, end: currentEnd }),
    repo.fetchTopCategories(5, currentStart, currentEnd),
    repo.fetchRecentOrders(5),
    getLowStockAlerts(),
  ]);

  return {
    summary: {
      totalRevenue: revenueCurr,
      totalOrders: ordersCurr,
      totalCustomers: customersCurr,
      totalProducts,
      lowStockCount,
      pendingOrders: Number(statusBreakdown.pendingOrders || 0),
      completedOrders: Number(statusBreakdown.completedOrders || 0),
      cancelledOrders: Number(statusBreakdown.cancelledOrders || 0),
      refundedOrders: Number(statusBreakdown.refundedOrders || 0),
    },
    trend: {
      revenueGrowth: calcGrowth(revenueCurr, revenuePrev),
      orderGrowth: calcGrowth(ordersCurr, ordersPrev),
      customerGrowth: calcGrowth(customersCurr, customersPrev),
      productGrowth: calcGrowth(newProductsCurr, newProductsPrev),
    },
    topProducts: topProductRows.map(mapper.toTopProduct),
    topCategories: topCategoryRows.map(mapper.toTopCategory),
    recentOrders: recentOrderRows.map(mapper.toRecentOrder),
    alerts: mapper.transformAlerts(alerts),
  };
}

/**
 * Time-series chart data (revenue, orders, customers) grouped by day/week/month.
 * Missing periods are zero-filled so the frontend always gets a contiguous array.
 */
export async function getCharts(params = {}) {
  const { currentStart, currentEnd } = resolveDateWindows(params);

  const resolvedGroupBy = params.groupBy || (params.range === '90d' ? 'month' : 'day');
  const resolvedRange = params.range || (params.from ? 'custom' : '30d');

  const groupExpr = groupByExpr('o.created_at', resolvedGroupBy);

  const [revenueRows, orderRows, customerRows] = await Promise.all([
    repo.fetchChartRevenue(groupExpr, currentStart, currentEnd),
    repo.fetchChartOrders(groupExpr, currentStart, currentEnd),
    repo.fetchChartCustomers(groupExpr, currentStart, currentEnd),
  ]);

  const revenueMap = buildSeriesMap(revenueRows, 'period', 'revenue');
  const ordersMap = buildSeriesMap(orderRows, 'period', 'orders');
  const customersMap = buildSeriesMap(customerRows, 'period', 'customers');

  const periods = generatePeriods(new Date(currentStart), new Date(currentEnd), resolvedGroupBy);

  return {
    range: resolvedRange,
    groupBy: resolvedGroupBy,
    startDate: toDateString(new Date(currentStart)),
    endDate: toDateString(new Date(currentEnd)),
    data: mergeChartSeries(periods, revenueMap, ordersMap, customersMap),
  };
}

export async function getRevenue(params = {}) {
  const { currentStart, currentEnd } = resolveDateWindows(params);
  const dateFilter = { start: currentStart, end: currentEnd };
  const [revenue7DaysRows, monthlyRevenueRows, revenueSplit, paymentMethodRows] = await Promise.all([
    repo.fetchRevenueLastDays(7),
    repo.fetchRevenueByMonth(12),
    repo.fetchRevenueSplitByItemType(dateFilter),
    repo.fetchPaymentMethodBreakdown(dateFilter),
  ]);

  return {
    range: params.range || (params.from ? 'custom' : '30d'),
    startDate: toDateString(new Date(currentStart)),
    endDate: toDateString(new Date(currentEnd)),
    revenue7Days: revenue7DaysRows.map((row) => ({
      date: toDateString(row.date),
      revenue: Number(row.revenue || 0),
      orders: Number(row.orders || 0),
    })),
    monthlyRevenue: normalizeMonthlyRevenueRows(monthlyRevenueRows, 12),
    revenueByType: {
      fullBottleRevenue: Number(revenueSplit.fullBottleRevenue || 0),
      decantRevenue: Number(revenueSplit.decantRevenue || 0),
    },
    paymentMethods: paymentMethodRows.map(mapper.toPaymentMethod),
  };
}

export async function getTopProducts(params = {}) {
  const { currentStart, currentEnd } = resolveDateWindows(params);
  const dateFilter = { start: currentStart, end: currentEnd };
  const limit = Math.max(1, Math.min(20, Number(params.limit) || 5));
  const [topProductRows, topBrandRows, topCustomerRows] = await Promise.all([
    repo.fetchTopProducts(limit, dateFilter),
    repo.fetchTopBrands(limit, dateFilter),
    repo.fetchTopCustomers(limit, dateFilter),
  ]);

  return {
    range: params.range || (params.from ? 'custom' : '30d'),
    topProducts: topProductRows.map(mapper.toTopProduct),
    topBrands: topBrandRows.map(mapper.toTopBrand),
    topCustomers: topCustomerRows.map(mapper.toTopCustomer),
  };
}

export async function getLowStock(params = {}) {
  const limit = Math.max(1, Math.min(50, Number(params.limit) || 5));
  const [lowStockRows, outOfStockRows, pendingReviewRows] = await Promise.all([
    repo.fetchLowStockProducts(limit),
    repo.fetchLowStockProducts(limit, { outOfStock: true }),
    repo.fetchPendingReviews(5),
  ]);

  return {
    lowStockProducts: lowStockRows.map(mapper.toLowStockProduct),
    outOfStockProducts: outOfStockRows.map(mapper.toLowStockProduct),
    pendingReviews: pendingReviewRows.map(mapper.toPendingReview),
  };
}
