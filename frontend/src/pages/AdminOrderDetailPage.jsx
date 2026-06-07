import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../services/api';
import { AdminStatusBadge, formatAdminCurrency, formatAdminDate } from '../components/Admin/AdminUi';
import { formatPaymentMethodLabel, formatPaymentStatusLabel } from '../utils/formatters';

function unwrapApiData(payload) {
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
}

export function AdminOrderDetailPage() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) {
      setError('Thiếu mã đơn hàng.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');
    api
      .get(`/admin/orders/${id}`)
      .then((res) => {
        const data = unwrapApiData(res.data);
        setOrder(data && !Array.isArray(data) ? data : null);
        setItems(Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []);
      })
      .catch((err) => setError(err?.response?.data?.message || 'Không tải được chi tiết đơn hàng.'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="text-center py-5"><div className="spinner-border" /></div>;

  return (
    <div className="container py-4">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h3 className="mb-0">Admin - Chi tiết đơn #{id}</h3>
        <Link to="/admin/orders" className="btn btn-outline-dark btn-sm">Quay lại</Link>
      </div>
      {error && <div className="alert alert-danger">{error}</div>}
      {order && (
        <section className="luxury-surface order-detail-information mb-4">
          <div><strong>Khách hàng:</strong> {order.userName || '-'}</div>
          <div><strong>Ngày đặt:</strong> {formatAdminDate(order.createdAt)}</div>
          <div><strong>Tổng tiền:</strong> {formatAdminCurrency(order.total)}</div>
          <div><strong>Thanh toán:</strong> {order.paymentMethodLabel || formatPaymentMethodLabel(order.paymentMethod)}</div>
          {order.paymentStatus && <div><strong>Trạng thái thanh toán:</strong> {formatPaymentStatusLabel(order.paymentStatus)}</div>}
          <div><strong>Trạng thái:</strong> <AdminStatusBadge status={order.status} /></div>
          {order.failureReason && <div className="wide"><strong>Lý do thanh toán:</strong> {order.failureReason}</div>}
          <div><strong>SĐT:</strong> {order.phone || '-'}</div>
          <div className="wide"><strong>Địa chỉ:</strong> {order.shippingAddress || '-'}</div>
        </section>
      )}
      <div className="table-responsive">
        <table className="table table-hover">
          <thead className="table-dark">
            <tr>
              <th>Mã sản phẩm</th>
              <th>Sản phẩm</th>
              <th>Số lượng</th>
              <th>Giá</th>
              <th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.itemId || item.item_id}>
                <td>#{item.itemId || item.item_id}</td>
                <td>{item.name}</td>
                <td>{item.quantity}</td>
                <td>{Number(item.price || 0).toLocaleString('vi-VN')}₫</td>
                <td>{item.status || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
