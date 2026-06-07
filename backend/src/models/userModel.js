import { query } from '../config/database.js';
import { getAuthStorageCapabilities, hasColumn } from '../modules/auth/auth.storage.js';
import { normalizeRole } from '../modules/auth/rbac.js';
import { getCheckoutStorageCapabilities } from '../modules/checkout/checkout.storage.js';
import { getProductStorageCapabilities } from '../modules/products/product.repository.js';
import { buildMembershipSummary } from '../utils/membershipTier.js';

function optionalSelect(columns, column, expression, alias, fallback = 'NULL') {
  return `${hasColumn(columns, column) ? expression : fallback} AS ${alias}`;
}

function coalesceColumns(columns, names, fallback = '0') {
  const available = names.filter((name) => hasColumn(columns, name));
  if (!available.length) return fallback;
  return `COALESCE(${available.join(', ')}, ${fallback})`;
}

function coalesceAliasedColumns(columns, alias, names, fallback = '0') {
  const available = names.filter((name) => hasColumn(columns, name));
  if (!available.length) return fallback;
  return `COALESCE(${available.map((name) => `${alias}.${name}`).join(', ')}, ${fallback})`;
}

const MEMBERSHIP_COMPLETED_STATUS_SQL = [
  "N'DELIVERED'",
  "N'COMPLETED'",
  "N'ĐÃ GIAO HÀNG'",
  "N'DA GIAO HANG'",
  "N'GIAO HÀNG THÀNH CÔNG'",
  "N'GIAO HANG THANH CONG'",
  "N'ĐÃ HOÀN TẤT'",
  "N'DA HOAN TAT'",
  "N'HOÀN TẤT'",
  "N'HOAN TAT'",
].join(', ');

const CANCELLED_STATUS_SQL = [
  "N'PAYMENT_REJECTED'",
  "N'PAYMENT_FAILED'",
  "N'CANCELLED_PAYMENT'",
  "N'CANCELLED'",
  "N'CANCELED'",
  "N'REFUNDED'",
  "N'ĐÃ HỦY'",
  "N'DA HUY'",
  "N'ĐÃ HOÀN TIỀN'",
  "N'DA HOAN TIEN'",
  "N'ĐANG HOÀN TIỀN'",
  "N'DANG HOAN TIEN'",
].join(', ');

function completedOrderStatusCondition(statusExpression) {
  return `UPPER(COALESCE(${statusExpression}, N'')) IN (${MEMBERSHIP_COMPLETED_STATUS_SQL})`;
}

function cancelledOrderStatusCondition(statusExpression) {
  return `UPPER(COALESCE(${statusExpression}, N'')) IN (${CANCELLED_STATUS_SQL})`;
}

function optionalProductSelect(columns, column, expression, alias, fallback = 'NULL') {
  return `${hasColumn(columns, column) ? expression : fallback} AS ${alias}`;
}

function productColumnSaleFallback(columns) {
  if (hasColumn(columns, 'discount_price')) return 'p.discount_price';
  return 'NULL';
}

function productThumbnailExpression(columns) {
  if (hasColumn(columns, 'thumbnail_url')) return 'p.thumbnail_url';
  if (hasColumn(columns, 'image_url')) return 'p.image_url';
  if (hasColumn(columns, 'image')) return 'p.image';
  return 'NULL';
}

async function userSelect({ includePassword = false } = {}) {
  const capabilities = await getAuthStorageCapabilities();
  const columns = capabilities.userColumns;
  const passwordSelect = includePassword ? 'password,' : '';

  return `
    SELECT TOP 1
      id,
      name,
      email,
      phone,
      ${passwordSelect}
      role,
      address,
      dob,
      ${optionalSelect(columns, 'status', 'status', 'status', "'ACTIVE'")},
      ${optionalSelect(columns, 'total_spent', 'total_spent', 'total_spent', '0')},
      ${optionalSelect(columns, 'membership_tier', 'membership_tier', 'membership_tier', "'NORMAL'")},
      ${optionalSelect(columns, 'membership_updated_at', 'membership_updated_at', 'membership_updated_at')},
      ${optionalSelect(columns, 'email_verified_at', 'email_verified_at', 'email_verified_at')},
      ${optionalSelect(columns, 'last_login_at', 'last_login_at', 'last_login_at')},
      ${optionalSelect(columns, 'password_changed_at', 'password_changed_at', 'password_changed_at')},
      ${optionalSelect(columns, 'failed_login_count', 'failed_login_count', 'failed_login_count', '0')},
      ${optionalSelect(columns, 'locked_until', 'locked_until', 'locked_until')},
      created_at
    FROM users
  `;
}

