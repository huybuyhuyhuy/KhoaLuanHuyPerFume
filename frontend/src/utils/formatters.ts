export function formatVnCurrency(value?: number | null) {
  const amount = Number(value ?? 0);
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  return `${safeAmount.toLocaleString('vi-VN')}₫`;
}

export function clampPrice(value?: number | null) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function formatPaymentMethodLabel(value?: string | null) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return '-';
  if (normalized === 'COD') return 'Thanh toán khi nhận hàng';
  if (normalized === 'MOMO') return 'MoMo UAT';
  if (normalized === 'ZALOPAY') return 'ZaloPay Sandbox';
  if (normalized === 'VNPAY') return 'VNPay';
  if (normalized === 'BANKING') return 'Chuyển khoản ngân hàng';
  if (normalized === 'CREDITCARD') return 'Thẻ ngân hàng';
  return value || '-';
}

export function formatPaymentStatusLabel(value?: string | null) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return '-';
  if (normalized === 'PAID') return 'Thanh toán thành công';
  if (normalized === 'PENDING') return 'Chờ thanh toán';
  if (normalized === 'PAYMENT_REJECTED') return 'Thanh toán bị từ chối';
  if (normalized === 'PAYMENT_FAILED') return 'Thanh toán thất bại';
  if (normalized === 'PAYMENT_CANCELLED' || normalized === 'CANCELLED') return 'Đã hủy thanh toán';
  return value || '-';
}
