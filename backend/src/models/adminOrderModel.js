import { query } from '../config/database.js';
import { cancelOrderForAdmin, getOrderStatusTimeline, updateOrderStatusWithHistory } from './orderModel.js';
import { getCheckoutStorageCapabilities, hasColumn } from '../modules/checkout/checkout.storage.js';
import { ORDER_STATUS, normalizeOrderStatus } from '../constants/orderStatus.js';

function formatOrderCode(id) {
  return `ORD-${String(id).padStart(6, '0')}`;
}

function normalizePaymentMethod(paymentMethod) {
  return String(paymentMethod || '').trim().toUpperCase();
}

function buildFailureReasonSelect(capabilities, alias = 'o') {
  return hasColumn(capabilities?.orderColumns || new Set(), 'failure_reason')
    ? `${alias}.failure_reason`
    : 'NULL AS failure_reason';
}

function buildOrderPaymentSelect(capabilities, alias = 'o') {
  const columns = capabilities?.orderColumns || new Set();
  return [
    hasColumn(columns, 'order_code') ? `${alias}.order_code` : `CONCAT(N'#', ${alias}.id) AS order_code`,
    hasColumn(columns, 'payment_status') ? `${alias}.payment_status` : 'NULL AS payment_status',
  ].join(', ');
}

function formatPaymentMethodLabel(paymentMethod) {
  const method = normalizePaymentMethod(paymentMethod);
  if (method === 'COD') return 'Thanh toán khi nhận hàng';
  if (method === 'MOMO') return 'MoMo UAT';
  if (method === 'ZALOPAY') return 'ZaloPay Sandbox';
  if (method === 'VNPAY') return 'VNPay';
  if (method === 'BANKING') return 'Chuyển khoản ngân hàng';
  if (method === 'CREDITCARD') return 'Thẻ ngân hàng';
  return paymentMethod || '';
}

function normalizeDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseSearchOrderId(search) {
  const raw = String(search || '').trim();
  if (!raw) return null;

  const directId = Number(raw);
  if (Number.isInteger(directId) && directId > 0) return directId;

  const orderCodeMatch = raw.match(/^#?(?:ORD[-\s]?)?0*(\d+)$/i);
  if (!orderCodeMatch) return null;

  const parsedId = Number(orderCodeMatch[1]);
  return Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
}

function buildOrderFilters({
  userId = null,
  status = null,
  paymentMethod = null,
  dateFrom = null,
  dateTo = null,
  search = null,
} = {}) {
  const conditions = [];
  const params = [];

  if (userId) {
    conditions.push('o.user_id = ?');
    params.push(Number(userId));
  }
  if (status) {
    conditions.push('o.status = ?');
    params.push(String(status));
  }
  if (paymentMethod) {
    conditions.push('o.payment_method = ?');
    params.push(String(paymentMethod));
  }
  if (dateFrom) {
    conditions.push('o.created_at >= ?');
    params.push(String(dateFrom));
  }
  if (dateTo) {
    conditions.push('o.created_at < DATEADD(day, 1, CAST(? AS date))');
    params.push(String(dateTo));
  }
  if (search) {
    const searchOrderId = parseSearchOrderId(search);
    if (searchOrderId) {
      conditions.push('(o.id = ? OR u.name LIKE ? OR u.email LIKE ?)');
      params.push(searchOrderId, `%${search}%`, `%${search}%`);
    } else {
      conditions.push('(u.name LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
  }

  return {
    whereSql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    conditions,
    params,
  };
}

function buildRecentDaySeries(days = 14) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - 1 - index));
    return {
      date,
      key: normalizeDateKey(date),
      orders: 0,
      revenue: 0,
    };
  });
}