function activeUserWhere(columns) {
  return hasColumn(columns, 'deleted_at') ? ' AND deleted_at IS NULL' : '';
}

export function toSafeUser(row) {
  if (!row) return null;
  const membership = buildMembershipSummary(row.total_spent);
  return {
    id: row.id,
    name: row.name || '',
    email: row.email || '',
    phone: row.phone || '',
    role: normalizeRole(row.role),
    address: row.address || '',
    dob: row.dob || null,
    status: row.status || 'ACTIVE',
    totalSpent: membership.totalSpent,
    membershipTier: membership.membershipTier,
    membershipLabel: membership.membershipLabel,
    nextTier: membership.nextTier,
    nextTierLabel: membership.nextTierLabel,
    amountToNextTier: membership.amountToNextTier,
    membershipProgress: membership.membershipProgress,
    membershipUpdatedAt: row.membership_updated_at || null,
    emailVerifiedAt: row.email_verified_at || null,
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at || null,
  };
}

export async function findUserByEmailOrPhone(identifier) {
  const capabilities = await getAuthStorageCapabilities();
  const rows = await query(
    `${await userSelect({ includePassword: true })}
     WHERE (email = ? OR phone = ?)${activeUserWhere(capabilities.userColumns)}`,
    [identifier, identifier]
  );
  return rows[0] || null;
}

export async function findUserById(id, { includePassword = false } = {}) {
  const capabilities = await getAuthStorageCapabilities();
  const rows = await query(
    `${await userSelect({ includePassword })}
     WHERE id = ?${activeUserWhere(capabilities.userColumns)}`,
    [id]
  );
  return rows[0] || null;
}

export async function findUserByEmail(email) {
  const capabilities = await getAuthStorageCapabilities();
  const rows = await query(
    `SELECT TOP 1 id
     FROM users
     WHERE email = ?${activeUserWhere(capabilities.userColumns)}`,
    [email]
  );
  return rows[0] || null;
}

export async function findFullUserByEmail(email) {
  const capabilities = await getAuthStorageCapabilities();
  const rows = await query(
    `${await userSelect({ includePassword: false })}
     WHERE email = ?${activeUserWhere(capabilities.userColumns)}`,
    [email]
  );
  return rows[0] || null;
}

export async function findUserByPhone(phone) {
  const capabilities = await getAuthStorageCapabilities();
  const rows = await query(
    `SELECT TOP 1 id
     FROM users
     WHERE phone = ?${activeUserWhere(capabilities.userColumns)}`,
    [phone]
  );
  return rows[0] || null;
}

export async function createUser({ name, email, phone, password, address, role = 'USER' }) {
  const capabilities = await getAuthStorageCapabilities();
  const columns = ['name', 'email', 'phone', 'password', 'role', 'address'];
  const values = ['?', '?', '?', '?', '?', '?'];
  const params = [name, email, phone, password, normalizeRole(role), address || ''];

  if (hasColumn(capabilities.userColumns, 'status')) {
    columns.push('status');
    values.push('?');
    params.push('PENDING_VERIFICATION');
  }
  if (hasColumn(capabilities.userColumns, 'password_changed_at')) {
    columns.push('password_changed_at');
    values.push('SYSUTCDATETIME()');
  }

  await query(
    `INSERT INTO users (${columns.join(', ')})
     VALUES (${values.join(', ')})`,
    params
  );
  const rows = await query('SELECT TOP 1 id FROM users WHERE email = ?', [email]);
  return rows[0] || null;
}

export async function updateUserProfile(id, { name, phone, address, dob }) {
  const capabilities = await getAuthStorageCapabilities();
  const updatedAt = hasColumn(capabilities.userColumns, 'updated_at') ? ', updated_at = SYSUTCDATETIME()' : '';
  await query(
    `UPDATE users
     SET name = ?, phone = ?, address = ?, dob = ?${updatedAt}
     WHERE id = ?`,
    [name, phone, address, dob || null, id]
  );
}

