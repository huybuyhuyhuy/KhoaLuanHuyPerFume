import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { orderService } from '../services/orderService';
import { cartService } from '../services/cartService';
import { formatPaymentMethodLabel, formatVnCurrency } from '../utils/formatters';
import { getOrderStatusLabel, getOrderStatusTone } from '../constants/orderStatus';

export function OrderHistoryPage() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rebuyingId, setRebuyingId] = useState(null);
  const [rebuyMessage, setRebuyMessage] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError('');
    orderService
      .getUserOrders()
      .then((data) => setOrders(Array.isArray(data) ? data : Array.isArray(data?.content) ? data.content : []))
      .catch((err) => setError(err?.response?.data?.message || 'Không tải được lịch sử đơn hàng.'))
      .finally(() => setLoading(false));
  }, []);

  const handleRebuy = async (order) => {
    setRebuyingId(order.id);
    setRebuyMessage(null);
    try {
      const result = await cartService.addOrderItems(order.items || []);
      const failedNames = result.failed.map(({ item, reason }) => `${item.productName || 'Sản phẩm'}: ${reason}`);

      if (result.added.length > 0 && failedNames.length === 0) {
        setRebuyMessage({ type: 'success', text: `Đã thêm lại ${result.added.length} sản phẩm vào giỏ hàng.` });
        navigate('/cart');
        return;
      }

      if (result.added.length > 0) {
        setRebuyMessage({
          type: 'warning',
          text: `Đã thêm ${result.added.length} sản phẩm. Không thêm được: ${failedNames.join('; ')}`,
        });
        return;
      }

      setRebuyMessage({
        type: 'error',
        text: `Không thêm được sản phẩm nào. ${failedNames.join('; ') || 'Các sản phẩm trong đơn không còn khả dụng.'}`,
      });
    } finally {
      setRebuyingId(null);
    }
  };

  if (loading) return <div className="text-center py-5"><div className="spinner-border" /></div>;

  if (error) {
    return (
      <div className="container py-4">
        <h3 className="mb-4">Lịch sử đơn hàng</h3>
        <div className="alert alert-danger">{error}</div>
      </div>
    );
  }

  return (
    <main className="luxury-page order-history-page">
      <div className="container py-4">
        <header className="order-history-header">
          <p className="section-eyebrow">Tài khoản của bạn</p>
          <h1>Lịch sử đơn hàng</h1>
        </header>
        {rebuyMessage && (
          <div className={`alert ${rebuyMessage.type === 'success' ? 'alert-success' : rebuyMessage.type === 'warning' ? 'alert-warning' : 'alert-danger'}`}>
            {rebuyMessage.text}
          </div>
        )}
        {orders.length === 0 ? (
          <section className="luxury-surface order-history-empty">
            <p className="luxury-muted">Bạn chưa có đơn hàng nào.</p>
            <Link to="/products" className="btn luxury-primary-btn">Mua sắm ngay</Link>
          </section>
        ) : (
          <section className="luxury-surface order-history-table">
            <div className="table-responsive">
              <table className="table align-middle">
                <thead>
                  <tr>
                    <th>Mã đơn</th>
                    <th>Ngày đặt</th>
                    <th>Tổng tiền</th>
                    <th>Phương thức</th>
                    <th>Trạng thái</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <td><strong>{order.orderCode || `#${order.id}`}</strong></td>
                      <td>{new Date(order.createdAt).toLocaleDateString('vi-VN')}</td>
                      <td><strong>{formatVnCurrency(order.total)}</strong></td>
                      <td>{order.paymentMethodLabel || formatPaymentMethodLabel(order.paymentMethod)}</td>
                      <td>
                        <span className={`order-history-status ${getOrderStatusTone(order.status)}`}>
                          {getOrderStatusLabel(order.status)}
                        </span>
                      </td>
                      <td className="text-end">
                        <div className="order-history-actions">
                          <Link to={`/orders/${order.id}`} className="btn btn-sm btn-outline-dark">Chi tiết</Link>
                          <button type="button" className="btn btn-sm luxury-primary-btn" disabled={rebuyingId === order.id} onClick={() => handleRebuy(order)}>
                            {rebuyingId === order.id ? 'Đang thêm...' : 'Mua lại'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
