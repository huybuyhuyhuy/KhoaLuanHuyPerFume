import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useCart } from '../hooks/useCart';
import { orderService } from '../services/orderService';
import { clearCartVoucher } from '../utils/cartVoucherStorage';
import { formatPaymentMethodLabel, formatVnCurrency } from '../utils/formatters';

function formatOrderId(value: string | null) {
  if (!value) return '—';
  const trimmed = value.trim();
  if (!trimmed) return '—';
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

function formatPaymentLabel(value: string | null) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '—';
  if (normalized === 'cod') return 'Thanh toán khi nhận hàng';
  if (normalized === 'momo') return 'MoMo UAT';
  if (normalized === 'zalopay') return 'ZaloPay Sandbox';
  if (normalized === 'vnpay') return 'VNPay';
  if (normalized === 'banking') return 'Chuyển khoản ngân hàng';
  return value || '—';
}

function parseAmount(value: string | null) {
  if (!value) return null;
  const numeric = Number(String(value).replace(/[,\s]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function DecorativeSparkles() {
  return (
    <div className="payment-success-sparkles" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

export function PaymentSuccessPage() {
  const { clearCart } = useCart();
  const [searchParams] = useSearchParams();
  const [orderDetail, setOrderDetail] = useState<any>(null);
  const [loadingOrderDetail, setLoadingOrderDetail] = useState(false);
  const orderId = searchParams.get('orderId');
  const totalParam = searchParams.get('total');
  const urlPaymentMethod = searchParams.get('paymentMethod') || searchParams.get('payment');
  const urlAmount = parseAmount(totalParam);
  const amount = urlAmount ?? (Number.isFinite(Number(orderDetail?.total)) ? Number(orderDetail.total) : null);
  const paymentMethod = urlPaymentMethod || orderDetail?.paymentMethod || orderDetail?.payment_method || null;
  const hasOrderId = Boolean(orderId && orderId.trim());
  const title = hasOrderId ? 'Thanh toán thành công!' : 'Đặt hàng thành công!';
  const description = 'Cảm ơn bạn đã mua sắm tại HuyPerfume. Đơn hàng của bạn đang được xử lý và sẽ sớm được giao đến bạn.';
  const note = 'Chúng tôi đã ghi nhận đơn hàng của bạn. Vui lòng kiểm tra lịch sử đơn hàng để theo dõi trạng thái.';
  const orderLabel = useMemo(() => formatOrderId(orderId), [orderId]);
  const paymentLabel = useMemo(() => formatPaymentMethodLabel(paymentMethod), [paymentMethod]);

  useEffect(() => {
    document.title = `${title} | HuyPerfume`;
  }, [title]);

  useEffect(() => {
    clearCart().catch(() => undefined);
    clearCartVoucher();
  }, [clearCart]);

  useEffect(() => {
    const numericOrderId = Number(orderId);
    if (!Number.isFinite(numericOrderId) || numericOrderId <= 0) {
      setOrderDetail(null);
      return undefined;
    }
    if (urlAmount !== null && paymentMethod) return undefined;

    let active = true;
    setLoadingOrderDetail(true);

    orderService
      .getOrder(numericOrderId)
      .then((order) => {
        if (active) setOrderDetail(order);
      })
      .catch(() => {
        if (active) setOrderDetail(null);
      })
      .finally(() => {
        if (active) setLoadingOrderDetail(false);
      });

    return () => {
      active = false;
    };
  }, [orderId, paymentMethod, urlAmount]);

  return (
    <main className="luxury-page payment-success-page">
      <div className="container">
        <section className="payment-success-card luxury-surface">
          <DecorativeSparkles />
          <div className="payment-success-badge" aria-hidden="true">
            <svg viewBox="0 0 64 64" className="payment-success-icon">
              <circle cx="32" cy="32" r="28" />
              <path d="M26.3 36.7l-6.1-6.2-3.5 3.5 9.6 9.6 17-17-3.5-3.5-13.5 13.6z" />
            </svg>
          </div>

          <p className="section-eyebrow payment-success-eyebrow">HuyPerfume</p>
          <h1>{title}</h1>
          <p className="payment-success-description">{description}</p>

          <div className="payment-success-summary" role="list" aria-label="Thông tin đơn hàng">
            <div className="payment-success-summary-item" role="listitem">
              <span>Mã đơn hàng</span>
              <strong>{orderLabel}</strong>
            </div>
            <div className="payment-success-summary-item" role="listitem">
              <span>Tổng tiền</span>
              <strong>{amount !== null ? formatVnCurrency(amount) : loadingOrderDetail ? 'Đang tải...' : '—'}</strong>
            </div>
            <div className="payment-success-summary-item" role="listitem">
              <span>Phương thức thanh toán</span>
              <strong>{paymentLabel}</strong>
            </div>
          </div>

          <div className="payment-success-note">
            <span className="payment-success-note-mark" aria-hidden="true">i</span>
            <p>{note}</p>
          </div>

          <div className="payment-success-actions">
            {hasOrderId ? (
              <Link to={`/orders/${orderId}`} className="btn luxury-primary-btn payment-success-btn">
                Xem đơn hàng của tôi
              </Link>
            ) : (
              <Link to="/orders" className="btn luxury-primary-btn payment-success-btn">
                Xem đơn hàng của tôi
              </Link>
            )}
            <Link to="/products" className="btn luxury-secondary-btn payment-success-btn">
              Tiếp tục mua sắm
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