export async function updateUserPasswordByEmail(email, password) {
  const capabilities = await getAuthStorageCapabilities();
  const passwordChanged = hasColumn(capabilities.userColumns, 'password_changed_at')
    ? ', password_changed_at = SYSUTCDATETIME()'
    : '';
  const updatedAt = hasColumn(capabilities.userColumns, 'updated_at') ? ', updated_at = SYSUTCDATETIME()' : '';
  await query(
    `UPDATE users
     SET password = ?${passwordChanged}${updatedAt}
     WHERE email = ?`,
    [password, email]
  );
}

export async function updateUserPasswordById(id, password) {
  const capabilities = await getAuthStorageCapabilities();
  const passwordChanged = hasColumn(capabilities.userColumns, 'password_changed_at')
    ? ', password_changed_at = SYSUTCDATETIME()'
    : '';
  const updatedAt = hasColumn(capabilities.userColumns, 'updated_at') ? ', updated_at = SYSUTCDATETIME()' : '';
  await query(
    `UPDATE users
     SET password = ?${passwordChanged}${updatedAt}
     WHERE id = ?`,
    [password, id]
  );
}

export async function updateSuccessfulLogin(id) {
  const capabilities = await getAuthStorageCapabilities();
  const assignments = [];
  if (hasColumn(capabilities.userColumns, 'last_login_at')) assignments.push('last_login_at = SYSUTCDATETIME()');
  if (hasColumn(capabilities.userColumns, 'failed_login_count')) assignments.push('failed_login_count = 0');
  if (hasColumn(capabilities.userColumns, 'locked_until')) assignments.push('locked_until = NULL');
  if (hasColumn(capabilities.userColumns, 'updated_at')) assignments.push('updated_at = SYSUTCDATETIME()');
  if (!assignments.length) return;
  await query(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, [id]);
}

export async function lockUserUntil(id, lockedUntil) {
  const capabilities = await getAuthStorageCapabilities();
  if (!hasColumn(capabilities.userColumns, 'locked_until')) return;
  await query(
    `UPDATE users
     SET locked_until = ?, failed_login_count = CASE WHEN failed_login_count IS NULL THEN 1 ELSE failed_login_count + 1 END
     WHERE id = ?`,
    [lockedUntil, id]
  );
}

export async function incrementFailedLogin(id) {
  const capabilities = await getAuthStorageCapabilities();
  if (!hasColumn(capabilities.userColumns, 'failed_login_count')) return;
  await query(
    `UPDATE users
     SET failed_login_count = failed_login_count + 1
     WHERE id = ?`,
    [id]
  );
}

export async function markEmailVerified(userId) {
  const capabilities = await getAuthStorageCapabilities();
  const assignments = [];
  if (hasColumn(capabilities.userColumns, 'email_verified_at')) assignments.push('email_verified_at = SYSUTCDATETIME()');
  if (hasColumn(capabilities.userColumns, 'status')) assignments.push("status = 'ACTIVE'");
  if (hasColumn(capabilities.userColumns, 'updated_at')) assignments.push('updated_at = SYSUTCDATETIME()');
  if (!assignments.length) return;
  await query(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, [userId]);
}

export async function recalculateUserMembership(userId) {
  const safeUserId = Number(userId);
  if (!safeUserId) return buildMembershipSummary(0);

  const [authCapabilities, checkoutCapabilities] = await Promise.all([
    getAuthStorageCapabilities(),
    getCheckoutStorageCapabilities(),
  ]);
  const orderColumns = checkoutCapabilities.orderColumns;
  const orderTotalExpr = coalesceColumns(orderColumns, ['total_amount', 'total', 'grand_total'], '0');
  const orderStatusExpr = hasColumn(orderColumns, 'status') ? 'status' : "''";
  const rows = await query(
    `SELECT COALESCE(SUM(
       CASE WHEN ${completedOrderStatusCondition(orderStatusExpr)}
            THEN ${orderTotalExpr}
            ELSE 0
       END
     ), 0) AS totalSpent
     FROM orders
     WHERE user_id = ?`,
    [safeUserId]
  );
  const membership = buildMembershipSummary(rows[0]?.totalSpent || 0);

  const assignments = [];
  const params = [];
  if (hasColumn(authCapabilities.userColumns, 'total_spent')) {
    assignments.push('total_spent = ?');
    params.push(membership.totalSpent);
  }
  if (hasColumn(authCapabilities.userColumns, 'membership_tier')) {
    assignments.push('membership_tier = ?');
    params.push(membership.membershipTier);
  }
  if (assignments.length && hasColumn(authCapabilities.userColumns, 'membership_updated_at')) {
    assignments.push('membership_updated_at = SYSUTCDATETIME()');
  }
  if (assignments.length && hasColumn(authCapabilities.userColumns, 'updated_at')) {
    assignments.push('updated_at = SYSUTCDATETIME()');
  }
  if (assignments.length) {
    await query(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, [...params, safeUserId]);
  }

  return membership;
}

