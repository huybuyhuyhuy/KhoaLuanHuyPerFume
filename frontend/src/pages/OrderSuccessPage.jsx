import { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { orderService } from '../services/orderService';
import { formatVnCurrency } from '../utils/formatters';
import { resolveProductImage } from '../utils/image';
import { getOrderStatusLabel, getOrderTimelineIndex, ORDER_TIMELINE_STEPS } from '../constants/orderStatus';

const paymentLabels = {
  COD: 'Thanh toán khi nhận hàng',
  MOMO: 'MoMo UAT',
  ZALOPAY: 'ZaloPay Sandbox',
  VNPAY: 'VNPay',
  BANKING: 'Chuyển khoản ngân hàng',
};

const paymentIcons = {
  COD: '💵',
  MOMO: '📱',
  ZALOPAY: '⚡',
  VNPAY: '🏦',
  BANKING: '🏛️',
};

const ORDER_STEPS = ORDER_TIMELINE_STEPS.map((step, index) => ({
  key: step.value,
  label: step.label,
  icon: index < ORDER_TIMELINE_STEPS.length - 1 ? '✓' : '★',
}));

function getActiveStep(status, timeline) {
  return getOrderTimelineIndex(status, timeline);
}

function getOrderItemLabel(item) {
  const isDecant = String(item?.itemType || '').toUpperCase() === 'DECANT';
  return isDecant ? `Chiết ${item?.selectedVolumeMl || ''}ml`.trim() : 'Full chai';
}

/* ─── Confetti Canvas ──────────────────────────────── */
function ConfettiCanvas() {
  const canvasRef = useRef(null);
  const particles = useRef([]);
  const rafId = useRef(null);

  const COLORS = [
    '#d0af67', '#9c7029', '#2e7547', '#e8c97a',
    '#c49a3c', '#f7e6b8', '#a3d4a7', '#f5d98e',
    '#8b6914', '#b8860b',
  ];

  const init = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.width = canvas.offsetWidth;
    const h = canvas.height = canvas.offsetHeight;
    const arr = [];
    for (let i = 0; i < 120; i++) {
      arr.push({
        x: Math.random() * w,
        y: Math.random() * h * -1.2,
        w: 4 + Math.random() * 6,
        h: 8 + Math.random() * 8,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        vy: 1.2 + Math.random() * 2.5,
        vx: (Math.random() - 0.5) * 1.6,
        rot: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 6,
        opacity: 0.7 + Math.random() * 0.3,
      });
    }
    particles.current = arr;
  }, []);

  useEffect(() => {
    init();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let frame = 0;
    const maxFrames = 280;

    function draw() {
      frame++;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const globalFade = frame > maxFrames - 60 ? (maxFrames - frame) / 60 : 1;
      if (globalFade <= 0) {
        cancelAnimationFrame(rafId.current);
        return;
      }

      for (const p of particles.current) {
        p.y += p.vy;
        p.x += p.vx + Math.sin(frame * 0.02 + p.x) * 0.3;
        p.rot += p.rotSpeed;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.globalAlpha = p.opacity * globalFade;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      rafId.current = requestAnimationFrame(draw);
    }
    rafId.current = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(rafId.current);
  }, [init]);

  return (
    <canvas
      ref={canvasRef}
      className="order-success-confetti"
      aria-hidden="true"
    />
  );
}

/* ─── Order Timeline ───────────────────────────────── */
function OrderTimeline({ activeStep }) {
  return (
    <div className="order-success-timeline" role="list" aria-label="Tiến trình đơn hàng">
      {ORDER_STEPS.map((step, i) => (
        <div
          key={step.key}
          className={`order-timeline-step ${i <= activeStep ? 'active' : ''} ${i === activeStep ? 'current' : ''}`}
          role="listitem"
          style={{ animationDelay: `${0.8 + i * 0.15}s` }}
        >
          <span className="order-timeline-icon" aria-hidden="true">{step.icon}</span>
          <span className="order-timeline-label">{step.label}</span>
          {i < ORDER_STEPS.length - 1 && <span className="order-timeline-line" />}
        </div>
      ))}
    </div>
  );
}

