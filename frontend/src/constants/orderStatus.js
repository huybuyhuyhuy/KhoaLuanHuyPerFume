export const ORDER_STATUS = Object.freeze({
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  PACKING: 'PACKING',
  SHIPPING: 'SHIPPING',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
  PAYMENT_REJECTED: 'PAYMENT_REJECTED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  CANCELLED_PAYMENT: 'CANCELLED_PAYMENT',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED',
});

export const ORDER_STATUS_OPTIONS = [
  { value: ORDER_STATUS.PENDING_PAYMENT, label: 'Chờ thanh toán' },
  { value: ORDER_STATUS.PENDING, label: 'Chờ xác nhận' },
  { value: ORDER_STATUS.CONFIRMED, label: 'Đã xác nhận' },
  { value: ORDER_STATUS.PACKING, label: 'Đang đóng gói' },
  { value: ORDER_STATUS.SHIPPING, label: 'Đang giao' },
  { value: ORDER_STATUS.DELIVERED, label: 'Đã giao' },
  { value: ORDER_STATUS.COMPLETED, label: 'Hoàn tất' },
  { value: ORDER_STATUS.CANCELLED, label: 'Đã hủy' },
  { value: ORDER_STATUS.REFUNDED, label: 'Đã hoàn tiền' },
  { value: ORDER_STATUS.PAYMENT_REJECTED, label: 'Thanh toán bị từ chối' },
  { value: ORDER_STATUS.PAYMENT_FAILED, label: 'Thanh toán thất bại' },
  { value: ORDER_STATUS.CANCELLED_PAYMENT, label: 'Đã hủy thanh toán' },
];

export const ORDER_TIMELINE_STEPS = [
  { value: ORDER_STATUS.PENDING, label: 'Đặt hàng' },
  { value: ORDER_STATUS.CONFIRMED, label: 'Xác nhận' },
  { value: ORDER_STATUS.PACKING, label: 'Đóng gói' },
  { value: ORDER_STATUS.SHIPPING, label: 'Giao hàng' },
  { value: ORDER_STATUS.COMPLETED, label: 'Hoàn tất' },
];

const LABELS = Object.fromEntries(ORDER_STATUS_OPTIONS.map((item) => [item.value, item.label]));
const LEGACY = {
  PENDING_PAYMENT: ORDER_STATUS.PENDING_PAYMENT,
  'PENDING PAYMENT': ORDER_STATUS.PENDING_PAYMENT,
  AWAITING_PAYMENT: ORDER_STATUS.PENDING_PAYMENT,
  'AWAITING PAYMENT': ORDER_STATUS.PENDING_PAYMENT,
  WAITING: ORDER_STATUS.PENDING,
  'CHO XAC NHAN': ORDER_STATUS.PENDING,
  PAID: ORDER_STATUS.CONFIRMED,
  'DA XAC NHAN': ORDER_STATUS.CONFIRMED,
  PROCESSING: ORDER_STATUS.PACKING,
  SHIPPED: ORDER_STATUS.SHIPPING,
  'DANG GIAO': ORDER_STATUS.SHIPPING,
  SHIPPING: ORDER_STATUS.SHIPPING,
  DELIVERED: ORDER_STATUS.DELIVERED,
  'GIAO HANG THANH CONG': ORDER_STATUS.DELIVERED,
  COMPLETED: ORDER_STATUS.COMPLETED,
  PAYMENT_FAILED: ORDER_STATUS.PAYMENT_FAILED,
  'PAYMENT FAILED': ORDER_STATUS.PAYMENT_FAILED,
  PAYMENT_REJECTED: ORDER_STATUS.PAYMENT_REJECTED,
  'PAYMENT REJECTED': ORDER_STATUS.PAYMENT_REJECTED,
  CANCELLED_PAYMENT: ORDER_STATUS.CANCELLED_PAYMENT,
  'CANCELLED PAYMENT': ORDER_STATUS.CANCELLED_PAYMENT,
  CANCELED_PAYMENT: ORDER_STATUS.CANCELLED_PAYMENT,
  'CANCELED PAYMENT': ORDER_STATUS.CANCELLED_PAYMENT,
  CANCELLED: ORDER_STATUS.CANCELLED,
  CANCELED: ORDER_STATUS.CANCELLED,
  'DA HUY': ORDER_STATUS.CANCELLED,
  REFUNDED: ORDER_STATUS.REFUNDED,
  'DANG HOAN TIEN': ORDER_STATUS.REFUNDED,
  'DA HOAN TIEN': ORDER_STATUS.REFUNDED,
};

function normalizeStatusKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\u0110/g, 'D')
    .replace(/\u0111/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function normalizeOrderStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return LEGACY[normalized] || LEGACY[normalizeStatusKey(value)] || normalized || ORDER_STATUS.PENDING;
}

export function getOrderStatusLabel(status) {
  return LABELS[normalizeOrderStatus(status)] || status || '-';
}

export function getOrderStatusTone(status) {
  const normalized = normalizeOrderStatus(status);
  if ([ORDER_STATUS.DELIVERED, ORDER_STATUS.COMPLETED].includes(normalized)) return 'positive';
  if ([ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED, ORDER_STATUS.PACKING, ORDER_STATUS.SHIPPING].includes(normalized)) return 'progress';
  if ([ORDER_STATUS.PAYMENT_REJECTED, ORDER_STATUS.PAYMENT_FAILED, ORDER_STATUS.CANCELLED_PAYMENT, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED].includes(normalized)) return 'negative';
  return 'neutral';
}

export function canCancelOrder(status) {
  return [ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PENDING, ORDER_STATUS.CONFIRMED, ORDER_STATUS.PACKING]
    .includes(normalizeOrderStatus(status));
}

export function getOrderTimelineIndex(status, timeline = []) {
  const statusValues = [
    ...timeline.map((item) => normalizeOrderStatus(item.newStatus || item.new_status)),
    normalizeOrderStatus(status),
  ];
  if (statusValues.includes(ORDER_STATUS.COMPLETED) || statusValues.includes(ORDER_STATUS.DELIVERED)) return 4;
  if (statusValues.includes(ORDER_STATUS.SHIPPING)) return 3;
  if (statusValues.includes(ORDER_STATUS.PACKING)) return 2;
  if (statusValues.includes(ORDER_STATUS.CONFIRMED)) return 1;
  return 0;
}