export async function listUsers() {
  return query(
    `SELECT id, name, email, phone, role, address, dob, created_at
     FROM users
     ORDER BY id DESC`
  );
}

// --- Admin user management ---

export async function getUserById(userId) {
  const capabilities = await getAuthStorageCapabilities();
  const columns = capabilities.userColumns;
  const hasStatus = hasColumn(columns, 'status');
  const hasNote = hasColumn(columns, 'note');
  const rows = await query(
    `SELECT id, name, email, phone, role, address, dob,
            ${optionalSelect(columns, 'status', 'status', 'status', "'ACTIVE'")},
            ${optionalSelect(columns, 'note', 'note', 'note')},
            ${optionalSelect(columns, 'email_verified_at', 'email_verified_at', 'email_verified_at')},
            ${optionalSelect(columns, 'last_login_at', 'last_login_at', 'last_login_at')},
            created_at,
            ${optionalSelect(columns, 'updated_at', 'updated_at', 'updated_at')}
     FROM users
     WHERE id = ?`,
    [userId]
  );
  const user = rows[0];
  if (!user) return null;
  await recalculateUserMembership(userId);

  const [checkoutCapabilities, productCapabilities] = await Promise.all([
    getCheckoutStorageCapabilities(),
    getProductStorageCapabilities(),
  ]);
  const orderColumns = checkoutCapabilities.orderColumns;
  const productColumns = productCapabilities.productColumns;
  const orderTotalExpr = coalesceColumns(orderColumns, ['total_amount', 'total', 'grand_total'], '0');
  const orderStatusExpr = hasColumn(orderColumns, 'status') ? 'status' : "''";
  const orderCreatedExpr = hasColumn(orderColumns, 'created_at') ? 'created_at' : 'NULL';
  const wishlistQuery = productCapabilities.hasWishlist
    ? query(
      `SELECT TOP 20 w.product_id, w.created_at,
              ${optionalProductSelect(productColumns, 'name', 'p.name', 'product_name', "''")},
              ${optionalProductSelect(productColumns, 'slug', 'p.slug', 'slug')},
              ${optionalProductSelect(productColumns, 'price', 'p.price', 'price', '0')},
              ${hasColumn(productColumns, 'sale_price') ? 'p.sale_price' : productColumnSaleFallback(productColumns)} AS sale_price,
              ${productThumbnailExpression(productColumns)} AS thumbnail_url
       FROM wishlist w
       LEFT JOIN products p ON p.id = w.product_id
       WHERE w.user_id = ?
       ORDER BY w.created_at DESC, w.id DESC`,
      [userId]
    )
    : Promise.resolve([]);

  const [orderStats, recentOrders, wishlist] = await Promise.all([
    query(
      `SELECT
         COUNT(*) AS totalOrders,
         SUM(CASE WHEN ${cancelledOrderStatusCondition(orderStatusExpr)} THEN 1 ELSE 0 END) AS cancelledOrders,
         SUM(CASE WHEN ${completedOrderStatusCondition(orderStatusExpr)} THEN 1 ELSE 0 END) AS completedOrders,
         SUM(CASE WHEN ${completedOrderStatusCondition(orderStatusExpr)} THEN ${orderTotalExpr} ELSE 0 END) AS totalSpent,
         MAX(${orderCreatedExpr}) AS lastOrderAt
       FROM orders
       WHERE user_id = ?`,
      [userId]
    ),
    query(
      `SELECT TOP 5 id,
              ${optionalSelect(orderColumns, 'code', 'code', 'code')},
              ${orderStatusExpr} AS status,
              ${orderTotalExpr} AS total,
              ${orderCreatedExpr} AS created_at
       FROM orders
       WHERE user_id = ?
       ORDER BY ${orderCreatedExpr === 'NULL' ? 'id' : 'created_at'} DESC, id DESC`,
      [userId]
    ),
    wishlistQuery,
  ]);

  const stats = orderStats[0] || {};
  const membership = buildMembershipSummary(stats.totalSpent || 0);
  return {
    user: {
      ...toSafeUser(user),
      totalSpent: membership.totalSpent,
      membershipTier: membership.membershipTier,
      membershipLabel: membership.membershipLabel,
      nextTier: membership.nextTier,
      nextTierLabel: membership.nextTierLabel,
      amountToNextTier: membership.amountToNextTier,
      membershipProgress: membership.membershipProgress,
      status: hasStatus ? (user.status || 'ACTIVE') : 'ACTIVE',
      note: hasNote ? (user.note || null) : null,
      emailVerifiedAt: user.email_verified_at || null,
      lastLoginAt: user.last_login_at || null,
      updatedAt: user.updated_at || null,
    },
    stats: {
      totalOrders: Number(stats.totalOrders || 0),
      completedOrders: Number(stats.completedOrders || 0),
      totalSpent: membership.totalSpent,
      lastOrderAt: stats.lastOrderAt || null,
      cancelledOrders: Number(stats.cancelledOrders || 0),
    },
    membership,
    recentOrders: recentOrders.map((order) => ({
      ...order,
      total: Number(order.total_amount ?? order.total ?? order.grand_total ?? 0),
    })),
    wishlist: wishlist.map((item) => ({
      productId: item.product_id,
      productName: item.product_name || '',
      slug: item.slug || null,
      price: Number(item.price ?? 0),
      salePrice: item.sale_price ?? null,
      thumbnailUrl: item.thumbnail_url || item.image_url || null,
      createdAt: item.created_at || null,
    })),
  };
}