export async function listAdminOrders({
  page = 1,
  pageSize = 10,
  userId = null,
  status = null,
  paymentMethod = null,
  dateFrom = null,
  dateTo = null,
  search = null,
} = {}) {
  const safePage = Math.max(1, Number(page));
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize)));
  const offset = (safePage - 1) * safePageSize;
  const capabilities = await getCheckoutStorageCapabilities();

  const conditions = [];
  const params = [];

  if (userId) {
    conditions.push('o.user_id = ?');
    params.push(Number(userId));
  }
  if (status) {
    conditions.push('o.status = ?');
    params.push(String(status));
  }
  if (paymentMethod) {
    conditions.push('o.payment_method = ?');
    params.push(String(paymentMethod));
  }
  if (dateFrom) {
    conditions.push('o.created_at >= ?');
    params.push(String(dateFrom));
  }
  if (dateTo) {
    conditions.push('o.created_at < DATEADD(day, 1, CAST(? AS date))');
    params.push(String(dateTo));
  }
  if (search) {
    const searchOrderId = parseSearchOrderId(search);
    if (searchOrderId) {
      conditions.push('(o.id = ? OR u.name LIKE ? OR u.email LIKE ?)');
      params.push(searchOrderId, `%${search}%`, `%${search}%`);
    } else {
      conditions.push('(u.name LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRows = await query(`SELECT COUNT(*) AS total FROM orders o LEFT JOIN users u ON u.id = o.user_id ${whereSql}`, params);
  const totalOrders = Number(totalRows[0]?.total || 0);
  const summaryRows = await query(
    `SELECT COUNT(*) AS total,
            SUM(ISNULL(o.total, 0)) AS value,
            AVG(NULLIF(ISNULL(o.total, 0), 0)) AS average_value,
            SUM(CASE WHEN UPPER(o.status) IN ('PENDING', 'CONFIRMED') THEN 1 ELSE 0 END) AS awaiting,
            SUM(CASE WHEN UPPER(o.status) IN ('PACKING', 'SHIPPING') THEN 1 ELSE 0 END) AS processing,
            SUM(CASE WHEN UPPER(o.status) IN ('DELIVERED', 'COMPLETED') THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN UPPER(o.status) IN ('PAYMENT_REJECTED', 'PAYMENT_FAILED', 'CANCELLED_PAYMENT', 'CANCELLED', 'REFUNDED') THEN 1 ELSE 0 END) AS cancelled
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     ${whereSql}`,
    params
  );
  const summary = summaryRows[0] || {};
  const statusRows = await query(
    `SELECT COALESCE(NULLIF(o.status, ''), N'Không xác định') AS status,
            COUNT(*) AS total,
            SUM(ISNULL(o.total, 0)) AS value
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     ${whereSql}
     GROUP BY COALESCE(NULLIF(o.status, ''), N'Không xác định')
     ORDER BY total DESC`,
    params
  );
  const paymentRows = await query(
    `SELECT COALESCE(NULLIF(o.payment_method, ''), N'Khác') AS paymentMethod,
            COUNT(*) AS total,
            SUM(ISNULL(o.total, 0)) AS value
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     ${whereSql}
     GROUP BY COALESCE(NULLIF(o.payment_method, ''), N'Khác')
     ORDER BY total DESC`,
    params
  );
  const dailyWhereSql = conditions.length
    ? `${whereSql} AND o.created_at >= DATEADD(day, -13, CAST(GETDATE() AS date)) AND o.created_at < DATEADD(day, 1, CAST(GETDATE() AS date))`
    : 'WHERE o.created_at >= DATEADD(day, -13, CAST(GETDATE() AS date)) AND o.created_at < DATEADD(day, 1, CAST(GETDATE() AS date))';
  const dailyRows = await query(
    `WITH day_series AS (
       SELECT CAST(DATEADD(day, -13, CAST(GETDATE() AS date)) AS date) AS dayDate
       UNION ALL
       SELECT DATEADD(day, 1, dayDate)
       FROM day_series
       WHERE dayDate < CAST(GETDATE() AS date)
     ),
     daily_orders AS (
       SELECT CONVERT(date, o.created_at) AS dayDate,
              COUNT(*) AS orders,
              SUM(ISNULL(o.total, 0)) AS revenue
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ${dailyWhereSql}
       GROUP BY CONVERT(date, o.created_at)
     )
     SELECT ds.dayDate AS date,
            ISNULL(d.orders, 0) AS orders,
            ISNULL(d.revenue, 0) AS revenue
     FROM day_series ds
     LEFT JOIN daily_orders d ON d.dayDate = ds.dayDate
     ORDER BY ds.dayDate ASC`,
    params
  );

  const rows = await query(
    `SELECT o.id, o.user_id, o.total, o.payment_method, o.status, o.created_at,
            ${buildOrderPaymentSelect(capabilities, 'o')},
            ${buildFailureReasonSelect(capabilities, 'o')},
            COALESCE(u.name, N'Khách vãng lai') AS user_name
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     ${whereSql}
     ORDER BY o.id DESC
     OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
    [...params, offset, safePageSize]
  );

  return {
    listOrders: rows.map((r) => ({
      id: r.id,
      orderCode: r.order_code || `#${r.id}`,
      userId: r.user_id,
      userName: r.user_name,
      total: Number(r.total || 0),
      paymentMethod: r.payment_method,
      paymentMethodLabel: formatPaymentMethodLabel(r.payment_method),
      paymentStatus: r.payment_status || '',
      status: normalizeOrderStatus(r.status),
      failureReason: r.failure_reason || '',
      createdAt: r.created_at,
    })),
    currentOrderPage: safePage,
    totalOrderPages: Math.max(1, Math.ceil(totalOrders / safePageSize)),
    totalOrders,
    summary: {
      total: Number(summary.total || 0),
      value: Number(summary.value || 0),
      averageValue: Math.round(Number(summary.average_value || 0)),
      awaiting: Number(summary.awaiting || 0),
      processing: Number(summary.processing || 0),
      completed: Number(summary.completed || 0),
      cancelled: Number(summary.cancelled || 0),
      statusBreakdown: statusRows.map((row) => ({
        status: normalizeOrderStatus(row.status),
        total: Number(row.total || 0),
        value: Number(row.value || 0),
      })),
      paymentBreakdown: paymentRows.map((row) => ({
        method: row.paymentMethod,
        total: Number(row.total || 0),
        value: Number(row.value || 0),
      })),
      dailyRevenue: dailyRows.map((row) => ({
        date: row.date,
        orders: Number(row.orders || 0),
        revenue: Number(row.revenue || 0),
      })),
    },
  };
}

