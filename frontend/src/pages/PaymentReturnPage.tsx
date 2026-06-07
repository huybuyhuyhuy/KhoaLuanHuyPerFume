import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useCart } from '../hooks/useCart';
import { orderService } from '../services/orderService';
import { clearCartVoucher } from '../utils/cartVoucherStorage';
import { clearPendingPaymentReturn, readPendingPaymentReturn } from '../utils/pendingPaymentReturn';

function getStatusTone(status: string) {
  if (status === 'success') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'cancel') return 'warning';
  if (status === 'rejected') return 'danger';
  if (status === 'failed') return 'danger';
  return 'neutral';
}

function getStatusTitle(status: string) {
  if (status === 'success') return 'Thanh toán thành công';
  if (status === 'pending') return 'Đơn hàng đang chờ xác nhận';
  if (status === 'cancel') return 'Thanh toán đã bị hủy';
  if (status === 'rejected') return 'Thanh toán MoMo UAT bị từ chối';
  if (status === 'failed') return 'Thanh toán thất bại';
  return 'Không thể xác nhận thanh toán';
}

function getStatusMessage(status: string, payment: string, resultCode?: string | null) {
  const methodLabel = payment === 'zalopay' ? 'ZaloPay Sandbox' : 'MoMo UAT';
  if (status === 'success') return `Giao dịch qua ${methodLabel} đã hoàn tất. Đơn hàng của bạn đang được xử lý.`;
  if (status === 'pending') return `${methodLabel} đã chuyển bạn về website, nhưng hệ thống vẫn đang chờ xác nhận thanh toán chính thức. Đơn hàng chưa được đánh dấu đã thanh toán.`;
  if (status === 'cancel') return `Bạn đã hủy giao dịch ${methodLabel}. Đơn hàng chưa được đánh dấu đã thanh toán.`;
  if (status === 'rejected' && payment === 'momo') return 'Thanh toán MoMo UAT bị từ chối bởi phương thức thanh toán test. Vui lòng thử lại hoặc chọn ZaloPay/COD.';
  if (status === 'failed') return `Giao dịch ${methodLabel} không thành công${resultCode ? ` (mã ${resultCode})` : ''}. Bạn có thể thử lại hoặc chọn COD.`;
  return 'Không nhận được trạng thái thanh toán hợp lệ từ cổng thanh toán.';
}

const RECENT_PAYMENT_RECOVERY_MS = 24 * 60 * 60 * 1000;
const PAID_ORDER_STATUSES = new Set(['CONFIRMED', 'PACKING', 'SHIPPING', 'DELIVERED', 'COMPLETED']);

function normalizeGatewayValue(value?: string | null) {
  return String(value || '').trim().toUpperCase();
}

function isPaidZaloPayOrder(order: any) {
  if (!order) return false;
  const method = normalizeGatewayValue(order.paymentMethod ?? order.payment_method);
  const paymentStatus = normalizeGatewayValue(order.paymentStatus ?? order.payment_status);
  const orderStatus = normalizeGatewayValue(order.status);
  return method === 'ZALOPAY' && (paymentStatus === 'PAID' || PAID_ORDER_STATUSES.has(orderStatus));
}

function isRecentPaymentRecoveryCandidate(order: any) {
  const createdAt = new Date(order?.createdAt ?? order?.created_at ?? 0).getTime();
  if (!Number.isFinite(createdAt)) return false;
  return Date.now() - createdAt <= RECENT_PAYMENT_RECOVERY_MS;
}