export async function listUsersEnhanced({ page = 1, pageSize = 20, search = null, role = null, status = null, membershipTier = null } = {}) {
  const capabilities = await getAuthStorageCapabilities();
  const checkoutCapabilities = await getCheckoutStorageCapabilities();
  const columns = capabilities.userColumns;
  const orderColumns = checkoutCapabilities.orderColumns;
  const hasStatus = hasColumn(columns, 'status');
  const safePage = Math.max(1, Number(page));
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize)));
  const offset = (safePage - 1) * safePageSize;
  const orderTotalExpr = coalesceAliasedColumns(orderColumns, 'o', ['total_amount', 'total', 'grand_total'], '0');
  const orderStatusExpr = hasColumn(orderColumns, 'status') ? 'o.status' : "''";
  const orderSummarySql = `
    SELECT o.user_id,
           COUNT(*) AS totalOrders,
           SUM(CASE WHEN ${completedOrderStatusCondition(orderStatusExpr)} THEN 1 ELSE 0 END) AS completedOrders,
           SUM(CASE WHEN ${completedOrderStatusCondition(orderStatusExpr)} THEN ${orderTotalExpr} ELSE 0 END) AS totalSpent
    FROM orders o
    GROUP BY o.user_id
  `;
  const spentExpr = 'ISNULL(os.totalSpent, 0)';
  const membershipCaseExpr = `CASE
    WHEN ${spentExpr} >= 10000000 THEN 'DIAMOND'
    WHEN ${spentExpr} >= 5000000 THEN 'GOLD'
    WHEN ${spentExpr} >= 3500000 THEN 'SILVER'
    WHEN ${spentExpr} >= 2500000 THEN 'BRONZE'
    ELSE 'NORMAL'
  END`;

  const conditions = [];
  const params = [];

  if (search) {
    conditions.push('(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)');
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }
  if (role) {
    conditions.push('UPPER(u.role) = ?');
    params.push(String(role).toUpperCase());
  }
  if (status) {
    if (hasStatus) {
      conditions.push('UPPER(u.status) = ?');
      params.push(String(status).toUpperCase());
    } else if (String(status).toUpperCase() !== 'ACTIVE') {
      conditions.push('1 = 0');
    }
  }
  if (membershipTier) {
    const normalizedMembershipTier = String(membershipTier).trim().toUpperCase();
    if (['NORMAL', 'BRONZE', 'SILVER', 'GOLD', 'DIAMOND'].includes(normalizedMembershipTier)) {
      conditions.push(`${membershipCaseExpr} = ?`);
      params.push(normalizedMembershipTier);
    }
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const totalRows = await query(
    `SELECT COUNT(*) AS total
     FROM users u
     LEFT JOIN (${orderSummarySql}) os ON os.user_id = u.id
     ${whereSql}`,
    params
  );
  const total = Number(totalRows[0]?.total || 0);
  const statusExpr = hasStatus ? 'u.status' : "'ACTIVE'";
  const summaryStatusExpr = hasStatus ? 'status' : "'ACTIVE'";
  const summaryRows = await query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN UPPER(role) = 'ADMIN' THEN 1 ELSE 0 END) AS admins,
            SUM(CASE WHEN UPPER(role) = 'USER' THEN 1 ELSE 0 END) AS customers,
            SUM(CASE WHEN UPPER(${summaryStatusExpr}) = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN UPPER(${summaryStatusExpr}) = 'LOCKED' THEN 1 ELSE 0 END) AS locked,
            SUM(CASE WHEN UPPER(${summaryStatusExpr}) = 'DISABLED' THEN 1 ELSE 0 END) AS disabled
     FROM users`
  );
  const summary = summaryRows[0] || {};

  const rows = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.address, u.dob,
            ${statusExpr} AS status, u.created_at,
            ${optionalSelect(columns, 'last_login_at', 'u.last_login_at', 'last_login_at')},
            ISNULL(os.totalOrders, 0) AS totalOrders,
            ISNULL(os.completedOrders, 0) AS completedOrders,
            ISNULL(os.totalSpent, 0) AS totalSpent
     FROM users u
     LEFT JOIN (${orderSummarySql}) os ON os.user_id = u.id
     ${whereSql}
     ORDER BY u.id DESC
     OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
    [...params, offset, safePageSize]
  );

  return {
    content: rows.map((row) => {
      const membership = buildMembershipSummary(row.totalSpent || 0);
      return {
        id: row.id,
        name: row.name || '',
        email: row.email || '',
        phone: row.phone || '',
        role: normalizeRole(row.role),
        address: row.address || '',
        dob: row.dob || null,
        status: row.status || 'ACTIVE',
        created_at: row.created_at || null,
        lastLoginAt: row.last_login_at || null,
        totalOrders: Number(row.totalOrders || 0),
        completedOrders: Number(row.completedOrders || 0),
        ...membership,
      };
    }),
    page: safePage,
    size: safePageSize,
    totalElements: total,
    totalPages: Math.max(1, Math.ceil(total / safePageSize)),
    first: safePage === 1,
    last: safePage * safePageSize >= total,
    summary: {
      total: Number(summary.total || 0),
      admins: Number(summary.admins || 0),
      customers: Number(summary.customers || 0),
      active: Number(summary.active || 0),
      locked: Number(summary.locked || 0),
      disabled: Number(summary.disabled || 0),
    },
    features: { canManageStatus: hasStatus },
  };
}

export async function updateUserByAdmin(userId, data) {
  const capabilities = await getAuthStorageCapabilities();
  const existing = await getUserById(userId);
  if (!existing) return null;
  const setClauses = [];
  const params = [];
  const fields = { name: 'name', email: 'email', phone: 'phone', role: 'role', status: 'status', note: 'note', address: 'address', dob: 'dob' };

  for (const [key, col] of Object.entries(fields)) {
    if (data[key] === undefined) continue;
    if (key === 'status' && !hasColumn(capabilities.userColumns, 'status')) continue;
    if (key === 'note' && !hasColumn(capabilities.userColumns, 'note')) continue;
    setClauses.push(`${col} = ?`);
    params.push(key === 'role' ? normalizeRole(data[key]) : data[key]);
  }
  if (!setClauses.length) return { id: userId, updated: false };
  if (hasColumn(capabilities.userColumns, 'updated_at')) setClauses.push('updated_at = GETDATE()');
  params.push(userId);
  await query(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`, params);
  return { id: userId, updated: true };
}

export async function softDeleteUser(userId) {
  const capabilities = await getAuthStorageCapabilities();
  const existing = await getUserById(userId);
  if (!existing) return null;
  if (!hasColumn(capabilities.userColumns, 'status')) return { code: 501, message: 'Cần chạy migration auth để quản lý trạng thái tài khoản' };
  const assignments = ["status = 'LOCKED'"];
  if (hasColumn(capabilities.userColumns, 'updated_at')) assignments.push('updated_at = GETDATE()');
  await query(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, [userId]);
  return { id: userId, locked: true };
}
