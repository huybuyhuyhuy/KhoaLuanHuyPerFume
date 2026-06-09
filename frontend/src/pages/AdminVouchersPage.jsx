import { useEffect, useMemo, useState } from 'react';
import { AdminPageHeader } from '../components/Admin/AdminUi';
import api, { unwrapApiData } from '../services/api';

function getCurrentLocalDateTime() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function getDefaultEndDateTime() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  date.setHours(23, 59, 0, 0);

  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function toDateTime(value) {
  if (!value) return null;

  const text = String(value).trim();
  const localSqlDateTime = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/
  );
  const date = localSqlDateTime
    ? new Date(
      Number(localSqlDateTime[1]),
      Number(localSqlDateTime[2]) - 1,
      Number(localSqlDateTime[3]),
      Number(localSqlDateTime[4]),
      Number(localSqlDateTime[5]),
      Number(localSqlDateTime[6] || 0),
    )
    : new Date(value);
  const time = date.getTime();

  return Number.isNaN(time) ? null : time;
}

function formatDateTimeLocal(value) {
  if (!value) return '';

  const time = toDateTime(value);
  if (time === null) return '';

  const date = new Date(time);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function getEmptyForm() {
  return {
    id: null,
    code: '',
    name: '',
    discountType: 'PERCENT',
    discountValue: '',
    minOrderValue: '',
    maxDiscountValue: '',
    usageLimit: '',
    startAt: getCurrentLocalDateTime(),
    endAt: getDefaultEndDateTime(),
    status: true,
  };
}

function StatusBadge({ voucher }) {
  const now = Date.now();
  const start = toDateTime(voucher.startAt);
  const end = toDateTime(voucher.endAt);

  if (!voucher.status) {
    return <span className="admin-status-badge neutral">Tắt</span>;
  }

  if (start && now < start) {
    return <span className="admin-status-badge neutral">Chưa bắt đầu</span>;
  }

  if (end && now > end) {
    return <span className="admin-status-badge progress">Hết hạn</span>;
  }

  if (
    voucher.usageLimit !== null &&
    voucher.usageLimit !== undefined &&
    Number(voucher.usedCount || 0) >= Number(voucher.usageLimit)
  ) {
    return <span className="admin-status-badge progress">Hết lượt</span>;
  }

  return <span className="admin-status-badge positive">Còn hạn</span>;
}

function parseLocalizedNumber(value) {
  if (value === '' || value === null || value === undefined) return value;
  if (typeof value === 'number') return value;

  const raw = String(value).trim();
  if (!raw) return raw;

  const normalized = raw
    .replace(/\s+/g, '')
    .replace(/[^\d,.-]/g, '');

  if (!normalized || normalized === '-' || normalized === '.' || normalized === ',') return Number.NaN;

  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');

  if (hasComma && hasDot) {
    const lastComma = normalized.lastIndexOf(',');
    const lastDot = normalized.lastIndexOf('.');
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    return Number(normalized.split(thousandsSeparator).join('').replace(decimalSeparator, '.'));
  }

  if (hasDot) {
    const parts = normalized.split('.');
    const usesDotThousands = parts.length > 1 && parts.slice(1).every((part) => part.length === 3);
    return Number(usesDotThousands ? parts.join('') : normalized);
  }

  if (hasComma) {
    const parts = normalized.split(',');
    const usesCommaThousands = parts.length > 1 && parts.slice(1).every((part) => part.length === 3);
    return Number(usesCommaThousands ? parts.join('') : normalized.replace(',', '.'));
  }

  return Number(normalized);
}

function parseOptionalNumber(value) {
  return String(value ?? '').trim() === '' ? null : parseLocalizedNumber(value);
}

function formatDiscount(item) {
  if (item.discountType === 'PERCENT') {
    return `${Number(item.discountValue || 0).toLocaleString('vi-VN')}%`;
  }

  return `${Number(item.discountValue || 0).toLocaleString('vi-VN')}đ`;
}

export function AdminVouchersPage() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(getEmptyForm);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [query, setQuery] = useState('');

  const load = async () => {
    setLoading(true);

    try {
      const res = await api.get('/admin/vouchers');
      const data = unwrapApiData(res.data) || {};
      setItems(Array.isArray(data.content) ? data.content : []);
    } catch (err) {
      setError(err?.message || 'Không tải được danh sách voucher.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(
    () => items.filter((v) => `${v.code} ${v.name}`.toLowerCase().includes(query.toLowerCase())),
    [items, query],
  );

  const isEditing = Boolean(form.id);

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const resetForm = () => {
    setForm(getEmptyForm());
    setFieldErrors({});
    setError('');
    setMessage('');
  };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    const payload = {
      ...form,
      code: String(form.code).trim().toUpperCase(),
      name: String(form.name).trim(),
      discountValue: form.discountValue === '' ? '' : parseLocalizedNumber(form.discountValue),
      minOrderValue: parseOptionalNumber(form.minOrderValue),
      maxDiscountValue: parseOptionalNumber(form.maxDiscountValue),
      usageLimit: parseOptionalNumber(form.usageLimit),
      startAt: form.startAt ? `${form.startAt}:00` : null,
      endAt: form.endAt ? `${form.endAt}:00` : null,
      status: Boolean(form.status),
    };

    const clientErrors = {};

    const startTime = toDateTime(payload.startAt);
    const endTime = toDateTime(payload.endAt);

    if (payload.startAt && startTime === null) {
      clientErrors.startAt = ['Ngày bắt đầu không hợp lệ.'];
    }

    if (payload.endAt && endTime === null) {
      clientErrors.endAt = ['Ngày hết hạn không hợp lệ.'];
    }

    if (startTime && endTime && endTime <= startTime) {
      clientErrors.endAt = ['Ngày hết hạn phải sau ngày bắt đầu.'];
    }

    if (!payload.code) {
      clientErrors.code = ['Vui lòng nhập CODE.'];
    }

    if (!payload.name) {
      clientErrors.name = ['Vui lòng nhập tên voucher.'];
    }

    if (
      payload.discountValue === '' ||
      !Number.isFinite(payload.discountValue) ||
      payload.discountValue <= 0
    ) {
      clientErrors.discountValue = ['Giá trị giảm phải lớn hơn 0.'];
    }

    if (payload.discountType === 'PERCENT' && Number(payload.discountValue) > 100) {
      clientErrors.discountValue = ['Voucher phần trăm phải từ 1 đến 100.'];
    }

    if (
      payload.minOrderValue !== null &&
      (!Number.isFinite(payload.minOrderValue) || payload.minOrderValue < 0)
    ) {
      clientErrors.minOrderValue = ['Đơn tối thiểu không hợp lệ.'];
    }

    if (
      payload.maxDiscountValue !== null &&
      (!Number.isFinite(payload.maxDiscountValue) || payload.maxDiscountValue < 0)
    ) {
      clientErrors.maxDiscountValue = ['Giảm tối đa không hợp lệ.'];
    }

    if (
      payload.usageLimit !== null &&
      (!Number.isInteger(payload.usageLimit) || payload.usageLimit <= 0)
    ) {
      clientErrors.usageLimit = ['Số lượt dùng không hợp lệ.'];
    }

    if (Object.keys(clientErrors).length) {
      setFieldErrors(clientErrors);
      setError('Vui lòng kiểm tra lại thông tin voucher.');
      return;
    }

    try {
      if (form.id) {
        await api.put(`/admin/vouchers/${form.id}`, payload);
      } else {
        await api.post('/admin/vouchers', payload);
      }

      setForm(getEmptyForm());
      setMessage(form.id ? 'Đã cập nhật voucher.' : 'Đã tạo voucher.');
      await load();
    } catch (err) {
      const responseData = err?.response?.data || {};
      setError(responseData?.data?.message || responseData?.message || err?.message || 'Không lưu được voucher.');
      setFieldErrors(responseData?.data?.fields || {});
    }
  };

  const edit = (item) => {
    setForm({
      id: item.id,
      code: item.code || '',
      name: item.name || '',
      discountType: item.discountType || 'PERCENT',
      discountValue: item.discountValue ?? '',
      minOrderValue: item.minOrderValue ?? '',
      maxDiscountValue: item.maxDiscountValue ?? '',
      usageLimit: item.usageLimit ?? '',
      startAt: formatDateTimeLocal(item.startAt),
      endAt: formatDateTimeLocal(item.endAt),
      status: item.status,
    });
  };

  const toggleStatus = async (item) => {
    await api.patch(`/admin/vouchers/${item.id}/status`, { status: !item.status });
    await load();
  };

  const remove = async (item) => {
    if (!window.confirm(`Xóa voucher ${item.code}?`)) return;

    await api.delete(`/admin/vouchers/${item.id}`);
    await load();
  };

  return (
    <div className="admin-page admin-voucher-page">
      <AdminPageHeader
        eyebrow="Ưu đãi"
        title="Voucher"
        description="Quản lý mã giảm giá cho website, số lượt sử dụng và thời gian hiệu lực."
        action={
          <button type="button" className="btn luxury-primary-btn" onClick={resetForm}>
            Tạo voucher
          </button>
        }
      />

      {error && <div className="alert alert-danger">{error}</div>}

      {fieldErrors._root?.length ? (
        <div className="alert alert-warning mb-3">{fieldErrors._root[0]}</div>
      ) : null}

      {message && <div className="alert alert-success">{message}</div>}

      <div className="admin-voucher-grid">
        <section className="admin-table-panel admin-voucher-list-panel">
          <div className="admin-table-title admin-voucher-panel-head">
            <div>
              <span className="admin-eyebrow">Danh sách</span>
              <h2>Voucher hiện có</h2>
            </div>

            <strong className="admin-voucher-count">
              {filtered.length}/{items.length}
            </strong>
          </div>

          <div className="admin-voucher-search-row">
            <input
              className="form-control admin-voucher-search"
              placeholder="Tìm theo code hoặc tên voucher"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="table-responsive admin-voucher-table-wrap">
            <table className="table admin-table admin-voucher-table align-middle">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Giảm</th>
                  <th>Đã dùng</th>
                  <th>Trạng thái</th>
                  <th className="text-end">Hành động</th>
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="admin-empty-state">
                        <strong>Đang tải voucher...</strong>
                        <span>Danh sách sẽ hiển thị ngay khi backend trả dữ liệu.</span>
                      </div>
                    </td>
                  </tr>
                ) : filtered.length ? (
                  filtered.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <span className="admin-voucher-code">
                          <strong>{item.code}</strong>
                          <small>{item.name}</small>
                        </span>
                      </td>

                      <td className="admin-voucher-discount">
                        {formatDiscount(item)}
                      </td>

                      <td className="admin-voucher-usage">
                        {item.usedCount || 0}
                        {item.usageLimit ? `/${item.usageLimit}` : ''}
                      </td>

                      <td>
                        <StatusBadge voucher={item} />
                      </td>

                      <td className="admin-voucher-action-cell">
                        <div className="admin-voucher-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-dark"
                            onClick={() => edit(item)}
                          >
                            Sửa
                          </button>

                          <button
                            type="button"
                            className="btn btn-sm btn-outline-secondary"
                            onClick={() => toggleStatus(item)}
                          >
                            {item.status ? 'Tắt' : 'Bật'}
                          </button>

                          <button
                            type="button"
                            className="btn btn-sm btn-outline-danger"
                            onClick={() => remove(item)}
                          >
                            Xóa
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5}>
                      <div className="admin-empty-state">
                        <strong>Chưa có voucher phù hợp</strong>
                        <span>Thử đổi từ khóa tìm kiếm hoặc tạo voucher mới.</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <form className="admin-surface-card admin-voucher-form" onSubmit={save}>
          <div className="admin-voucher-form-head">
            <div>
              <span className="admin-eyebrow">
                {isEditing ? 'Chỉnh sửa' : 'Tạo mới'}
              </span>

              <h2>{isEditing ? 'Sửa voucher' : 'Thêm voucher'}</h2>
            </div>

            {isEditing ? (
              <span className="admin-voucher-editing-code">{form.code}</span>
            ) : null}
          </div>

          <div className="admin-voucher-form-grid">
            <label className="admin-voucher-field">
              <span>CODE</span>
              <input
                className="form-control"
                placeholder="VD: HUY10"
                value={form.code}
                onChange={(e) => updateForm('code', e.target.value)}
                required
              />
              {fieldErrors.code?.length ? (
                <small className="text-danger">{fieldErrors.code[0]}</small>
              ) : null}
            </label>

            <label className="admin-voucher-field">
              <span>Tên voucher</span>
              <input
                className="form-control"
                placeholder="VD: Giảm sinh nhật"
                value={form.name}
                onChange={(e) => updateForm('name', e.target.value)}
                required
              />
              {fieldErrors.name?.length ? (
                <small className="text-danger">{fieldErrors.name[0]}</small>
              ) : null}
            </label>

            <label className="admin-voucher-field">
              <span>Kiểu giảm</span>
              <select
                className="form-select"
                value={form.discountType}
                onChange={(e) => updateForm('discountType', e.target.value)}
              >
                <option value="PERCENT">PERCENT</option>
                <option value="AMOUNT">AMOUNT</option>
              </select>
            </label>

            <label className="admin-voucher-field">
              <span>Giá trị giảm</span>
              <input
                className="form-control"
                type="text"
                inputMode="decimal"
                placeholder="VD: 10 hoặc 500.000"
                value={form.discountValue}
                onChange={(e) => updateForm('discountValue', e.target.value)}
                required
              />
              {fieldErrors.discountValue?.length ? (
                <small className="text-danger">{fieldErrors.discountValue[0]}</small>
              ) : null}
            </label>

            <label className="admin-voucher-field">
              <span>Đơn tối thiểu</span>
              <input
                className="form-control"
                type="text"
                inputMode="decimal"
                placeholder="VD: 1.000.000"
                value={form.minOrderValue}
                onChange={(e) => updateForm('minOrderValue', e.target.value)}
              />
              {fieldErrors.minOrderValue?.length ? (
                <small className="text-danger">{fieldErrors.minOrderValue[0]}</small>
              ) : null}
            </label>

            <label className="admin-voucher-field">
              <span>Giảm tối đa</span>
              <input
                className="form-control"
                type="text"
                inputMode="decimal"
                placeholder="VD: 500.000"
                value={form.maxDiscountValue}
                onChange={(e) => updateForm('maxDiscountValue', e.target.value)}
              />
              {fieldErrors.maxDiscountValue?.length ? (
                <small className="text-danger">{fieldErrors.maxDiscountValue[0]}</small>
              ) : null}
            </label>

            <label className="admin-voucher-field">
              <span>Ngày bắt đầu</span>
              <input
                className="form-control"
                type="datetime-local"
                value={form.startAt}
                onChange={(e) => updateForm('startAt', e.target.value)}
              />
              {fieldErrors.startAt?.length ? (
                <small className="text-danger">{fieldErrors.startAt[0]}</small>
              ) : null}
            </label>

            <label className="admin-voucher-field">
              <span>Ngày hết hạn</span>
              <input
                className="form-control"
                type="datetime-local"
                value={form.endAt}
                onChange={(e) => updateForm('endAt', e.target.value)}
              />
              {fieldErrors.endAt?.length ? (
                <small className="text-danger">{fieldErrors.endAt[0]}</small>
              ) : null}
            </label>

            <label className="admin-voucher-field">
              <span>Số lượt dùng</span>
              <input
                className="form-control"
                type="text"
                inputMode="numeric"
                placeholder="VD: 100"
                value={form.usageLimit}
                onChange={(e) => updateForm('usageLimit', e.target.value)}
              />
              {fieldErrors.usageLimit?.length ? (
                <small className="text-danger">{fieldErrors.usageLimit[0]}</small>
              ) : null}
            </label>

            <label className="admin-voucher-toggle">
              <input
                type="checkbox"
                checked={form.status}
                onChange={(e) => updateForm('status', e.target.checked)}
              />
              <span>
                <strong>Kích hoạt</strong>
                <small>Voucher có thể được khách hàng áp dụng khi còn trong thời gian hiệu lực.</small>
              </span>
            </label>
          </div>

          <div className="admin-voucher-form-actions">
            <button className="btn luxury-primary-btn" type="submit">
              Lưu voucher
            </button>

            <button className="btn btn-outline-secondary" type="button" onClick={resetForm}>
              Xóa form
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
