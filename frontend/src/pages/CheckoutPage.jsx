import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCart } from '../hooks/useCart';
import { useAuth } from '../hooks/useAuth';
import { orderService } from '../services/orderService';
import { addressService, formatAddress } from '../services/addressService';
import { voucherService } from '../services/voucherService';
import { clearCartVoucher, readCartVoucher, saveCartVoucher } from '../utils/cartVoucherStorage';
import { savePaymentAuthBridge } from '../utils/paymentAuthBridge';
import { clearPendingPaymentReturn, savePendingPaymentReturn } from '../utils/pendingPaymentReturn';
import { resolveProductImage } from '../utils/image';
import { formatVnCurrency } from '../utils/formatters';
import { siteContact } from '../config/siteConfig';

const paymentMethods = [
  { value: 'COD', label: 'Thanh toán khi nhận hàng', note: 'Phù hợp khi bạn muốn kiểm tra kiện hàng trước.' },
  { value: 'MOMO', label: 'MoMo UAT', note: 'Cổng test có thể từ chối thẻ ATM UAT; mỗi lần thử sẽ tạo link mới.' },
  { value: 'ZALOPAY', label: 'ZaloPay Sandbox', note: 'Ưu tiên dùng khi demo chính nếu MoMo UAT bị từ chối.' },
];

const emptyShippingForm = {
  recipientName: '',
  phone: '',
  city: '',
  district: '',
  ward: '',
  line1: '',
  label: '',
  saveAddress: false,
  isDefault: false,
};

function getCartItemLabel(product) {
  const itemType = String(product?.itemType || '').toUpperCase();
  const variantType = String(product?.selectedVariant?.type || '').toUpperCase();
  const isDecant = itemType === 'DECANT' || variantType === 'DECANT';
  const volumeMl = product?.selectedVolumeMl || product?.selectedVariant?.volumeMl || null;
  return isDecant ? `Chiết ${volumeMl || ''}ml`.trim() : (product?.selectedVariant?.volume || product?.selectedVariant?.label || 'Full chai');
}

function formatVoucherDiscount(voucher) {
  if (!voucher) return '';
  if (voucher.discountType === 'PERCENT') {
    const percent = Number(voucher.discountValue || voucher.discountPercent || 0);
    return `${Number.isInteger(percent) ? percent : percent.toLocaleString('vi-VN')}%`;
  }
  return formatVnCurrency(voucher.discountValue);
}

function getVoucherErrorMessage(error) {
  const responseData = error?.response?.data || {};
  return responseData?.data?.message || responseData?.message || error?.message || 'Không áp dụng được mã voucher.';
}

function getCheckoutErrorMessage(error) {
  const responseData = error?.response?.data || {};
  return responseData?.data?.message || responseData?.message || error?.message || 'Lỗi đặt hàng';
}

function buildShippingAddress(form) {
  return [form.line1, form.ward, form.district, form.city]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(', ');
}