export async function getAdminOrderAnalytics({
  userId = null,
  status = null,
  paymentMethod = null,
  dateFrom = null,
  dateTo = null,
  search = null,
} = {}) {
  const capabilities = await getCheckoutStorageCapabilities();
  const { whereSql, conditions, params } = buildOrderFilters({
    userId,
    status,
    paymentMethod,
    dateFrom,
    dateTo,
    search,
  });
  const dailyWhereSql = conditions.length
    ? `${whereSql} AND o.created_at >= DATEADD(day, -13, CAST(GETDATE() AS date)) AND o.created_at < DATEADD(day, 1, CAST(GETDATE() AS date))`
    : 'WHERE o.created_at >= DATEADD(day, -13, CAST(GETDATE() AS date)) AND o.created_at < DATEADD(day, 1, CAST(GETDATE() AS date))';

  const [summaryRows, statusRows, paymentRows, dailyRows, recentRows] = await Promise.all([
    query(
      `SELECT COUNT(*) AS total,
              SUM(ISNULL(o.total, 0)) AS value,
              AVG(NULLIF(ISNULL(o.total, 0), 0)) AS average_value,
            SUM(CASE WHEN UPPER(o.status) IN ('PENDING', 'CONFIRMED') THEN 1 ELSE 0 END) AS awaiting,
              SUM(CASE WHEN UPPER(o.status) IN ('PACKING', 'SHIPPING') THEN 1 ELSE 0 END) AS processing,
              SUM(CASE WHEN UPPER(o.status) IN ('DELIVERED', 'COMPLETED') THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN UPPER(o.status) IN ('PAYMENT_REJECTED', 'PAYMENT_FAILED', 'CANCELLED_PAYMENT', 'CANCELLED', 'REFUNDED') THEN 1 ELSE 0 END) AS cancelled
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ${whereSql}`,
      params
    ),
    query(
      `SELECT COALESCE(NULLIF(o.status, ''), N'Không xác định') AS status,
              COUNT(*) AS total,
              SUM(ISNULL(o.total, 0)) AS value
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ${whereSql}
       GROUP BY COALESCE(NULLIF(o.status, ''), N'Không xác định')
       ORDER BY total DESC`,
      params
    ),
    query(
      `SELECT COALESCE(NULLIF(o.payment_method, ''), N'Khác') AS paymentMethod,
              COUNT(*) AS total,
              SUM(ISNULL(o.total, 0)) AS value
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ${whereSql}
       GROUP BY COALESCE(NULLIF(o.payment_method, ''), N'Khác')
       ORDER BY total DESC`,
      params
    ),
    query(
      `SELECT CONVERT(date, o.created_at) AS date,
              COUNT(*) AS orders,
              SUM(ISNULL(o.total, 0)) AS revenue
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ${dailyWhereSql}
       GROUP BY CONVERT(date, o.created_at)
       ORDER BY date ASC`,
      params
    ),
    query(
      `SELECT TOP 8 o.id, o.user_id, o.total, o.payment_method, o.status, o.created_at,
              ${buildOrderPaymentSelect(capabilities, 'o')},
              COALESCE(u.name, N'Khách vãng lai') AS customer_name,
              COALESCE(u.email, '') AS customer_email
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ${whereSql}
       ORDER BY o.created_at DESC, o.id DESC`,
      params
    ),
  ]);

  const summary = summaryRows[0] || {};
  const dayMap = new Map(dailyRows.map((row) => [normalizeDateKey(row.date), row]));
  const dailyRevenue = buildRecentDaySeries(14).map((item) => {
    const row = dayMap.get(item.key);
    return {
      date: item.key,
      orders: Number(row?.orders || 0),
      revenue: Number(row?.revenue || 0),
    };
  });

  return {
    summary: {
      total: Number(summary.total || 0),
      value: Number(summary.value || 0),
      averageValue: Math.round(Number(summary.average_value || 0)),
      awaiting: Number(summary.awaiting || 0),
      processing: Number(summary.processing || 0),
      completed: Number(summary.completed || 0),
      cancelled: Number(summary.cancelled || 0),
    },
    dailyRevenue,
    statusBreakdown: statusRows.map((row) => ({
      status: normalizeOrderStatus(row.status),
      total: Number(row.total || 0),
      value: Number(row.value || 0),
    })),
    paymentBreakdown: paymentRows.map((row) => ({
      method: row.paymentMethod,
      label: formatPaymentMethodLabel(row.paymentMethod),
      total: Number(row.total || 0),
      value: Number(row.value || 0),
    })),
    recentOrders: recentRows.map((row) => ({
      id: row.id,
      orderCode: row.order_code || `#${row.id}`,
      userId: row.user_id,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      totalAmount: Number(row.total || 0),
      paymentMethod: row.payment_method,
      paymentMethodLabel: formatPaymentMethodLabel(row.payment_method),
      status: normalizeOrderStatus(row.status),
      createdAt: row.created_at,
    })),
  };
}

