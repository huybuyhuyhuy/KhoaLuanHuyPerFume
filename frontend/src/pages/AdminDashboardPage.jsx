import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { AdminEmptyState, AdminStatusBadge } from '../components/Admin/AdminUi';
import { DEFAULT_PRODUCT_IMAGE, resolveProductImage } from '../utils/image';
import { formatPaymentMethodLabel } from '../utils/formatters';

const EMPTY_DASHBOARD = {
  revenueToday: 0,
  revenueThisMonth: 0,
  totalRevenue: 0,
  totalOrders: 0,
  newOrdersToProcess: 0,
  shippingOrders: 0,
  completedOrders: 0,
  cancelledOrders: 0,
  cancelRate: 0,
  averageOrderValue: 0,
  totalUsers: 0,
  newUsersThisMonth: 0,
  totalProducts: 0,
  lowStockProducts: 0,
  outOfStockProducts: 0,
  fullBottleRevenue: 0,
  decantRevenue: 0,
  charts: { revenue7Days: [], monthlyRevenue: [], paymentMethods: [], revenue: [], orders: [], users: [] },
  trend: { revenueGrowth: 0, orderGrowth: 0, customerGrowth: 0, productGrowth: 0 },
  topProducts: [],
  topBrands: [],
  topCustomers: [],
  lowStockItems: [],
  outOfStockItems: [],
  pendingReviews: [],
  recentOrders: [],
};

