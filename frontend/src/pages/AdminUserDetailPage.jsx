import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../services/api';
import {
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminCurrency,
  formatAdminDate,
} from '../components/Admin/AdminUi';
import { clampMembershipProgress, formatVnd, getMembershipLabel, getMembershipShortLabel, getMembershipTone, normalizeMembershipTier } from '../utils/membership';

function unwrapApiData(payload) {
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload;
}

function MembershipBadge({ tier }) {
  return (
    <span className={`admin-membership-badge ${getMembershipTone(tier)}`}>
      {getMembershipShortLabel(tier)}
    </span>
  );
}

export function AdminUserDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    api.get(`/admin/users/${id}`)
      .then((res) => setData(unwrapApiData(res.data)))
      .catch((err) => setError(err?.message || 'Không tải được thông tin khách hàng.'))
      .finally(() => setLoading(false));
  }, [id]);

  const user = data?.user || {};
  const stats = data?.stats || {};
  const membership = data?.membership || user;
  const membershipTier = normalizeMembershipTier(membership.membershipTier);
  const membershipLabel = membership.membershipLabel || getMembershipLabel(membershipTier);
  const nextTierLabel = membership.nextTierLabel || (membership.nextTier ? getMembershipLabel(membership.nextTier) : null);
  const membershipProgress = clampMembershipProgress(membership.membershipProgress);
  const isTopTier = membershipTier === 'DIAMOND';

  return (
    <div className="admin-page">
      <AdminPageHeader
        eyebrow="Chi tiết khách hàng"
        title={user.name || user.email || 'Khách hàng'}
        description="Tổng quan tài khoản, đơn hàng gần đây, wishlist và ghi chú nội bộ."
        action={<Link to="/admin/users" className="btn btn-outline-dark">Quay lại danh sách</Link>}
      />

      {loading ? (
        <div className="admin-loading"><div className="spinner-border" /> Đang tải chi tiết...</div>
      ) : error ? (
        <div className="alert alert-danger admin-alert">{error}</div>
      ) : data ? (
        <div className="admin-detail-grid">
          <section className="admin-surface-card">
            <h3>Thông tin khách hàng</h3>
            <div className="admin-detail-meta">
              <p><strong>Tên</strong><span>{user.name || '-'}</span></p>
              <p><strong>Email</strong><span>{user.email || '-'}</span></p>
              <p><strong>Điện thoại</strong><span>{user.phone || '-'}</span></p>
              <p><strong>Vai trò</strong><span className="admin-role-badge">{user.role}</span></p>
              <p><strong>Trạng thái</strong><span><AdminStatusBadge status={user.status} /></span></p>
              <p><strong>Đăng nhập cuối</strong><span>{formatAdminDate(user.lastLoginAt)}</span></p>
              <p><strong>Ngày tạo</strong><span>{formatAdminDate(user.createdAt || user.created_at)}</span></p>
            </div>
            <div className="admin-note-box">
              <h4>Ghi chú nội bộ</h4>
              <p>{user.note || 'Chưa có ghi chú.'}</p>
            </div>
          </section>

          <section className={`admin-surface-card admin-membership-card ${getMembershipTone(membershipTier)}`}>
            <div className="admin-membership-head">
              <div>
                <h3>Hạng thành viên</h3>
                <p>Tự động tính từ đơn hàng đã giao thành công hoặc hoàn tất.</p>
              </div>
              <MembershipBadge tier={membershipTier} />
            </div>

            <div className="admin-membership-summary">
              <article>
                <span>Tổng chi tiêu</span>
                <strong>{formatVnd(membership.totalSpent ?? stats.totalSpent)}</strong>
              </article>
              <article>
                <span>Hạng hiện tại</span>
                <strong>{membershipLabel}</strong>
              </article>
              <article>
                <span>Hạng tiếp theo</span>
                <strong>{isTopTier ? 'Cao nhất' : nextTierLabel || '-'}</strong>
              </article>
              <article>
                <span>Còn thiếu</span>
                <strong>{isTopTier ? formatVnd(0) : formatVnd(membership.amountToNextTier)}</strong>
              </article>
            </div>

            {isTopTier ? (
              <p className="admin-membership-top">Đã đạt hạng cao nhất</p>
            ) : (
              <p className="admin-membership-next">Còn {formatVnd(membership.amountToNextTier)} để lên {nextTierLabel || 'hạng tiếp theo'}</p>
            )}
            <div className="admin-membership-progress" aria-label="Tiến độ lên hạng">
              <span style={{ width: `${membershipProgress}%` }} />
            </div>
          </section>

          <section className="admin-surface-card">
            <h3>Thống kê</h3>
            <div className="admin-kpi-grid compact">
              <article className="admin-kpi-card"><span>Tổng đơn</span><strong>{Number(stats.totalOrders || 0).toLocaleString('vi-VN')}</strong></article>
              <article className="admin-kpi-card"><span>Đơn hoàn tất</span><strong>{Number(stats.completedOrders || 0).toLocaleString('vi-VN')}</strong></article>
              <article className="admin-kpi-card"><span>Tổng chi tiêu</span><strong>{formatVnd(stats.totalSpent || 0)}</strong></article>
              <article className="admin-kpi-card"><span>Đơn hủy</span><strong>{Number(stats.cancelledOrders || 0).toLocaleString('vi-VN')}</strong></article>
              <article className="admin-kpi-card"><span>Đơn gần nhất</span><strong>{formatAdminDate(stats.lastOrderAt)}</strong></article>
            </div>
          </section>

          <section className="admin-surface-card">
            <h3>Đơn hàng gần đây</h3>
            <div className="admin-list-stack">
              {(data.recentOrders || []).map((order) => (
                <article key={order.id} className="admin-list-item">
                  <div>
                    <strong>{order.orderCode || order.order_code || order.code || `#${order.id}`}</strong>
                    <small>{formatAdminDate(order.created_at)}</small>
                  </div>
                  <div>
                    <strong>{formatAdminCurrency(order.total)}</strong>
                    <small>{order.status}</small>
                  </div>
                </article>
              ))}
              {!data.recentOrders?.length && <p>Chưa có đơn hàng.</p>}
            </div>
          </section>

          <section className="admin-surface-card">
            <h3>Wishlist</h3>
            <div className="admin-list-stack">
              {(data.wishlist || []).map((item) => (
                <article key={`${item.productId}-${item.createdAt}`} className="admin-list-item">
                  <div>
                    <strong>{item.productName || 'Sản phẩm'}</strong>
                    <small>{item.slug || `#${item.productId}`}</small>
                  </div>
                  <div><strong>{formatAdminCurrency(item.price)}</strong></div>
                </article>
              ))}
              {!data.wishlist?.length && <p>Chưa có sản phẩm trong wishlist.</p>}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