export function CheckoutPage() {
  const { cart, loading: cartLoading, clearCart, fetchCart } = useCart();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [addresses, setAddresses] = useState([]);
  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [addressMode, setAddressMode] = useState('saved');
  const [addressLoading, setAddressLoading] = useState(false);
  const [shippingForm, setShippingForm] = useState(() => ({
    ...emptyShippingForm,
    recipientName: user?.name || '',
    phone: user?.phone || '',
  }));
  const [paymentMethod, setPaymentMethod] = useState('COD');
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [appliedVoucher, setAppliedVoucher] = useState(() => readCartVoucher());
  const [voucherMessage, setVoucherMessage] = useState('');
  const [momoPayment, setMomoPayment] = useState(null);
  const [zaloPayment, setZaloPayment] = useState(null);
  const [isCompletingCheckout, setIsCompletingCheckout] = useState(false);

  const selectedAddress = useMemo(
    () => addresses.find((item) => String(item.id) === String(selectedAddressId)) || null,
    [addresses, selectedAddressId]
  );
  const normalizedNewPhone = useMemo(() => shippingForm.phone.replace(/\D/g, ''), [shippingForm.phone]);
  const cartTotal = Math.round(Number(cart?.total || 0));
  const voucherMatchesSubtotal = Boolean(appliedVoucher && Number(appliedVoucher.subtotal || 0) === cartTotal);
  const voucherDiscount = voucherMatchesSubtotal ? Number(appliedVoucher.discountAmount || 0) : 0;
  const checkoutTotal = Math.max(0, cartTotal - voucherDiscount);

  useEffect(() => {
    if (isCompletingCheckout) return;
    if (!cartLoading && (!cart || cart.items.length === 0)) {
      navigate('/cart', { replace: true });
    }
  }, [cart, cartLoading, isCompletingCheckout, navigate]);

  useEffect(() => {
    setShippingForm((current) => ({
      ...current,
      recipientName: current.recipientName || user?.name || '',
      phone: current.phone || user?.phone || '',
    }));
  }, [user?.name, user?.phone]);

  useEffect(() => {
    if (!user) return;
    let ignore = false;
    setAddressLoading(true);
    addressService.list()
      .then((list) => {
        if (ignore) return;
        setAddresses(list);
        const defaultAddress = list.find((item) => item.isDefault) || list[0] || null;
        if (defaultAddress) {
          setSelectedAddressId(String(defaultAddress.id));
          setAddressMode('saved');
        } else {
          setAddressMode('new');
        }
      })
      .catch(() => {
        if (!ignore) setAddressMode('new');
      })
      .finally(() => {
        if (!ignore) setAddressLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [user]);

  useEffect(() => {
    if (!cartTotal) return;

    const storedVoucher = readCartVoucher();
    if (!storedVoucher?.code) {
      setAppliedVoucher(null);
      setVoucherMessage('');
      return;
    }

    let ignore = false;
    voucherService.validateVoucher({ code: storedVoucher.code, subtotal: cartTotal })
      .then((voucher) => {
        if (ignore) return;
        setAppliedVoucher(voucher);
        saveCartVoucher(voucher);
        setVoucherMessage('');
      })
      .catch((err) => {
        if (ignore) return;
        setAppliedVoucher(null);
        clearCartVoucher();
        setVoucherMessage(getVoucherErrorMessage(err));
      });

    return () => {
      ignore = true;
    };
  }, [cartTotal]);

  if (cartLoading) {
    return (
      <main className="luxury-page checkout-page">
        <div className="container">
          <div className="luxury-cart-loading luxury-surface">Đang chuẩn bị thanh toán...</div>
        </div>
      </main>
    );
  }

  if (!cart || cart.items.length === 0) {
    if (isCompletingCheckout) {
      return (
        <main className="luxury-page checkout-page">
          <div className="container">
            <div className="luxury-cart-loading luxury-surface">Đang hoàn tất đơn hàng...</div>
          </div>
        </main>
      );
    }
    return null;
  }

  const handleCheckout = async () => {
    setFormError('');
    setMomoPayment(null);
    setZaloPayment(null);
    setIsCompletingCheckout(false);
    const usingSavedAddress = addressMode === 'saved' && selectedAddress;
    const checkoutPhone = usingSavedAddress ? selectedAddress.phone.replace(/\D/g, '') : normalizedNewPhone;
    const checkoutAddress = usingSavedAddress ? formatAddress(selectedAddress) : buildShippingAddress(shippingForm);

    if (!/^\d{10}$/.test(checkoutPhone)) {
      setFormError('Số điện thoại cần đúng 10 chữ số.');
      return;
    }
    if (!checkoutAddress.trim()) {
      setFormError('Vui lòng nhập địa chỉ giao hàng.');
      return;
    }
    if (!usingSavedAddress && (!shippingForm.recipientName.trim() || !shippingForm.city.trim() || !shippingForm.district.trim() || !shippingForm.ward.trim() || !shippingForm.line1.trim())) {
      setFormError('Vui lòng nhập đủ thông tin người nhận và địa chỉ giao hàng.');
      return;
    }

    setLoading(true);
    try {
      if (!usingSavedAddress && shippingForm.saveAddress) {
        await addressService.create({
          label: shippingForm.label.trim(),
          recipientName: shippingForm.recipientName.trim(),
          phone: checkoutPhone,
          city: shippingForm.city.trim(),
          district: shippingForm.district.trim(),
          ward: shippingForm.ward.trim(),
          line1: shippingForm.line1.trim(),
          line2: '',
          country: 'VN',
          postalCode: '',
          isDefault: shippingForm.isDefault || addresses.length === 0,
        });
      }

      const order = await orderService.checkout({
        shippingAddress: checkoutAddress.trim(),
        phone: checkoutPhone,
        paymentMethod,
        voucherCode: voucherMatchesSubtotal ? appliedVoucher.code : '',
      });

      if (paymentMethod === 'MOMO') {
        savePaymentAuthBridge();
        const paymentResponse = await orderService.createMomoPayment(order.id);
        const paymentUrl = paymentResponse?.paymentUrl || paymentResponse?.payUrl || paymentResponse?.orderUrl || paymentResponse?.deeplink || '';
        if (!paymentUrl) throw new Error('Không tạo được link thanh toán MoMo');
        setMomoPayment({
          orderId: order.id,
          paymentUrl,
          momoOrderId: paymentResponse?.momoOrderId || '',
          gatewayOpened: false,
        });
        return;
      }

      if (paymentMethod === 'ZALOPAY') {
        savePaymentAuthBridge();
        const paymentResponse = await orderService.createZaloPayPayment(order.id);
        const paymentUrl = paymentResponse?.paymentUrl || paymentResponse?.orderUrl;
        if (!paymentUrl) throw new Error('Không tạo được link thanh toán ZaloPay');
        const appTransId = paymentResponse?.appTransId || paymentResponse?.zalopayAppTransId || '';
        savePendingPaymentReturn({
          paymentMethod: 'ZALOPAY',
          orderId: order.id,
          externalOrderId: appTransId,
        });
        setZaloPayment({
          orderId: order.id,
          paymentUrl,
          appTransId,
          gatewayOpened: false,
        });
        return;
      }

      setIsCompletingCheckout(true);
      clearCart().catch(() => undefined);
      clearCartVoucher();
      navigate(`/checkout/success?orderId=${encodeURIComponent(order.id)}&total=${encodeURIComponent(String(checkoutTotal))}&paymentMethod=${encodeURIComponent(paymentMethod)}`, { replace: true });
    } catch (err) {
      const message = getCheckoutErrorMessage(err);
      setFormError(message);
      if (err?.status === 409 || String(message).toLowerCase().includes('tồn kho')) {
        await fetchCart();
      }
    } finally {
      setLoading(false);
    }
  };

  const openMomoGateway = () => {
    if (!momoPayment?.paymentUrl) return;
    setMomoPayment((current) => current ? { ...current, gatewayOpened: true } : current);
    savePaymentAuthBridge();
    window.location.href = momoPayment.paymentUrl;
  };

  const openZaloGateway = () => {
    if (!zaloPayment?.paymentUrl) return;
    setZaloPayment((current) => current ? { ...current, gatewayOpened: true } : current);
    savePaymentAuthBridge();
    savePendingPaymentReturn({
      paymentMethod: 'ZALOPAY',
      orderId: zaloPayment.orderId,
      externalOrderId: zaloPayment.appTransId || '',
    });
    window.location.href = zaloPayment.paymentUrl;
  };

  const closeMomoGateway = () => {
    const payment = momoPayment;
    setMomoPayment(null);
    if (payment?.orderId && !payment.gatewayOpened) {
      orderService.cancelOrder(payment.orderId, 'Khách đóng popup MoMo trước khi mở cổng thanh toán').catch(() => undefined);
    }
  };

  const closeZaloGateway = () => {
    const payment = zaloPayment;
    setZaloPayment(null);
    if (!payment?.gatewayOpened) clearPendingPaymentReturn();
    if (payment?.orderId && !payment.gatewayOpened) {
      orderService.cancelOrder(payment.orderId, 'Khách đóng popup ZaloPay trước khi mở cổng thanh toán').catch(() => undefined);
    }
  };

  return (
    <main className="luxury-page checkout-page">
      <div className="container">
        <section className="luxury-checkout-hero">
          <div>
            <p className="section-eyebrow">Thanh toán an toàn</p>
            <h1>Thanh toán</h1>
            <p>Hoàn tất thông tin giao hàng, chọn phương thức thanh toán và xác nhận đơn.</p>
          </div>
          <Link to="/cart" className="btn luxury-secondary-btn">Quay lại giỏ hàng</Link>
        </section>

        <div className="luxury-checkout-layout">
          <section className="luxury-checkout-main">
            <div className="luxury-checkout-panel luxury-surface">
              <p className="section-eyebrow">Giao hàng</p>
              <h2>Thông tin giao hàng</h2>
              <div className="checkout-address-tabs" role="tablist" aria-label="Chọn địa chỉ giao hàng">
                <button type="button" className={addressMode === 'saved' ? 'active' : ''} disabled={addresses.length === 0} onClick={() => setAddressMode('saved')}>
                  Địa chỉ đã lưu
                </button>
                <button type="button" className={addressMode === 'new' ? 'active' : ''} onClick={() => setAddressMode('new')}>
                  Nhập địa chỉ mới
                </button>
              </div>

              {addressMode === 'saved' && addresses.length > 0 ? (
                <>
                  {addressLoading && <p className="luxury-muted">Đang tải sổ địa chỉ...</p>}
                  <div className="checkout-address-list">
                    {addresses.map((item) => (
                      <label key={item.id} className={`checkout-address-option ${String(selectedAddressId) === String(item.id) ? 'active' : ''}`}>
                        <input type="radio" name="savedAddress" value={item.id} checked={String(selectedAddressId) === String(item.id)} onChange={(event) => setSelectedAddressId(event.target.value)} />
                        <span>
                          <strong>{item.recipientName} - {item.phone}</strong>
                          <small>{formatAddress(item)}</small>
                          {item.isDefault && <em>Mặc định</em>}
                        </span>
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="luxury-form-grid">
                    <label>
                      <span>Người nhận *</span>
                      <input value={shippingForm.recipientName} onChange={(event) => setShippingForm((prev) => ({ ...prev, recipientName: event.target.value }))} autoComplete="shipping name" />
                    </label>
                    <label>
                      <span>Số điện thoại *</span>
                      <input value={shippingForm.phone} onChange={(event) => setShippingForm((prev) => ({ ...prev, phone: event.target.value }))} placeholder={siteContact.phone} inputMode="tel" autoComplete="tel" />
                    </label>
                    <label>
                      <span>Tỉnh/thành *</span>
                      <input value={shippingForm.city} onChange={(event) => setShippingForm((prev) => ({ ...prev, city: event.target.value }))} autoComplete="shipping address-level1" />
                    </label>
                    <label>
                      <span>Quận/huyện *</span>
                      <input value={shippingForm.district} onChange={(event) => setShippingForm((prev) => ({ ...prev, district: event.target.value }))} autoComplete="shipping address-level2" />
                    </label>
                    <label>
                      <span>Phường/xã *</span>
                      <input value={shippingForm.ward} onChange={(event) => setShippingForm((prev) => ({ ...prev, ward: event.target.value }))} />
                    </label>
                    <label>
                      <span>Nhãn địa chỉ</span>
                      <input value={shippingForm.label} onChange={(event) => setShippingForm((prev) => ({ ...prev, label: event.target.value }))} placeholder="Nhà riêng, công ty..." />
                    </label>
                  </div>
                  <label className="luxury-form-field">
                    <span>Địa chỉ chi tiết *</span>
                    <textarea rows={3} value={shippingForm.line1} onChange={(event) => setShippingForm((prev) => ({ ...prev, line1: event.target.value }))} placeholder="Số nhà, tên đường" autoComplete="shipping street-address" />
                  </label>
                  <div className="checkout-save-address">
                    <label>
                      <input type="checkbox" checked={shippingForm.saveAddress} onChange={(event) => setShippingForm((prev) => ({ ...prev, saveAddress: event.target.checked }))} />
                      <span>Lưu địa chỉ này vào sổ địa chỉ</span>
                    </label>
                    {shippingForm.saveAddress && (
                      <label>
                        <input type="checkbox" checked={shippingForm.isDefault} onChange={(event) => setShippingForm((prev) => ({ ...prev, isDefault: event.target.checked }))} />
                        <span>Đặt làm mặc định</span>
                      </label>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="luxury-checkout-panel luxury-surface">
              <p className="section-eyebrow">Thanh toán</p>
              <h2>Phương thức thanh toán</h2>
              <div className="luxury-payment-list">
                {paymentMethods.map((method) => (
                  <label key={method.value} className={`luxury-payment-option ${paymentMethod === method.value ? 'active' : ''}`}>
                    <input type="radio" value={method.value} checked={paymentMethod === method.value} onChange={(event) => setPaymentMethod(event.target.value)} />
                    <span>
                      <strong>{method.label}</strong>
                      <small>{method.note}</small>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </section>

          <aside className="luxury-checkout-summary luxury-surface">
            <p className="section-eyebrow">Đơn hàng</p>
            <h2>Đơn hàng</h2>
            <div className="luxury-checkout-items">
              {cart.items.map((item) => {
                const product = item.product;
                const price = product.discountPrice > 0 ? product.discountPrice : product.price;
                const itemLabel = getCartItemLabel(product);
                const key = `${product.id}-${product.variantId || 'default'}-${product.itemType || 'FULL_BOTTLE'}-${product.selectedVolumeMl || 'full'}`;
                return (
                  <div key={key} className="luxury-checkout-item">
                    <img src={resolveProductImage(product.image)} alt={product.name} loading="lazy" decoding="async" />
                    <div>
                      <strong>{product.name}</strong>
                      {itemLabel && <small>{itemLabel}</small>}
                      <span>x{item.quantity}</span>
                    </div>
                    <b>{formatVnCurrency(price * item.quantity)}</b>
                  </div>
                );
              })}
            </div>
            <div className="luxury-summary-line">
              <span>Tạm tính</span>
              <strong>{formatVnCurrency(cart.total)}</strong>
            </div>
            {voucherMatchesSubtotal && (
              <div className="luxury-summary-line luxury-summary-discount">
                <span>Voucher {appliedVoucher.code} ({formatVoucherDiscount(appliedVoucher)})</span>
                <strong>-{formatVnCurrency(voucherDiscount)}</strong>
              </div>
            )}
            {voucherMessage && <div className="luxury-checkout-voucher-note">{voucherMessage}</div>}
            <div className="luxury-summary-total">
              <span>Tổng cộng</span>
              <strong>{formatVnCurrency(checkoutTotal)}</strong>
            </div>
            {formError && <div className="luxury-checkout-error" role="alert">{formError}</div>}
            <button className="btn luxury-primary-btn w-100" disabled={loading} onClick={handleCheckout}>
              {loading ? 'Đang xử lý...' : 'Đặt hàng'}
            </button>
            <p className="luxury-summary-note">Đơn COD sẽ được tạo ngay. Với MoMo UAT/ZaloPay Sandbox, hệ thống sẽ chuyển sang cổng thanh toán sau bước này.</p>
          </aside>
        </div>
      </div>

      {momoPayment && (
        <div className="momo-qr-overlay" role="dialog" aria-modal="true" aria-labelledby="momo-qr-title" onClick={closeMomoGateway}>
          <div className="momo-qr-modal luxury-surface" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="momo-qr-close" aria-label="Đóng" onClick={closeMomoGateway}>×</button>
            <p className="section-eyebrow">Thanh toán MoMo UAT</p>
            <h2 id="momo-qr-title">Sẵn sàng chuyển sang MoMo UAT</h2>
            <p className="momo-qr-description">Cổng thanh toán MoMo UAT đã được tạo cho đơn hàng này. Nếu thẻ test bị từ chối, vui lòng tạo đơn mới hoặc chọn ZaloPay Sandbox/COD.</p>
            <div className="momo-gateway-card">
              <span>MoMo UAT</span>
              <strong>Đơn #{momoPayment.orderId}</strong>
              <small>Mỗi lần mở là một payUrl mới từ MoMo.</small>
            </div>
            <div className="momo-qr-actions">
              {momoPayment.paymentUrl && (
                <button type="button" className="btn luxury-primary-btn" onClick={openMomoGateway}>
                  Mở cổng MoMo UAT
                </button>
              )}
              <button type="button" className="btn luxury-secondary-btn" onClick={closeMomoGateway}>
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {zaloPayment && (
        <div className="momo-qr-overlay" role="dialog" aria-modal="true" aria-labelledby="zalo-gateway-title" onClick={closeZaloGateway}>
          <div className="momo-qr-modal luxury-surface" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="momo-qr-close" aria-label="Đóng" onClick={closeZaloGateway}>×</button>
            <p className="section-eyebrow">Thanh toán ZaloPay Sandbox</p>
            <h2 id="zalo-gateway-title">Sẵn sàng chuyển sang ZaloPay Sandbox</h2>
            <p className="momo-qr-description">Cổng thanh toán ZaloPay Sandbox đã được tạo cho đơn hàng này. Đây là lựa chọn ưu tiên cho demo chính.</p>
            <div className="momo-gateway-card">
              <span>ZaloPay Sandbox</span>
              <strong>Đơn #{zaloPayment.orderId}</strong>
              <small>Không cần quét mã QR.</small>
            </div>
            <div className="momo-qr-actions">
              {zaloPayment.paymentUrl && (
                <button type="button" className="btn luxury-primary-btn" onClick={openZaloGateway}>
                  Mở cổng ZaloPay Sandbox
                </button>
              )}
              <button type="button" className="btn luxury-secondary-btn" onClick={closeZaloGateway}>
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