/* ─── Main Page ────────────────────────────────────── */
export function OrderSuccessPage() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const orderId = Number(id);

    if (!Number.isInteger(orderId) || orderId < 1) {
      setError('Mã đơn hàng không hợp lệ.');
      setLoading(false);
      return undefined;
    }

    let active = true;
    setLoading(true);
    setError('');

    orderService.getOrder(orderId)
      .then((data) => {
        if (active) setOrder(data);
      })
      .catch((err) => {
        if (active) {
          setError(err?.response?.data?.message || 'Không tải được thông tin đơn hàng.');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [id]);

  if (loading) {
    return (
      <main className="luxury-page order-success-page">
        <div className="container">
          <div className="order-success-loading">
            <div className="order-success-loading-orb" aria-hidden="true">
              <span />
            </div>
            <p>Đang xác nhận đơn hàng...</p>
          </div>
        </div>
      </main>
    );
  }

  if (error || !order) {
    return (
      <main className="luxury-page order-success-page">
        <div className="container">
          <section className="order-success-error luxury-surface">
            <div className="order-success-error-icon" aria-hidden="true">✕</div>
            <p className="section-eyebrow">Trạng thái đơn hàng</p>
            <h1>Không thể hiển thị xác nhận đơn hàng</h1>
            <p>{error || 'Đơn hàng không tồn tại.'}</p>
            <Link to="/orders" className="btn luxury-primary-btn">Xem lịch sử đơn hàng</Link>
          </section>
        </div>
      </main>
    );
  }

  const itemCount = (order.items || []).reduce((sum, item) => sum + item.quantity, 0);
  const orderDate = order.createdAt
    ? new Date(order.createdAt).toLocaleDateString('vi-VN', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : null;
  const orderCode = order.orderCode || `#${order.id}`;

  return (
    <main className="luxury-page order-success-page order-success-animated">
      <ConfettiCanvas />

      <div className="container">
        {/* ─── Hero ─────────────────────────────────── */}
        <section className="order-success-hero luxury-surface os-anim os-anim-1">
          <div className="order-success-check-ring" aria-hidden="true">
            <svg viewBox="0 0 52 52" className="order-success-check-svg">
              <circle className="order-success-check-circle" cx="26" cy="26" r="24" fill="none" />
              <path className="order-success-check-path" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8" />
            </svg>
          </div>
          <p className="section-eyebrow">Đơn hàng đã được tiếp nhận</p>
          <h1>Đặt hàng thành công!</h1>
          <p>
            Cảm ơn bạn đã lựa chọn <strong>Huy Perfume</strong>. Đơn hàng{' '}
            <strong className="order-success-id">{orderCode}</strong> đã được
            tiếp nhận và đang chờ xử lý.
          </p>
          <div className="order-success-actions">
            <Link to={`/orders/${order.id}`} className="btn luxury-primary-btn">
              <span>📋</span> Xem chi tiết đơn
            </Link>
            <Link to="/products" className="btn luxury-secondary-btn">
              <span>🛍️</span> Tiếp tục mua sắm
            </Link>
          </div>
        </section>

        {/* ─── Timeline ────────────────────────────── */}
        <div className="os-anim os-anim-2">
          <OrderTimeline activeStep={getActiveStep(order.status, order.timeline)} />
        </div>

        {/* ─── Quick Stats ─────────────────────────── */}
        <div className="order-success-quick-stats os-anim os-anim-3">
          <div className="order-success-stat">
            <span className="order-success-stat-icon" aria-hidden="true">🧾</span>
            <div>
              <small>Mã đơn hàng</small>
              <strong>{orderCode}</strong>
            </div>
          </div>
          <div className="order-success-stat">
            <span className="order-success-stat-icon" aria-hidden="true">📦</span>
            <div>
              <small>Sản phẩm</small>
              <strong>{itemCount} sản phẩm</strong>
            </div>
          </div>
          <div className="order-success-stat">
            <span className="order-success-stat-icon" aria-hidden="true">💰</span>
            <div>
              <small>Tổng thanh toán</small>
              <strong>{formatVnCurrency(order.total)}</strong>
            </div>
          </div>
          <div className="order-success-stat">
            <span className="order-success-stat-icon" aria-hidden="true">
              {paymentIcons[order.paymentMethod] || '💳'}
            </span>
            <div>
              <small>Thanh toán</small>
              <strong>{paymentLabels[order.paymentMethod] || order.paymentMethod || '-'}</strong>
            </div>
          </div>
        </div>

        {/* ─── Detail Grid ─────────────────────────── */}
        <div className="order-success-grid os-anim os-anim-4">
          {/* Left – Shipping Info */}
          <section className="order-success-card luxury-surface">
            <p className="section-eyebrow">📍 Thông tin giao hàng</p>
            <h2>Thông tin giao hàng</h2>
            <div className="order-success-facts">
              <div>
                <span>Mã đơn hàng</span>
                <strong>{orderCode}</strong>
              </div>
              <div>
                <span>Trạng thái</span>
                <strong className="order-status-pill">
                  {getOrderStatusLabel(order.status)}
                </strong>
              </div>
              <div>
                <span>Thanh toán</span>
                <strong>
                  {paymentIcons[order.paymentMethod] || ''}{' '}
                  {paymentLabels[order.paymentMethod] || order.paymentMethod || '-'}
                </strong>
              </div>
              <div>
                <span>Số điện thoại</span>
                <strong>{order.phone || '-'}</strong>
              </div>
              {orderDate && (
                <div>
                  <span>Ngày đặt hàng</span>
                  <strong>{orderDate}</strong>
                </div>
              )}
              <div className="order-success-address">
                <span>Địa chỉ nhận hàng</span>
                <strong>{order.shippingAddress || '-'}</strong>
              </div>
            </div>
          </section>

          {/* Right – Products */}
          <aside className="order-success-card luxury-surface">
            <p className="section-eyebrow">🛒 Đơn hàng của bạn</p>
            <h2>Sản phẩm ({itemCount})</h2>
            <div className="order-success-items">
              {(order.items || []).map((item, index) => (
                <div
                  className="order-success-item"
                  key={`${item.productId || index}-${item.variantId || 'default'}-${item.itemType || 'FULL_BOTTLE'}-${item.selectedVolumeMl || 'full'}`}
                  style={{ animationDelay: `${1.1 + index * 0.08}s` }}
                >
                  <img
                    src={resolveProductImage(item.productImage)}
                    alt={item.productName}
                    loading="lazy"
                    decoding="async"
                  />
                  <div>
                    <strong>{item.productName}</strong>
                    <small>{getOrderItemLabel(item)}</small>
                    <span>Số lượng: {item.quantity}</span>
                  </div>
                  <b>{formatVnCurrency((item.priceAtPurchase || 0) * item.quantity)}</b>
                </div>
              ))}
            </div>
            <div className="luxury-summary-total">
              <span>Tổng cộng</span>
              <strong>{formatVnCurrency(order.total)}</strong>
            </div>
          </aside>
        </div>

        {/* ─── Footer note ─────────────────────────── */}
        <p className="order-success-note os-anim os-anim-5">
          📬 Bạn có thể theo dõi tiến trình giao hàng trong mục{' '}
          <Link to="/orders">lịch sử đơn hàng</Link>.
        </p>
      </div>
    </main>
  );
}
