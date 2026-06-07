import { STATUS_GROUPS } from './order-status.js';

// ────────────────────────────────────────────────────────────
//  Order helpers
// ────────────────────────────────────────────────────────────

function derivePaymentStatus(status) {
  if (STATUS_GROUPS.REVENUE.includes(status)) return 'paid';
  if (STATUS_GROUPS.CANCELLED_OR_FAILED.includes(status)) return 'failed';
  if (STATUS_GROUPS.REFUNDED.includes(status)) return 'refunded';
  return 'pending';
}

function formatOrderCode(id) {
  return `ORD-${String(id).padStart(6, '0')}`;
}

function formatPaymentMethodLabel(method) {
  if (method === 'COD') return 'Thanh toán khi nhận hàng';
  if (method === 'MOMO') return 'MoMo UAT';
  if (method === 'ZALOPAY') return 'ZaloPay Sandbox';
  if (method === 'VNPAY') return 'VNPay';
  if (method === 'BANKING') return 'Chuyển khoản ngân hàng';
  if (method === 'CREDITCARD') return 'Thẻ ngân hàng';
  return method || 'Khác';
}

// ────────────────────────────────────────────────────────────
//  Row → DTO mappers
// ────────────────────────────────────────────────────────────

export function toOrderStats(row) {
  return {
    totalRevenue: Number(row.totalRevenue || 0),
    totalOrders: Number(row.totalOrders || 0),
    completedOrders: Number(row.completedOrders || 0),
    pendingOrders: Number(row.pendingOrders || 0),
    cancelledOrders: Number(row.cancelledOrders || 0),
    refundedOrders: Number(row.refundedOrders || 0),
    averageOrderValue: Math.round(Number(row.averageOrderValue || 0)),
  };
}

export function toTopProduct(row) {
  return {
    id: Number(row.id),
    name: row.name,
    image: row.image || '',
    price: Number(row.price || 0),
    discountPrice: Number(row.discount_price || 0),
    totalSold: Number(row.totalSold || 0),
    revenue: Number(row.revenue || 0),
    stock: Number(row.stock || 0),
  };
}

export function toTopBrand(row) {
  return {
    id: Number(row.id),
    name: row.name || 'Khong ro thuong hieu',
    totalSold: Number(row.totalSold || 0),
    revenue: Number(row.revenue || 0),
    orders: Number(row.orders || 0),
  };
}

export function toTopCustomer(row) {
  return {
    id: Number(row.id),
    name: row.name || 'Khach hang',
    email: row.email || '',
    orders: Number(row.orders || 0),
    totalSpent: Number(row.totalSpent || 0),
  };
}

export function toLowStockProduct(row) {
  return {
    id: Number(row.id),
    name: row.name,
    image: row.image || '',
    sku: row.sku || '',
    variantId: row.variantId ? Number(row.variantId) : null,
    variantLabel: row.variantLabel || '',
    stock: Number(row.stock || 0),
    price: Number(row.price || 0),
    discountPrice: Number(row.discount_price || 0),
  };
}

export function toPendingReview(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id || 0),
    userId: row.user_id ? Number(row.user_id) : null,
    rating: Number(row.rating || 0),
    title: row.title || '',
    comment: row.comment || '',
    createdAt: row.created_at,
    productName: row.product_name || '',
    productImage: row.product_image || '',
    userName: row.user_name || '',
  };
}

export function toPaymentMethod(row) {
  const raw = String(row.method || 'UNKNOWN').toUpperCase();
  const method = raw.includes('MOMO')
    ? 'MOMO'
    : raw.includes('ZALO')
      ? 'ZALOPAY'
      : raw.includes('COD')
        ? 'COD'
        : raw;
  return {
    method,
    label: formatPaymentMethodLabel(method),
    orders: Number(row.orders || 0),
    revenue: Number(row.revenue || 0),
  };
}

export function toTopCategory(row) {
  return {
    id: row.id,
    name: row.name,
    totalSold: Number(row.totalSold || 0),
  };
}

export function toRecentOrder(row) {
  return {
    id: Number(row.id),
    orderCode: row.order_code || `#${row.id}`,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    status: row.status,
    paymentStatus: derivePaymentStatus(row.status),
    totalAmount: Number(row.total || 0),
    createdAt: row.created_at,
  };
}

/** Build stable alerts array from inventory low-stock data. */
export function transformAlerts(alertsData) {
  const items = [];
  if (!alertsData) return items;

  const now = new Date().toISOString();
  for (const p of alertsData.products || []) {
    items.push({
      type: 'low_stock',
      severity: p.stock === 0 ? 'critical' : 'warning',
      message: `${p.name} chỉ còn ${p.stock} sản phẩm`,
      productId: p.id,
      createdAt: now,
    });
  }
  for (const v of alertsData.variants || []) {
    items.push({
      type: 'low_stock',
      severity: v.stockQuantity === 0 ? 'critical' : 'warning',
      message: `${v.productName} - ${v.volumeLabel || 'N/A'} chỉ còn ${v.stockQuantity} sản phẩm`,
      productId: v.productId,
      createdAt: now,
    });
  }
  return items;
}
