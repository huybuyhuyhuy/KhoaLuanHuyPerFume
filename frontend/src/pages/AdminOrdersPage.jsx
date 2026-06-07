import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../services/api';
import {
  AdminEmptyState,
  AdminPageHeader,
  AdminPagination,
  AdminStatGrid,
  AdminStatusBadge,
  formatAdminCurrency,
  formatAdminDate,
} from '../components/Admin/AdminUi';
import { ORDER_STATUS_OPTIONS } from '../constants/orderStatus';
import { formatPaymentMethodLabel } from '../utils/formatters';

const PAGE_SIZE = 12;
const PAYMENT_METHODS = ['COD', 'BANKING', 'MOMO', 'ZALOPAY'];
const ORDER_STATUS_VALUES = ORDER_STATUS_OPTIONS.map((status) => status.value);

function unwrapApiData(payload) {
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('vi-VN');
}

function chartDateLabel(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

export function AdminOrdersPage() {
  const [searchParams] = useSearchParams();
  const linkedUserId = searchParams.get('userId') || '';
  const linkedUserName = searchParams.get('userName') || '';
  const initialFilters = useMemo(
    () => ({ search: '', status: '', paymentMethod: '', dateFrom: '', dateTo: '', userId: linkedUserId }),
    [linkedUserId]
  );
  const [orders, setOrders] = useState([]);
  const [summary, setSummary] = useState({});
  const [analytics, setAnalytics] = useState({});
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, totalElements: 0 });
  const [filters, setFilters] = useState(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState(initialFilters);
  const [page, setPage] = useState(1);
  const [savingId, setSavingId] = useState(null);
  const [feedback, setFeedback] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true);
    setError('');
    Promise
      .allSettled([
        api.get('/admin/orders', { params: { page, pageSize: PAGE_SIZE, ...appliedFilters } }),
        api.get('/admin/orders/analytics', { params: appliedFilters }),
      ])
      .then(([ordersResult, analyticsResult]) => {
        if (ordersResult.status !== 'fulfilled') {
          throw ordersResult.reason;
        }

        const data = unwrapApiData(ordersResult.value.data) || {};
        setOrders(Array.isArray(data.listOrders) ? data.listOrders : []);
        setSummary(data.summary || {});
        setPagination({
          page: Number(data.currentOrderPage || page),
          totalPages: Number(data.totalOrderPages || 1),
          totalElements: Number(data.totalOrders || 0),
        });

        if (analyticsResult.status === 'fulfilled') {
          setAnalytics(unwrapApiData(analyticsResult.value.data) || {});
        } else {
          setAnalytics({});
        }
      })
      .catch((err) => setError(err?.message || 'Không tải được danh sách đơn hàng.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [page, appliedFilters]);

  useEffect(() => {
    setFilters(initialFilters);
    setAppliedFilters(initialFilters);
    setPage(1);
  }, [initialFilters]);

  const applyFilters = (event) => {
    event.preventDefault();
    setPage(1);
    setAppliedFilters({ ...filters });
  };

  const clearFilters = () => {
    setFilters(initialFilters);
    setPage(1);
    setAppliedFilters(initialFilters);
  };

  const updateStatus = async (orderId, status) => {
    setSavingId(orderId);
    setFeedback('');
    setError('');
    try {
      await api.patch(`/admin/orders/${orderId}/status`, { status });
      setFeedback(`Đã cập nhật trạng thái đơn #${orderId}.`);
      load();
    } catch (err) {
      setError(err?.message || 'Cập nhật trạng thái thất bại.');
    } finally {
      setSavingId(null);
    }
  };

  const analyticsSummary = analytics.summary || {};
  const mergedSummary = { ...summary, ...analyticsSummary };
  const stats = [
    { label: 'Đơn theo bộ lọc', value: formatNumber(mergedSummary.total), hint: 'Kết quả hiện tại', icon: 'ORD' },
    { label: 'Tổng giá trị', value: formatAdminCurrency(mergedSummary.value), hint: 'Theo bộ lọc', tone: 'positive', icon: '₫' },
    { label: 'Đang xử lý', value: formatNumber(mergedSummary.processing), hint: 'Đóng gói / đang giao', tone: 'warning', icon: '↻' },
    { label: 'Giá trị đơn TB', value: formatAdminCurrency(mergedSummary.averageValue), hint: 'AOV hiện tại', tone: 'positive', icon: '◎' },
  ];

  const dailyRevenue = Array.isArray(analytics.dailyRevenue) ? analytics.dailyRevenue : Array.isArray(summary.dailyRevenue) ? summary.dailyRevenue : [];
  const paymentBreakdown = Array.isArray(analytics.paymentBreakdown) ? analytics.paymentBreakdown : Array.isArray(summary.paymentBreakdown) ? summary.paymentBreakdown : [];
  const statusBreakdown = Array.isArray(analytics.statusBreakdown) ? analytics.statusBreakdown : Array.isArray(summary.statusBreakdown) ? summary.statusBreakdown : [];
  const maxRevenue = Math.max(...dailyRevenue.map((item) => Number(item.revenue || 0)), 1);

  return (
    <div className="admin-page huy-admin-ops-page">
      <AdminPageHeader
        eyebrow="Quản lý đơn hàng"
        title="Quản lý đơn hàng"
        description={linkedUserId ? `Đơn hàng của ${linkedUserName || `tài khoản #${linkedUserId}`}.` : 'Theo dõi thanh toán, xử lý giao hàng và hiệu suất đơn theo thời gian thực.'}
        action={(
          <div className="admin-page-action-row">
            <Link to="/admin/reports" className="btn btn-outline-dark">Báo cáo</Link>
            {linkedUserId ? (
              <Link to="/admin/orders" className="btn btn-outline-dark">Xem tất cả đơn</Link>
            ) : (
              <button type="button" className="btn btn-outline-dark" onClick={load}>Làm mới dữ liệu</button>
            )}
          </div>
        )}
      />

      <AdminStatGrid items={stats} />

      <form className="admin-filter-panel admin-filter-orders" onSubmit={applyFilters}>
        <div className="admin-filter-field grow">
          <label htmlFor="admin-order-search">Tìm đơn hàng</label>
          <input
            id="admin-order-search"
            className="form-control"
            value={filters.search}
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
            placeholder="Mã đơn hoặc tên khách"
          />
        </div>
        <div className="admin-filter-field">
          <label htmlFor="admin-order-status">Trạng thái</label>
          <select id="admin-order-status" className="form-select" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
            <option value="">Tất cả</option>
            {ORDER_STATUS_OPTIONS.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
          </select>
        </div>
        <div className="admin-filter-field">
          <label htmlFor="admin-order-payment">Thanh toán</label>
          <select id="admin-order-payment" className="form-select" value={filters.paymentMethod} onChange={(event) => setFilters({ ...filters, paymentMethod: event.target.value })}>
            <option value="">Tất cả</option>
            {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{formatPaymentMethodLabel(method)}</option>)}
          </select>
        </div>
        <div className="admin-filter-field compact">
          <label htmlFor="admin-order-from">Từ ngày</label>
          <input id="admin-order-from" className="form-control" type="date" value={filters.dateFrom} onChange={(event) => setFilters({ ...filters, dateFrom: event.target.value })} />
        </div>
        <div className="admin-filter-field compact">
          <label htmlFor="admin-order-to">Đến ngày</label>
          <input id="admin-order-to" className="form-control" type="date" value={filters.dateTo} onChange={(event) => setFilters({ ...filters, dateTo: event.target.value })} />
        </div>
        <button className="btn luxury-primary-btn" type="submit">Lọc</button>
        <button className="btn btn-outline-dark" type="button" onClick={clearFilters}>Xóa lọc</button>
      </form>

      {error && <div className="alert alert-danger admin-alert">{error}</div>}
      {feedback && <div className="alert alert-success admin-alert">{feedback}</div>}

      <section className="admin-insight-grid">
        <article className="admin-insight-card wide">
          <div className="admin-insight-head">
            <div>
              <span className="admin-eyebrow">Doanh thu</span>
              <h2>Doanh thu 14 ngày gần nhất</h2>
            </div>
            <strong>{formatAdminCurrency(dailyRevenue.reduce((sum, item) => sum + Number(item.revenue || 0), 0))}</strong>
          </div>
          <div className="admin-mini-bar-chart" role="img" aria-label="Doanh thu đơn hàng theo ngày">
            {dailyRevenue.length === 0 ? (
              <span className="admin-chart-empty">Chưa có dữ liệu</span>
            ) : dailyRevenue.map((item, index) => (
              <div className="admin-mini-bar-item" key={String(item.date)}>
                <span
                  style={{
                    height: `${Math.max((Number(item.revenue || 0) / maxRevenue) * 100, 8)}%`,
                    '--bar-delay': `${index * 55}ms`,
                  }}
                  title={formatAdminCurrency(item.revenue)}
                />
                <small>{chartDateLabel(item.date)}</small>
              </div>
            ))}
          </div>
        </article>

        <article className="admin-insight-card">
          <div className="admin-insight-head compact">
            <div>
              <span className="admin-eyebrow">Phương thức thanh toán</span>
              <h2>Thanh toán</h2>
            </div>
          </div>
          <div className="admin-breakdown-list">
            {paymentBreakdown.length === 0 ? <span className="admin-muted">Chưa có dữ liệu</span> : paymentBreakdown.map((item) => (
              <div className="admin-breakdown-row" key={item.method}>
                <span>{item.label || formatPaymentMethodLabel(item.method)}</span>
                <strong>{formatNumber(item.total)}</strong>
                <small>{formatAdminCurrency(item.value)}</small>
              </div>
            ))}
          </div>
        </article>

        <article className="admin-insight-card">
          <div className="admin-insight-head compact">
            <div>
              <span className="admin-eyebrow">Trạng thái</span>
              <h2>Trạng thái</h2>
            </div>
          </div>
          <div className="admin-breakdown-list">
            {statusBreakdown.length === 0 ? <span className="admin-muted">Chưa có dữ liệu</span> : statusBreakdown.slice(0, 5).map((item) => (
              <div className="admin-breakdown-row" key={item.status}>
                <AdminStatusBadge status={item.status} />
                <strong>{formatNumber(item.total)}</strong>
                <small>{formatAdminCurrency(item.value)}</small>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="admin-table-panel">
        <div className="admin-table-title">
          <div>
            <span className="admin-eyebrow">Danh sách đơn hàng</span>
            <h2>Danh sách đơn hàng</h2>
          </div>
          <span>{formatNumber(pagination.totalElements)} đơn</span>
        </div>
        {loading ? (
          <div className="admin-loading"><div className="spinner-border" /> Đang tải đơn hàng...</div>
        ) : orders.length === 0 ? (
          <AdminEmptyState title="Chưa có đơn hàng phù hợp" description="Thử bỏ bớt điều kiện lọc hoặc tìm theo mã đơn khác." />
        ) : (
          <>
            <div className="table-responsive">
              <table className="table admin-table align-middle">
                <thead>
                  <tr>
                    <th>Mã đơn</th>
                    <th>Khách hàng</th>
                    <th>Tổng tiền</th>
                    <th>Thanh toán</th>
                    <th>Ngày tạo</th>
                    <th>Trạng thái</th>
                    <th className="text-end">Hành động</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <td><strong>{order.orderCode || `#${order.id}`}</strong></td>
                      <td>{order.userName || '-'}</td>
                      <td><strong>{formatAdminCurrency(order.total)}</strong></td>
                      <td>{order.paymentMethodLabel || formatPaymentMethodLabel(order.paymentMethod)}</td>
                      <td>{formatAdminDate(order.createdAt)}</td>
                      <td><AdminStatusBadge status={order.status} /></td>
                      <td>
                        <div className="admin-row-actions justify-content-end">
                          <select
                            aria-label={`Cập nhật trạng thái đơn ${order.id}`}
                            className="form-select form-select-sm admin-status-select"
                            value={order.status}
                            disabled={savingId === order.id}
                            onChange={(event) => updateStatus(order.id, event.target.value)}
                          >
                            {!ORDER_STATUS_VALUES.includes(order.status) && <option value={order.status}>{order.status}</option>}
                            {ORDER_STATUS_OPTIONS.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
                          </select>
                          <Link to={`/admin/orders/${order.id}`} className="btn btn-sm btn-outline-dark">Chi tiết</Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <AdminPagination {...pagination} onChange={setPage} />
          </>
        )}
      </section>
    </div>
  );
}
