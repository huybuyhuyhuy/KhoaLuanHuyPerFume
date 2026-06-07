import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { orderService } from '../services/orderService';
import { useToast } from '../store/ToastContext';
import { savePaymentAuthBridge } from '../utils/paymentAuthBridge';
import { formatPaymentMethodLabel, formatPaymentStatusLabel, formatVnCurrency } from '../utils/formatters';
import { resolveProductImage } from '../utils/image';
import {
  ORDER_STATUS,
  ORDER_TIMELINE_STEPS,
  canCancelOrder,
  getOrderStatusLabel,
  getOrderStatusTone,
  getOrderTimelineIndex,
  normalizeOrderStatus,
} from '../constants/orderStatus';

const ORDER_REFRESH_INTERVAL_MS = 5000;
const TERMINAL_ORDER_STATUSES = [
  ORDER_STATUS.PAYMENT_REJECTED,
  ORDER_STATUS.PAYMENT_FAILED,
  ORDER_STATUS.CANCELLED_PAYMENT,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.REFUNDED,
];

function StatusBadge({ status }) {
  return (
    <span className={`order-history-status ${getOrderStatusTone(status)}`}>
      {getOrderStatusLabel(status)}
    </span>
  );
}

function getOrderItemLabel(item) {
  const isDecant = String(item?.itemType || '').toUpperCase() === 'DECANT';
  return isDecant ? `Chiết ${item?.selectedVolumeMl || ''}ml`.trim() : 'Full chai';
}