function unwrapApiData(payload) {
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function formatCurrency(value) {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(Math.round(asNumber(value)));
}

function formatNumber(value) {
  return Math.round(asNumber(value)).toLocaleString('vi-VN');
}

function formatPercent(value) {
  return `${asNumber(value).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`;
}

function formatGrowth(value) {
  const number = asNumber(value);
  return `${number > 0 ? '+' : ''}${number}%`;
}

function formatShortDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

function formatMonth(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('vi-VN', { month: '2-digit', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getErrorMessage(error, fallback) {
  return error?.response?.data?.message || error?.message || fallback;
}

function productFallbackImage(event) {
  event.currentTarget.onerror = null;
  event.currentTarget.src = DEFAULT_PRODUCT_IMAGE;
}

function mergeDashboardPayload(baseData, revenueData, topData, lowStockData) {
  const next = {
    ...EMPTY_DASHBOARD,
    ...baseData,
    charts: { ...EMPTY_DASHBOARD.charts, ...(baseData.charts || {}) },
    trend: { ...EMPTY_DASHBOARD.trend, ...(baseData.trend || {}) },
  };

  if (revenueData) {
    next.charts.revenue7Days = asArray(revenueData.revenue7Days).length ? asArray(revenueData.revenue7Days) : next.charts.revenue7Days;
    next.charts.monthlyRevenue = asArray(revenueData.monthlyRevenue).length ? asArray(revenueData.monthlyRevenue) : next.charts.monthlyRevenue;
    next.charts.paymentMethods = asArray(revenueData.paymentMethods).length ? asArray(revenueData.paymentMethods) : next.charts.paymentMethods;
    next.fullBottleRevenue = revenueData.revenueByType?.fullBottleRevenue ?? next.fullBottleRevenue;
    next.decantRevenue = revenueData.revenueByType?.decantRevenue ?? next.decantRevenue;
  }

  if (topData) {
    next.topProducts = asArray(topData.topProducts).length ? asArray(topData.topProducts) : next.topProducts;
    next.topBrands = asArray(topData.topBrands).length ? asArray(topData.topBrands) : next.topBrands;
    next.topCustomers = asArray(topData.topCustomers).length ? asArray(topData.topCustomers) : next.topCustomers;
  }

  if (lowStockData) {
    next.lowStockItems = asArray(lowStockData.lowStockProducts).length ? asArray(lowStockData.lowStockProducts) : next.lowStockItems;
    next.outOfStockItems = asArray(lowStockData.outOfStockProducts).length ? asArray(lowStockData.outOfStockProducts) : next.outOfStockItems;
    next.pendingReviews = asArray(lowStockData.pendingReviews).length ? asArray(lowStockData.pendingReviews) : next.pendingReviews;
  }

  return {
    ...next,
    topProducts: asArray(next.topProducts),
    topBrands: asArray(next.topBrands),
    topCustomers: asArray(next.topCustomers),
    lowStockItems: asArray(next.lowStockItems),
    outOfStockItems: asArray(next.outOfStockItems),
    pendingReviews: asArray(next.pendingReviews),
    recentOrders: asArray(next.recentOrders),
  };
}

function DashboardSkeleton() {
  return (
    <div className="huy-admin-dashboard">
      <section className="huy-admin-welcome admin-dashboard-skeleton hero" />
      <section className="huy-admin-metrics" aria-label="Đang tải dashboard">
        {Array.from({ length: 8 }).map((_, index) => (
          <article className="huy-admin-metric-card admin-dashboard-skeleton" key={index} />
        ))}
      </section>
      <div className="huy-admin-dashboard-grid">
        {Array.from({ length: 6 }).map((_, index) => (
          <section className={`huy-admin-panel admin-dashboard-skeleton panel-${index % 2 ? 'small' : 'large'}`} key={index} />
        ))}
      </div>
    </div>
  );
}

function MetricCard({ metric, index }) {
  return (
    <article className="huy-admin-metric-card admin-stat-card admin-animate-in" style={{ '--delay': `${index * 70}ms` }}>
      <div className="huy-admin-metric-head">
        <span>{metric.label}</span>
        <i className={`huy-admin-metric-icon ${metric.tone}`} aria-hidden="true">{metric.icon}</i>
      </div>
      <strong>{metric.value}</strong>
      <div className="huy-admin-metric-meta">
        <small>{metric.hint}</small>
        {metric.delta !== undefined && <span className={metric.delta >= 0 ? 'positive' : 'negative'}>{formatGrowth(metric.delta)}</span>}
      </div>
      <Link to={metric.to}>Xem chi tiết</Link>
    </article>
  );
}

function BarSeriesChart({ rows, period = 'day', emptyTitle, emptyDescription }) {
  const normalizedRows = asArray(rows);
  const hasData = normalizedRows.some((row) => asNumber(row.revenue) > 0 || asNumber(row.orders) > 0);
  if (!hasData) return <AdminEmptyState title={emptyTitle} description={emptyDescription} />;

  const maxRevenue = Math.max(...normalizedRows.map((row) => asNumber(row.revenue)), 1);
  return (
    <div className="huy-admin-ops-chart" style={{ gridTemplateColumns: `repeat(${normalizedRows.length}, minmax(30px, 1fr))` }}>
      {normalizedRows.map((row, index) => {
        const value = asNumber(row.revenue);
        const height = Math.max((value / maxRevenue) * 100, value ? 8 : 0);
        const label = period === 'month' ? formatMonth(row.monthStart || row.date) : formatShortDate(row.date || row.monthStart);
        return (
          <div className="huy-admin-ops-chart-item" key={`${row.date || row.monthStart}-${index}`}>
            <span
              className="huy-admin-ops-chart-bar admin-bar"
              title={`${label}: ${formatCurrency(value)} - ${formatNumber(row.orders)} đơn`}
              style={{ '--bar-height': `${height}%`, '--delay': `${index * 70}ms`, height: 'var(--bar-height)' }}
            />
            <small>{label}</small>
          </div>
        );
      })}
    </div>
  );
}

function PaymentMix({ methods }) {
  const data = asArray(methods);
  const byMethod = new Map(data.map((item) => [String(item.method || '').toUpperCase(), item]));
  const standardRows = ['COD', 'MOMO', 'ZALOPAY'].map((method) => byMethod.get(method) || { method, orders: 0, revenue: 0 });
  const extraRows = data.filter((item) => !['COD', 'MOMO', 'ZALOPAY'].includes(String(item.method || '').toUpperCase()));
  const rows = [...standardRows, ...extraRows];
  const totalOrders = rows.reduce((sum, item) => sum + asNumber(item.orders), 0);
  if (!totalOrders) {
    return <AdminEmptyState title="Chưa có dữ liệu thanh toán" description="Khi phát sinh đơn hàng, tỷ lệ COD/MoMo/ZaloPay sẽ hiển thị tại đây." />;
  }

  return (
    <div className="huy-admin-payment-mix">
      {rows.map((item) => {
        const percent = (asNumber(item.orders) / totalOrders) * 100;
        return (
          <div className="huy-admin-progress-row" key={item.method}>
            <div>
              <strong>{item.label || formatPaymentMethodLabel(item.method)}</strong>
              <span>{formatNumber(item.orders)} đơn · {formatCurrency(item.revenue)}</span>
            </div>
            <b>{formatPercent(percent)}</b>
            <i><span style={{ width: `${percent}%` }} /></i>
          </div>
        );
      })}
    </div>
  );
}

function RevenueTypeSplit({ fullBottleRevenue, decantRevenue }) {
  const rows = [
    { label: 'Full bottle', value: asNumber(fullBottleRevenue) },
    { label: 'Decant', value: asNumber(decantRevenue) },
  ];
  const total = rows.reduce((sum, item) => sum + item.value, 0);
  if (!total) {
    return <AdminEmptyState title="Chưa có doanh thu theo loại hàng" description="Doanh thu full bottle và decant sẽ được tách khi có order_items hợp lệ." />;
  }

  return (
    <div className="huy-admin-revenue-type">
      {rows.map((item) => {
        const percent = (item.value / total) * 100;
        return (
          <div className="huy-admin-progress-row" key={item.label}>
            <div>
              <strong>{item.label}</strong>
              <span>{formatCurrency(item.value)}</span>
            </div>
            <b>{formatPercent(percent)}</b>
            <i><span style={{ width: `${percent}%` }} /></i>
          </div>
        );
      })}
    </div>
  );
}

function TopProducts({ products }) {
  const rows = asArray(products).slice(0, 5);
  if (!rows.length) {
    return <AdminEmptyState title="Chưa có sản phẩm bán chạy" description="Top sản phẩm sẽ xuất hiện khi có order_items từ các đơn hợp lệ." />;
  }

  return (
    <div className="huy-admin-product-list">
      {rows.map((product, index) => (
        <article className="huy-admin-product admin-top-product" key={`${product.id}-${index}`} style={{ '--delay': `${index * 85}ms` }}>
          <img src={resolveProductImage(product.image)} alt={product.name} loading="lazy" onError={productFallbackImage} />
          <div>
            <strong>{product.name}</strong>
            <small>{formatNumber(product.soldQuantity ?? product.totalSold)} đã bán · {formatCurrency(product.revenue)}</small>
          </div>
          <b>{formatCurrency(product.discountPrice > 0 ? product.discountPrice : product.price)}</b>
        </article>
      ))}
    </div>
  );
}

function RankedList({ rows, valueLabel, emptyTitle, emptyDescription }) {
  const items = asArray(rows).slice(0, 5);
  if (!items.length) return <AdminEmptyState title={emptyTitle} description={emptyDescription} />;

  return (
    <div className="huy-admin-ranked-list">
      {items.map((item, index) => (
        <article className="huy-admin-ranked-row" key={`${item.id || item.name}-${index}`}>
          <span>{index + 1}</span>
          <div>
            <strong>{item.name}</strong>
            {item.email && <small>{item.email}</small>}
          </div>
          <b>{valueLabel(item)}</b>
        </article>
      ))}
    </div>
  );
}

function StockList({ items, emptyTitle, emptyDescription }) {
  const rows = asArray(items).slice(0, 5);
  if (!rows.length) return <AdminEmptyState title={emptyTitle} description={emptyDescription} />;

  return (
    <div className="huy-admin-stock-list">
      {rows.map((item, index) => (
        <article className="huy-admin-stock-row" key={`${item.id}-${item.variantId || 'product'}-${index}`}>
          <img src={resolveProductImage(item.image)} alt={item.name} loading="lazy" onError={productFallbackImage} />
          <div>
            <strong>{item.name}</strong>
            <small>{item.variantLabel || item.sku || 'Full bottle'}</small>
          </div>
          <b className={asNumber(item.stock) <= 0 ? 'danger' : ''}>{formatNumber(item.stock)}</b>
        </article>
      ))}
    </div>
  );
}

function RecentOrders({ orders }) {
  const rows = asArray(orders).slice(0, 5);
  if (!rows.length) {
    return <AdminEmptyState title="Chưa có đơn hàng gần đây" description="Đơn mới sẽ hiển thị tại đây sau khi khách checkout." />;
  }

  return (
    <div className="huy-admin-recent-list">
      {rows.map((order) => (
        <article className="huy-admin-recent-order" key={order.id}>
          <div>
            <strong>{order.orderCode || `#${order.id}`}</strong>
            <span>{order.userName || order.customerName || 'Khách vãng lai'}</span>
          </div>
          <AdminStatusBadge status={order.status} />
          <b>{formatCurrency(order.total ?? order.totalAmount)}</b>
          <time>{formatDateTime(order.createdAt)}</time>
        </article>
      ))}
    </div>
  );
}

function PendingReviews({ reviews }) {
  const rows = asArray(reviews).slice(0, 5);
  if (!rows.length) {
    return <AdminEmptyState title="Không có review chờ duyệt" description="Khi khách gửi đánh giá mới, danh sách duyệt nhanh sẽ hiển thị ở đây." />;
  }

  return (
    <div className="huy-admin-review-list">
      {rows.map((review) => (
        <article className="huy-admin-review-row" key={review.id}>
          <div>
            <strong>{review.productName || `Product #${review.productId}`}</strong>
            <small>{review.userName || 'Khách hàng'} · {formatNumber(review.rating)}/5 · {formatDateTime(review.createdAt)}</small>
          </div>
          <Link to="/admin/reviews">Duyệt</Link>
        </article>
      ))}
    </div>
  );
}

export function AdminDashboardPage() {
  const [dashboard, setDashboard] = useState(EMPTY_DASHBOARD);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [dashboardResult, revenueResult, topResult, lowStockResult] = await Promise.allSettled([
        api.get('/admin/dashboard'),
        api.get('/admin/dashboard/revenue', { params: { range: '30d' } }),
        api.get('/admin/dashboard/top-products', { params: { range: '30d', limit: 5 } }),
        api.get('/admin/dashboard/low-stock', { params: { limit: 5 } }),
      ]);

      if (dashboardResult.status === 'rejected') throw dashboardResult.reason;

      const baseData = unwrapApiData(dashboardResult.value.data) || {};
      const revenueData = revenueResult.status === 'fulfilled' ? unwrapApiData(revenueResult.value.data) : null;
      const topData = topResult.status === 'fulfilled' ? unwrapApiData(topResult.value.data) : null;
      const lowStockData = lowStockResult.status === 'fulfilled' ? unwrapApiData(lowStockResult.value.data) : null;
      setDashboard(mergeDashboardPayload(baseData, revenueData, topData, lowStockData));
    } catch (err) {
      setError(getErrorMessage(err, 'Không tải được dashboard admin.'));
      setDashboard(EMPTY_DASHBOARD);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const overviewMetrics = useMemo(() => [
    {
      label: 'Doanh thu hôm nay',
      value: formatCurrency(dashboard.revenueToday),
      delta: dashboard.trend?.revenueGrowth,
      hint: 'Đơn đã giao, hoàn tất hoặc online đã xác nhận',
      icon: 'VND',
      tone: 'gold',
      to: '/admin/reports',
    },
    {
      label: 'Doanh thu tháng này',
      value: formatCurrency(dashboard.revenueThisMonth),
      hint: 'Tính từ ngày đầu tháng hiện tại',
      icon: 'M',
      tone: 'gold',
      to: '/admin/reports',
    },
    {
      label: 'Tổng đơn hàng',
      value: formatNumber(dashboard.totalOrders),
      delta: dashboard.trend?.orderGrowth ?? dashboard.orderGrowth,
      hint: 'Không tính cart nháp',
      icon: '#',
      tone: 'sage',
      to: '/admin/orders',
    },
    {
      label: 'Đơn mới cần xử lý',
      value: formatNumber(dashboard.newOrdersToProcess),
      hint: 'Pending payment, pending, confirmed',
      icon: 'NEW',
      tone: 'blue',
      to: '/admin/orders',
    },
    {
      label: 'Đơn đang giao',
      value: formatNumber(dashboard.shippingOrders),
      hint: 'Đơn đã chuyển sang shipping',
      icon: 'SHIP',
      tone: 'blue',
      to: '/admin/orders',
    },
    {
      label: 'Đơn đã hoàn tất',
      value: formatNumber(dashboard.completedOrders),
      hint: 'Delivered hoặc completed',
      icon: 'OK',
      tone: 'sage',
      to: '/admin/orders',
    },
    {
      label: 'Đơn bị hủy',
      value: formatNumber(dashboard.cancelledOrders),
      hint: 'Cancelled hoặc payment failed',
      icon: 'X',
      tone: 'rose',
      to: '/admin/orders',
    },
    {
      label: 'Tỷ lệ hủy đơn',
      value: formatPercent(dashboard.cancelRate),
      hint: `${formatNumber(dashboard.cancelledOrders)} / ${formatNumber(dashboard.totalOrders)} đơn`,
      icon: '%',
      tone: asNumber(dashboard.cancelRate) > 10 ? 'rose' : 'sage',
      to: '/admin/reports',
    },
  ], [dashboard]);

  const productMetrics = useMemo(() => [
    {
      label: 'Doanh thu full bottle',
      value: formatCurrency(dashboard.fullBottleRevenue),
      hint: 'Từ order_items full bottle trong kỳ',
      icon: 'FULL',
      tone: 'gold',
      to: '/admin/reports',
    },
    {
      label: 'Doanh thu decant',
      value: formatCurrency(dashboard.decantRevenue),
      hint: 'Từ order_items decant trong kỳ',
      icon: 'ML',
      tone: 'blue',
      to: '/admin/decant',
    },
    {
      label: 'Sản phẩm sắp hết hàng',
      value: formatNumber(dashboard.lowStockProducts || dashboard.lowStockItems.length),
      hint: 'Theo ngưỡng tồn kho hệ thống',
      icon: 'LOW',
      tone: 'rose',
      to: '/admin/inventory',
    },
    {
      label: 'Sản phẩm hết hàng',
      value: formatNumber(dashboard.outOfStockProducts || dashboard.outOfStockItems.length),
      hint: 'Stock bằng 0 hoặc thấp hơn',
      icon: '0',
      tone: 'rose',
      to: '/admin/inventory',
    },
    {
      label: 'Khách hàng mới trong tháng',
      value: formatNumber(dashboard.newUsersThisMonth),
      delta: dashboard.trend?.customerGrowth,
      hint: `${formatNumber(dashboard.totalUsers)} khách hàng đang có tài khoản`,
      icon: 'USER',
      tone: 'sage',
      to: '/admin/users',
    },
    {
      label: 'Giá trị đơn TB',
      value: formatCurrency(dashboard.averageOrderValue),
      hint: 'Tính trên đơn có doanh thu hợp lệ',
      icon: 'AOV',
      tone: 'gold',
      to: '/admin/reports',
    },
  ], [dashboard]);

  if (loading) return <DashboardSkeleton />;

  return (
    <div className="huy-admin-dashboard">
      <section className="huy-admin-welcome admin-dashboard-hero admin-animate-in" style={{ '--delay': '0ms' }}>
        <div>
          <p className="huy-admin-eyebrow">Vận hành</p>
          <h1>Dashboard điều hành HuyPerfume</h1>
          <p>Theo dõi doanh thu, đơn hàng, tồn kho, sản phẩm bán chạy và review cần xử lý từ dữ liệu thật của hệ thống.</p>
        </div>
        <div className="huy-admin-welcome-controls">
          <button type="button" className="huy-admin-export" onClick={loadDashboard}>Làm mới</button>
          <Link to="/admin/reports" className="huy-admin-export">Báo cáo</Link>
        </div>
      </section>

      {error && (
        <div className="huy-admin-data-note">
          <strong>Không tải được dashboard.</strong>
          <span>{error}</span>
        </div>
      )}

      <section className="huy-admin-metrics" aria-label="Tổng quan kinh doanh">
        {overviewMetrics.map((metric, index) => <MetricCard metric={metric} index={index} key={metric.label} />)}
      </section>

      <div className="huy-admin-dashboard-grid">
        <section className="huy-admin-panel huy-admin-chart-large admin-dashboard-panel admin-animate-in" style={{ '--delay': '180ms' }}>
          <div className="huy-admin-panel-head">
            <div>
              <p className="huy-admin-eyebrow">Biểu đồ</p>
              <h2>Doanh thu 7 ngày gần nhất</h2>
            </div>
            <span className="huy-admin-change">7 ngày</span>
          </div>
          <BarSeriesChart
            rows={dashboard.charts.revenue7Days}
            emptyTitle="Chưa có doanh thu 7 ngày"
            emptyDescription="Khi có đơn hợp lệ, biểu đồ doanh thu ngày sẽ tự cập nhật."
          />
        </section>

        <section className="huy-admin-panel huy-admin-chart-medium admin-dashboard-panel admin-animate-in" style={{ '--delay': '220ms' }}>
          <div className="huy-admin-panel-head">
            <div>
              <p className="huy-admin-eyebrow">Thanh toán</p>
              <h2>Tỷ lệ phương thức thanh toán</h2>
            </div>
          </div>
          <PaymentMix methods={dashboard.charts.paymentMethods} />
        </section>

        <section className="huy-admin-panel huy-admin-chart-large admin-dashboard-panel admin-animate-in" style={{ '--delay': '260ms' }}>
          <div className="huy-admin-panel-head">
            <div>
              <p className="huy-admin-eyebrow">Doanh thu</p>
              <h2>Doanh thu theo tháng</h2>
            </div>
            <span className="huy-admin-change">12 tháng</span>
          </div>
          <BarSeriesChart
            rows={dashboard.charts.monthlyRevenue}
            period="month"
            emptyTitle="Chưa có doanh thu theo tháng"
            emptyDescription="Biểu đồ tháng sẽ hiển thị khi có doanh thu hợp lệ."
          />
        </section>

        <section className="huy-admin-panel huy-admin-chart-medium admin-dashboard-panel admin-animate-in" style={{ '--delay': '300ms' }}>
          <div className="huy-admin-panel-head">
            <div>
              <p className="huy-admin-eyebrow">Cơ cấu</p>
              <h2>Full bottle / decant</h2>
            </div>
          </div>
          <RevenueTypeSplit fullBottleRevenue={dashboard.fullBottleRevenue} decantRevenue={dashboard.decantRevenue} />
        </section>
      </div>

      <section className="huy-admin-metrics product" aria-label="Sản phẩm và khách hàng">
        {productMetrics.map((metric, index) => <MetricCard metric={metric} index={index} key={metric.label} />)}
      </section>

      <div className="huy-admin-dashboard-grid">
        <section className="huy-admin-panel huy-admin-products admin-dashboard-panel admin-animate-in" style={{ '--delay': '320ms' }}>
          <div className="huy-admin-panel-head compact">
            <div>
              <p className="huy-admin-eyebrow">Sản phẩm</p>
              <h2>Top sản phẩm bán chạy</h2>
            </div>
            <Link to="/admin/products">Sản phẩm</Link>
          </div>
          <TopProducts products={dashboard.topProducts} />
        </section>

        <section className="huy-admin-panel huy-admin-list-panel admin-dashboard-panel admin-animate-in" style={{ '--delay': '360ms' }}>
          <div className="huy-admin-panel-head compact">
            <div>
              <p className="huy-admin-eyebrow">Thương hiệu</p>
              <h2>Top thương hiệu bán chạy</h2>
            </div>
          </div>
          <RankedList
            rows={dashboard.topBrands}
            valueLabel={(item) => `${formatNumber(item.totalSold)} bán · ${formatCurrency(item.revenue)}`}
            emptyTitle="Chưa có thương hiệu bán chạy"
            emptyDescription="Dữ liệu thương hiệu sẽ có khi đơn hàng gắn với sản phẩm có brand."
          />
        </section>

        <section className="huy-admin-panel huy-admin-list-panel admin-dashboard-panel admin-animate-in" style={{ '--delay': '400ms' }}>
          <div className="huy-admin-panel-head compact">
            <div>
              <p className="huy-admin-eyebrow">Khách hàng</p>
              <h2>Khách hàng mua nhiều nhất</h2>
            </div>
            <Link to="/admin/users">Khách hàng</Link>
          </div>
          <RankedList
            rows={dashboard.topCustomers}
            valueLabel={(item) => `${formatNumber(item.orders)} đơn · ${formatCurrency(item.totalSpent)}`}
            emptyTitle="Chưa có khách hàng nổi bật"
            emptyDescription="Khách hàng mua nhiều nhất sẽ hiển thị theo doanh thu trong kỳ."
          />
        </section>

        <section className="huy-admin-panel huy-admin-recent-orders admin-dashboard-panel admin-animate-in" style={{ '--delay': '440ms' }}>
          <div className="huy-admin-panel-head compact">
            <div>
              <p className="huy-admin-eyebrow">Đơn hàng</p>
              <h2>5 đơn mới nhất</h2>
            </div>
            <Link to="/admin/orders">Quản lý đơn</Link>
          </div>
          <RecentOrders orders={dashboard.recentOrders} />
        </section>

        <section className="huy-admin-panel huy-admin-list-panel admin-dashboard-panel admin-animate-in" style={{ '--delay': '480ms' }}>
          <div className="huy-admin-panel-head compact">
            <div>
              <p className="huy-admin-eyebrow">Tồn kho</p>
              <h2>5 sản phẩm sắp hết hàng</h2>
            </div>
            <Link to="/admin/inventory">Tồn kho</Link>
          </div>
          <StockList
            items={dashboard.lowStockItems}
            emptyTitle="Không có sản phẩm sắp hết"
            emptyDescription="Kho đang không có sản phẩm nào dưới ngưỡng cảnh báo."
          />
        </section>

        <section className="huy-admin-panel huy-admin-list-panel admin-dashboard-panel admin-animate-in" style={{ '--delay': '520ms' }}>
          <div className="huy-admin-panel-head compact">
            <div>
              <p className="huy-admin-eyebrow">Hết hàng</p>
              <h2>5 sản phẩm hết hàng</h2>
            </div>
          </div>
          <StockList
            items={dashboard.outOfStockItems}
            emptyTitle="Không có sản phẩm hết hàng"
            emptyDescription="Chưa có sản phẩm hoặc biến thể nào có tồn kho bằng 0."
          />
        </section>

        <section className="huy-admin-panel huy-admin-list-panel admin-dashboard-panel admin-animate-in" style={{ '--delay': '560ms' }}>
          <div className="huy-admin-panel-head compact">
            <div>
              <p className="huy-admin-eyebrow">Review</p>
              <h2>5 review đang chờ duyệt</h2>
            </div>
            <Link to="/admin/reviews">Review</Link>
          </div>
          <PendingReviews reviews={dashboard.pendingReviews} />
        </section>
      </div>
    </div>
  );
}