export async function getAdminOrderById(orderId) {
  const capabilities = await getCheckoutStorageCapabilities();
  const rows = await query(
    `SELECT o.id, o.user_id, o.total, o.payment_method, o.status, o.created_at,
            ${buildOrderPaymentSelect(capabilities, 'o')},
            ${buildFailureReasonSelect(capabilities, 'o')},
            COALESCE(u.name, N'Khách vãng lai') AS user_name,
            COALESCE(u.email, '') AS user_email,
            o.shipping_address, o.phone
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     WHERE o.id = ?`,
    [orderId]
  );

  const order = rows[0];
  if (!order) return null;

  const orderItemColumns = capabilities.orderItemColumns;
  const variantColumn = hasColumn(orderItemColumns, 'product_variant_id')
    ? 'oi.product_variant_id'
    : 'NULL AS product_variant_id';
  const batchColumn = hasColumn(orderItemColumns, 'selected_batch_code')
    ? 'oi.selected_batch_code'
    : "'' AS selected_batch_code";
  const purchasePriceColumn = hasColumn(orderItemColumns, 'price_at_purchase')
    ? 'oi.price_at_purchase'
    : 'oi.price AS price_at_purchase';
  const itemStatusColumn = hasColumn(orderItemColumns, 'status')
    ? 'oi.status'
    : 'NULL AS status';
  const itemTypeColumn = hasColumn(orderItemColumns, 'item_type')
    ? 'oi.item_type'
    : "N'FULL_BOTTLE' AS item_type";
  const selectedVolumeColumn = hasColumn(orderItemColumns, 'selected_volume_ml')
    ? 'oi.selected_volume_ml'
    : 'NULL AS selected_volume_ml';
  const sourceBatchColumn = hasColumn(orderItemColumns, 'source_batch_id')
    ? 'oi.source_batch_id'
    : 'NULL AS source_batch_id';
  const items = await query(
    `SELECT oi.id AS item_id, oi.product_id, ${variantColumn}, oi.quantity,
            oi.price, ${itemStatusColumn}, ${batchColumn}, ${purchasePriceColumn},
            ${itemTypeColumn}, ${selectedVolumeColumn}, ${sourceBatchColumn},
            p.name, p.image
     FROM order_items oi
     JOIN products p ON oi.product_id = p.id
     WHERE oi.order_id = ?
     ORDER BY oi.id ASC`,
    [orderId]
  );

  return {
    id: order.id,
    orderCode: order.order_code || `#${order.id}`,
    userId: order.user_id,
    total: Number(order.total || 0),
    paymentMethod: order.payment_method,
    paymentMethodLabel: formatPaymentMethodLabel(order.payment_method),
    paymentStatus: order.payment_status || '',
    status: normalizeOrderStatus(order.status),
    failureReason: order.failure_reason || '',
    createdAt: order.created_at,
    userName: order.user_name,
    userEmail: order.user_email,
    shippingAddress: order.shipping_address,
    phone: order.phone,
    items: items.map((row) => ({
      itemId: row.item_id,
      productId: row.product_id,
      variantId: row.product_variant_id || null,
      name: row.name,
      image: row.image,
      quantity: Number(row.quantity || 0),
      price: Number(row.price || 0),
      status: row.status,
      selectedBatchCode: row.selected_batch_code || '',
      priceAtPurchase: Number(row.price_at_purchase || 0),
      itemType: row.item_type || 'FULL_BOTTLE',
      selectedVolumeMl: row.selected_volume_ml ? Number(row.selected_volume_ml) : null,
      sourceBatchId: row.source_batch_id || null,
    })),
    timeline: await getOrderStatusTimeline(orderId),
  };
}

export async function updateAdminOrderStatus(orderId, status, { changedBy = null, note = null } = {}) {
  const normalizedStatus = normalizeOrderStatus(status);
  if ([ORDER_STATUS.PAYMENT_REJECTED, ORDER_STATUS.PAYMENT_FAILED, ORDER_STATUS.CANCELLED_PAYMENT, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED].includes(normalizedStatus)) {
    const result = await cancelOrderForAdmin(orderId, {
      targetStatus: normalizedStatus,
      changedBy,
      note: note || (normalizedStatus === ORDER_STATUS.REFUNDED ? 'Admin hoàn tiền đơn hàng' : 'Admin hủy đơn hàng'),
    });
    if (result.code) return result;
    return { success: true, orderId, status: normalizedStatus, inventoryReleased: true };
  }

  return updateOrderStatusWithHistory({
    orderId,
    newStatus: normalizedStatus,
    changedBy,
    allowAnyTransition: true,
    note: note || 'Admin cập nhật trạng thái đơn hàng',
  });
}
