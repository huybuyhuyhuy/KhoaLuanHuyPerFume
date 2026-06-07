const PENDING_PAYMENT_RETURN_KEY = 'huyperfume:pending-payment-return';
const MAX_PENDING_PAYMENT_AGE_MS = 24 * 60 * 60 * 1000;

type PendingPaymentReturn = {
  paymentMethod: string;
  orderId: number | string;
  externalOrderId?: string;
  createdAt: number;
};

function canUseStorage() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

export function savePendingPaymentReturn(payload: Omit<PendingPaymentReturn, 'createdAt'>) {
  if (!canUseStorage() || !payload?.orderId) return;

  const data: PendingPaymentReturn = {
    paymentMethod: String(payload.paymentMethod || '').toUpperCase(),
    orderId: payload.orderId,
    externalOrderId: String(payload.externalOrderId || ''),
    createdAt: Date.now(),
  };
  localStorage.setItem(PENDING_PAYMENT_RETURN_KEY, JSON.stringify(data));
}

export function readPendingPaymentReturn(paymentMethod?: string) {
  if (!canUseStorage()) return null;

  try {
    const raw = localStorage.getItem(PENDING_PAYMENT_RETURN_KEY);
    if (!raw) return null;

    const data = JSON.parse(raw) as PendingPaymentReturn;
    if (!data?.orderId || !data?.createdAt) return null;
    if (Date.now() - Number(data.createdAt) > MAX_PENDING_PAYMENT_AGE_MS) {
      localStorage.removeItem(PENDING_PAYMENT_RETURN_KEY);
      return null;
    }
    if (paymentMethod && String(data.paymentMethod || '').toUpperCase() !== String(paymentMethod).toUpperCase()) {
      return null;
    }
    return data;
  } catch {
    localStorage.removeItem(PENDING_PAYMENT_RETURN_KEY);
    return null;
  }
}

export function clearPendingPaymentReturn() {
  if (!canUseStorage()) return;
  localStorage.removeItem(PENDING_PAYMENT_RETURN_KEY);
}