export function PaymentReturnPage() {
  const { clearCart } = useCart();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [recoveredStatus, setRecoveredStatus] = useState<string | null>(null);
  const [recoveredOrderId, setRecoveredOrderId] = useState<string | null>(null);
  const [verifyingReturn, setVerifyingReturn] = useState(false);
  const payment = String(searchParams.get('payment') || '').toLowerCase();
  const status = String(searchParams.get('status') || 'failed').toLowerCase();
  const rawOrderId = searchParams.get('orderId');
  const resultCode = searchParams.get('resultCode');
  const pendingReturn = useMemo(() => payment === 'zalopay' ? readPendingPaymentReturn('ZALOPAY') : null, [payment]);
  const storedOrderId = pendingReturn?.orderId ? String(pendingReturn.orderId) : null;
  const orderId = recoveredOrderId || rawOrderId || storedOrderId;
  const effectiveStatus = recoveredStatus || status;
  const tone = useMemo(() => getStatusTone(effectiveStatus), [effectiveStatus]);
  const title = useMemo(() => {
    if (verifyingReturn && effectiveStatus !== 'success') return 'Đang kiểm tra thanh toán';
    return getStatusTitle(effectiveStatus);
  }, [effectiveStatus, verifyingReturn]);
  const message = useMemo(() => {
    if (verifyingReturn && effectiveStatus !== 'success') {
      return 'Đang kiểm tra lại trạng thái ZaloPay từ đơn hàng của bạn. Vui lòng chờ trong giây lát.';
    }
    return getStatusMessage(effectiveStatus, payment, resultCode);
  }, [effectiveStatus, payment, resultCode, verifyingReturn]);
  const successUrl = useMemo(() => {
    if (!orderId) return '/checkout/success';

    const params = new URLSearchParams({ orderId });
    if (payment) params.set('paymentMethod', payment.toUpperCase());
    return `/checkout/success?${params.toString()}`;
  }, [orderId, payment]);

  useEffect(() => {
    document.title = `${title} | HuyPerfume`;
  }, [title]);

  useEffect(() => {
    if (effectiveStatus !== 'success') return;
    clearCart().catch(() => undefined);
    clearCartVoucher();
    clearPendingPaymentReturn();
  }, [clearCart, effectiveStatus]);

  useEffect(() => {
    if (effectiveStatus !== 'success' || !orderId) return undefined;

    const redirectTimer = window.setTimeout(() => {
      navigate(successUrl, { replace: true });
    }, 3000);

    return () => window.clearTimeout(redirectTimer);
  }, [effectiveStatus, navigate, orderId, successUrl]);

  useEffect(() => {
    setRecoveredStatus(null);
    setRecoveredOrderId(null);
  }, [payment, rawOrderId, status]);

  useEffect(() => {
    if (payment !== 'zalopay' || status === 'success') return undefined;

    let active = true;

    const recoverFromOrder = (order: any) => {
      if (!active || !isPaidZaloPayOrder(order)) return false;
      const nextOrderId = order?.id ? String(order.id) : orderId;
      if (nextOrderId) setRecoveredOrderId(nextOrderId);
      setRecoveredStatus('success');
      clearPendingPaymentReturn();
      return true;
    };

    const verifyZaloPayReturn = async () => {
      setVerifyingReturn(true);
      try {
        const pendingPayment = readPendingPaymentReturn('ZALOPAY');
        const candidateOrderId = rawOrderId || pendingPayment?.orderId;
        const candidateOrderNumber = Number(candidateOrderId);

        if (Number.isFinite(candidateOrderNumber) && candidateOrderNumber > 0) {
          try {
            const order = await orderService.getOrder(candidateOrderNumber);
            if (recoverFromOrder(order)) return;
          } catch {
            // Fall back to history below. The return page can still recover after auth is restored.
          }
        }

        const orders = await orderService.getUserOrders();
        const recoveredOrder = Array.isArray(orders)
          ? orders.find((order) => isPaidZaloPayOrder(order) && isRecentPaymentRecoveryCandidate(order))
          : null;
        if (recoveredOrder) recoverFromOrder(recoveredOrder);
      } catch {
        // Keep the gateway result visible if the user is not logged in or history cannot be loaded.
      } finally {
        if (active) setVerifyingReturn(false);
      }
    };

    verifyZaloPayReturn();

    return () => {
      active = false;
    };
  }, [orderId, payment, rawOrderId, status]);

  return (
    <main className="luxury-page payment-return-page">
      <div className="container">
        <section className={`luxury-surface payment-return-card tone-${tone}`}>
          <p className="section-eyebrow">Kết quả thanh toán</p>
          <h1>{title}</h1>
          <p>{message}</p>
          {effectiveStatus === 'success' && orderId && (
            <p className="payment-return-redirect-note">Tự động chuyển tới trang hoàn tất sau 3 giây.</p>
          )}
          {orderId && <p className="payment-return-order">Mã đơn hàng: <strong>#{orderId}</strong></p>}
          <div className="payment-return-actions">
            {effectiveStatus === 'success' && orderId && (
              <Link to={successUrl} className="btn luxury-primary-btn">Đến trang hoàn tất</Link>
            )}
            {orderId && <Link to={`/orders/${orderId}`} className="btn luxury-primary-btn">Xem đơn hàng</Link>}
            <Link to="/orders" className="btn luxury-secondary-btn">Về lịch sử đơn hàng</Link>
            {effectiveStatus !== 'success' && orderId && <Link to={`/orders/${orderId}`} className="btn luxury-link-btn">Thanh toán lại đơn này</Link>}
            {effectiveStatus !== 'success' && !orderId && <Link to="/checkout" className="btn luxury-link-btn">Thử thanh toán lại</Link>}
            {effectiveStatus !== 'success' && <Link to="/cart" className="btn luxury-link-btn">Quay về giỏ hàng</Link>}
          </div>
        </section>
      </div>
    </main>
  );
}