function OrderProgress({ order }) {
  const activeStep = getOrderTimelineIndex(order.status, order.timeline);
  const normalizedStatus = normalizeOrderStatus(order.status);
  const terminalStatus = [ORDER_STATUS.PAYMENT_REJECTED, ORDER_STATUS.PAYMENT_FAILED, ORDER_STATUS.CANCELLED_PAYMENT, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED].includes(normalizedStatus);

  return (
    <section className="luxury-surface order-detail-progress">
      <div className="order-detail-heading">
        <div>
          <p className="section-eyebrow">Tiến trình đơn hàng</p>
          <h2>Theo dõi vận chuyển</h2>
        </div>
        <StatusBadge status={order.status} />
      </div>
      <div className="order-success-timeline">
        {ORDER_TIMELINE_STEPS.map((step, index) => (
          <div
            key={step.value}
            className={`order-timeline-step ${!terminalStatus && index <= activeStep ? 'active' : ''} ${!terminalStatus && index === activeStep ? 'current' : ''}`}
          >
            <span className="order-timeline-icon" aria-hidden="true">{index < activeStep ? '✓' : index + 1}</span>
            <span className="order-timeline-label">{step.label}</span>
            {index < ORDER_TIMELINE_STEPS.length - 1 && <span className="order-timeline-line" />}
          </div>
        ))}
      </div>
      {terminalStatus && (
        <p className="order-detail-terminal">
          {normalizedStatus === ORDER_STATUS.PAYMENT_REJECTED
            ? 'Thanh toán MoMo UAT bị từ chối bởi phương thức thanh toán test.'
            : `Đơn hàng đã ${normalizedStatus === ORDER_STATUS.REFUNDED ? 'được hoàn tiền' : 'bị hủy'}.`}
        </p>
      )}
      {Array.isArray(order.timeline) && order.timeline.length > 0 && (
        <div className="order-status-history">
          {order.timeline.map((event) => (
            <div key={event.id} className="order-status-history-row">
              <StatusBadge status={event.newStatus} />
              <span>{event.note || getOrderStatusLabel(event.newStatus)}</span>
              <time>{new Date(event.createdAt).toLocaleString('vi-VN')}</time>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function OrderDetailPage() {
  const { id } = useParams();
  const { pushToast } = useToast();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [retryingPayment, setRetryingPayment] = useState('');
  const [error, setError] = useState('');
  const latestStatusRef = useRef('');

  const loadOrder = useCallback(async ({ notifyStatusChange = false } = {}) => {
    const data = await orderService.getOrder(Number(id));
    const nextStatus = normalizeOrderStatus(data?.status);
    const previousStatus = latestStatusRef.current;
    latestStatusRef.current = nextStatus;
    setOrder(data);

    if (notifyStatusChange && previousStatus && previousStatus !== nextStatus) {
      pushToast(`Trạng thái đơn #${data.id}: ${getOrderStatusLabel(nextStatus)}.`, 'success');
    }

    return data;
  }, [id, pushToast]);

  useEffect(() => {
    if (!id) {
      setError('ID đơn hàng không hợp lệ.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    latestStatusRef.current = '';
    loadOrder()
      .catch((err) => setError(err?.response?.data?.message || 'Không tải được chi tiết đơn hàng.'))
      .finally(() => setLoading(false));
  }, [id, loadOrder]);

  useEffect(() => {
    if (!id || loading || error) return undefined;
    const normalizedStatus = normalizeOrderStatus(order?.status);
    if (TERMINAL_ORDER_STATUSES.includes(normalizedStatus)) return undefined;

    const refreshOrderStatus = () => {
      loadOrder({ notifyStatusChange: true }).catch(() => {});
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshOrderStatus();
    };

    const intervalId = window.setInterval(refreshOrderStatus, ORDER_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshOrderStatus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshOrderStatus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [error, id, loadOrder, loading, order?.status]);

  const handleCancel = async () => {
    if (!order || !window.confirm('Bạn chắc chắn muốn hủy đơn hàng này? Tồn kho sẽ được hoàn lại.')) return;
    setCancelling(true);
    try {
      await orderService.cancelOrder(order.id);
      await loadOrder();
      pushToast('Đã hủy đơn hàng và hoàn lại tồn kho.', 'success');
    } catch (requestError) {
      pushToast(requestError?.message || 'Không thể hủy đơn hàng lúc này.', 'error');
    } finally {
      setCancelling(false);
    }
  };

  const canRetryPayment = (() => {
    if (!order) return false;
    const status = normalizeOrderStatus(order.status);
    const paymentStatus = String(order.paymentStatus || '').toUpperCase();
    if (paymentStatus === 'PAID' || paymentStatus === 'CANCELLED') return false;
    if ([ORDER_STATUS.CANCELLED_PAYMENT, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED, ORDER_STATUS.CONFIRMED, ORDER_STATUS.COMPLETED].includes(status)) return false;
    return [ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PENDING].includes(status);
  })();

  const handleRetryPayment = async (provider) => {
    if (!order) return;
    setRetryingPayment(provider);
    try {
      savePaymentAuthBridge();
      const paymentResponse = provider === 'MOMO'
        ? await orderService.createMomoPayment(order.id)
        : await orderService.createZaloPayPayment(order.id);
      const paymentUrl = paymentResponse?.paymentUrl || paymentResponse?.payUrl || paymentResponse?.orderUrl || paymentResponse?.deeplink || '';
      if (!paymentUrl) throw new Error('Không tạo được link thanh toán.');
      window.location.href = paymentUrl;
    } catch (requestError) {
      pushToast(requestError?.response?.data?.message || requestError?.message || 'Không thể tạo lại thanh toán lúc này.', 'error');
      setRetryingPayment('');
    }
  };

  if (loading) return <div className="text-center py-5"><div className="spinner-border" /></div>;

  if (error) {
    return (
      <div className="container py-4">
        <h3 className="mb-4">Chi tiết đơn hàng</h3>
        <div className="alert alert-danger">{error}</div>
      </div>
    );
  }

  if (!order) return null;

  return (
    <main className="luxury-page order-detail-page">
      <div className="container py-4">
        <header className="order-detail-header">
          <div>
            <p className="section-eyebrow">Đơn hàng của bạn</p>
            <h1>Chi tiết đơn hàng {order.orderCode || `#${order.id}`}</h1>
          </div>
          <div className="d-flex gap-2">
            {canRetryPayment && (
              <>
                <button type="button" className="btn btn-dark btn-sm" disabled={Boolean(retryingPayment)} onClick={() => handleRetryPayment('MOMO')}>
                  {retryingPayment === 'MOMO' ? 'Đang tạo link...' : 'Thanh toán lại MoMo UAT'}
                </button>
                <button type="button" className="btn btn-outline-dark btn-sm" disabled={Boolean(retryingPayment)} onClick={() => handleRetryPayment('ZALOPAY')}>
                  {retryingPayment === 'ZALOPAY' ? 'Đang tạo link...' : 'Thanh toán ZaloPay Sandbox'}
                </button>
              </>
            )}
            {canCancelOrder(order.status) && (
              <button type="button" className="btn btn-outline-danger btn-sm" disabled={cancelling} onClick={handleCancel}>
                {cancelling ? 'Đang hủy...' : 'Hủy đơn'}
              </button>
            )}
            <Link to="/orders" className="btn btn-outline-dark btn-sm">Quay lại</Link>
          </div>
        </header>

        <OrderProgress order={order} />

        <section className="luxury-surface order-detail-information">
          <div><strong>Ngày đặt:</strong> {new Date(order.createdAt).toLocaleString('vi-VN')}</div>
          <div><strong>Thanh toán:</strong> {order.paymentMethodLabel || formatPaymentMethodLabel(order.paymentMethod)}</div>
          {order.paymentStatus && <div><strong>Trạng thái thanh toán:</strong> {formatPaymentStatusLabel(order.paymentStatus)}</div>}
          <div><strong>Trạng thái:</strong> <StatusBadge status={order.status} /></div>
          {order.failureReason && <div className="wide"><strong>Lý do thanh toán:</strong> {order.failureReason}</div>}
          <div><strong>SĐT giao hàng:</strong> {order.phone || '-'}</div>
          <div className="wide"><strong>Địa chỉ:</strong> {order.shippingAddress || '-'}</div>
        </section>

        <section className="luxury-surface order-detail-items">
          <h2>Sản phẩm</h2>
          {Array.isArray(order.items) && order.items.length > 0 ? (
            <>
              {order.items.map((item) => (
                <article key={`${item.id}-${item.itemType || 'FULL_BOTTLE'}-${item.selectedVolumeMl || 'full'}`} className="order-detail-item">
                  <div className="d-flex align-items-center gap-3">
                    <img src={resolveProductImage(item.productImage)} alt={item.productName} loading="lazy" decoding="async" />
                    <div>
                      <strong>{item.productName}</strong>
                      <small>{getOrderItemLabel(item)}</small>
                      <small>Số lượng: {item.quantity}</small>
                    </div>
                  </div>
                  <b>{formatVnCurrency(item.priceAtPurchase * item.quantity)}</b>
                </article>
              ))}
              <footer className="order-detail-total">
                <span>Tổng cộng</span>
                <strong>{formatVnCurrency(order.total)}</strong>
              </footer>
            </>
          ) : (
            <p className="luxury-muted mb-0">Không có sản phẩm trong đơn hàng.</p>
          )}
        </section>
      </div>
    </main>
  );
}
