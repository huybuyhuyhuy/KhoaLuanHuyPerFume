import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  AdminEmptyState,
  AdminPageHeader,
  AdminPagination,
  AdminStatGrid,
  formatAdminDate,
} from '../components/Admin/AdminUi';
import {
  cancelPurchaseReceipt,
  createPurchaseReceipt,
  deletePurchaseReceipt,
  getPurchaseReceiptDetail,
  getPurchaseReceipts,
  getPurchaseReceiptStatistics,
  getReceiptProductOptions,
  type PurchaseReceiptDetailResponse,
  type PurchaseReceiptListItem,
  type PurchaseReceiptListParams,
  type PurchaseReceiptPayload,
  type PurchaseReceiptStatistics,
  type PurchaseReceiptStatus,
  type ReceiptProductOption,
} from '../services/adminPurchaseReceiptApi';
import { getSuppliers, type Supplier } from '../services/adminSupplierApi';
import { useToast } from '../store/ToastContext';

const PAGE_SIZE = 10;

const DEFAULT_FILTERS = {
  search: '',
  supplierId: '',
  status: '',
  dateFrom: '',
  dateTo: '',
  sortBy: 'ImportDate' as const,
  sortOrder: 'desc' as const,
};

type ReceiptFormItem = {
  productId: string;
  variantId: string;
  quantity: string;
  importPrice: string;
  note: string;
};

type ReceiptForm = {
  supplierId: string;
  importDate: string;
  note: string;
  items: ReceiptFormItem[];
};

const EMPTY_ITEM: ReceiptFormItem = {
  productId: '',
  variantId: '',
  quantity: '1',
  importPrice: '',
  note: '',
};

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function emptyForm(): ReceiptForm {
  return {
    supplierId: '',
    importDate: todayInputValue(),
    note: '',
    items: [{ ...EMPTY_ITEM }],
  };
}

function formatCurrency(value: unknown) {
  return `${Math.round(Number(value || 0)).toLocaleString('vi-VN')}đ`;
}

function formatNumber(value: unknown) {
  return Math.round(Number(value || 0)).toLocaleString('vi-VN');
}

function getStatusLabel(status: string) {
  const labels: Record<string, string> = {
    DRAFT: 'Phiếu nháp',
    COMPLETED: 'Đã nhập kho',
    CANCELLED: 'Đã hủy',
  };
  return labels[status] || status;
}

function getStatusClass(status: string) {
  if (status === 'COMPLETED') return 'positive';
  if (status === 'CANCELLED') return 'negative';
  return 'progress';
}

function getErrorMessage(error: any, fallback: string) {
  return error?.response?.data?.message || error?.message || fallback;
}

function ReceiptStatusBadge({ status }: { status: string }) {
  return <span className={`admin-status-badge ${getStatusClass(status)}`}>{getStatusLabel(status)}</span>;
}

function ReceiptModalShell({
  title,
  children,
  footer,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="admin-supplier-modal-backdrop" role="presentation">
      <section className={`admin-supplier-modal admin-receipt-modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="admin-supplier-modal-head">
          <div>
            <span className="admin-eyebrow">Nhập hàng</span>
            <h2>{title}</h2>
          </div>
          <button type="button" className="admin-supplier-modal-close" aria-label="Đóng" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="admin-supplier-modal-body">{children}</div>
        {footer && <footer className="admin-supplier-modal-footer">{footer}</footer>}
      </section>
    </div>
  );
}

function productLabel(product: ReceiptProductOption) {
  return `${product.name}${product.sku ? ` · ${product.sku}` : ''}`;
}

function cleanVariantSku(value?: string) {
  const sku = String(value || '').trim();
  if (!sku || sku === '-FULL') return '';
  return sku;
}

function variantTypeLabel(value?: string) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'FULL' || normalized === 'FULL_BOTTLE') return 'Full chai';
  return value || 'Biến thể';
}

function variantLabel(variant: ReceiptProductOption['variants'][number]) {
  return [
    variant.volumeLabel || variantTypeLabel(variant.variantType),
    variantTypeLabel(variant.variantType),
    cleanVariantSku(variant.sku),
    `tồn hiện tại ${formatNumber(variant.stockQuantity)}`,
  ].filter(Boolean).join(' · ');
}

function stockPreview(product: ReceiptProductOption | undefined, variantId: string, quantity: string) {
  if (!product) return '';
  const variant = product.variants.find((item) => String(item.variantId) === String(variantId));
  const currentStock = variant ? Number(variant.stockQuantity || 0) : Number(product.stock || 0);
  const importedQuantity = Math.max(0, Number(quantity) || 0);
  return `Tồn hiện tại: ${formatNumber(currentStock)} · Sau nhập: ${formatNumber(currentStock + importedQuantity)}`;
}

export function AdminPurchaseReceiptsPage() {
  const { pushToast } = useToast();
  const [receipts, setReceipts] = useState<PurchaseReceiptListItem[]>([]);
  const [statistics, setStatistics] = useState<PurchaseReceiptStatistics>({
    totalReceipts: 0,
    totalImportValue: 0,
    totalImportedQuantity: 0,
    currentMonthReceipts: 0,
    topImportedProducts: [],
    topSuppliers: [],
    monthlyImportValues: [],
  });
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<ReceiptProductOption[]>([]);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState(DEFAULT_FILTERS);
  const [pagination, setPagination] = useState({ page: 1, pageSize: PAGE_SIZE, totalItems: 0, totalPages: 1 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState('');
  const [modalMode, setModalMode] = useState<'create' | 'detail' | null>(null);
  const [form, setForm] = useState<ReceiptForm>(emptyForm());
  const [detail, setDetail] = useState<PurchaseReceiptDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const productById = useMemo(
    () => new Map(products.map((product) => [String(product.productId), product])),
    [products],
  );

  const maxProductQuantity = Math.max(...statistics.topImportedProducts.map((item) => Number(item.totalQuantity || 0)), 1);
  const maxSupplierValue = Math.max(...statistics.topSuppliers.map((item) => Number(item.totalValue || 0)), 1);

  const formTotals = useMemo(() => {
    return form.items.reduce((summary, item) => {
      const quantity = Math.max(0, Number(item.quantity) || 0);
      const price = Math.max(0, Number(item.importPrice) || 0);
      return {
        quantity: summary.quantity + quantity,
        amount: summary.amount + quantity * price,
      };
    }, { quantity: 0, amount: 0 });
  }, [form.items]);

  const stats = [
    { label: 'Tổng phiếu nhập', value: formatNumber(statistics.totalReceipts), hint: 'Tất cả phiếu chưa xóa', icon: 'PN' },
    { label: 'Giá trị nhập', value: formatCurrency(statistics.totalImportValue), hint: 'Chỉ tính phiếu đã nhập kho', tone: 'positive', icon: 'VND' },
    { label: 'Sản phẩm đã nhập', value: formatNumber(statistics.totalImportedQuantity), hint: 'Tổng số lượng nhập', icon: 'SKU' },
    { label: 'Tháng này', value: formatNumber(statistics.currentMonthReceipts), hint: 'Phiếu nhập trong tháng', tone: 'warning', icon: 'M' },
  ];

  const loadReceipts = async () => {
    setLoading(true);
    setError('');
    try {
      const params: PurchaseReceiptListParams = {
        ...appliedFilters,
        supplierId: appliedFilters.supplierId ? Number(appliedFilters.supplierId) : '',
        status: appliedFilters.status as PurchaseReceiptStatus | '',
        page,
        pageSize: PAGE_SIZE,
      };
      const [listData, statsData] = await Promise.all([
        getPurchaseReceipts(params),
        getPurchaseReceiptStatistics(),
      ]);
      setReceipts(Array.isArray(listData.items) ? listData.items : []);
      setPagination(listData.pagination || { page, pageSize: PAGE_SIZE, totalItems: 0, totalPages: 1 });
      setStatistics(statsData);
    } catch (requestError: any) {
      const message = getErrorMessage(requestError, 'Không tải được danh sách phiếu nhập.');
      setError(message);
      pushToast(message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadOptions = async () => {
    try {
      const [supplierData, productData] = await Promise.all([
        getSuppliers({ page: 1, pageSize: 100, status: 'ACTIVE', sortBy: 'SupplierName', sortOrder: 'asc' }),
        getReceiptProductOptions({ limit: 200 }),
      ]);
      setSuppliers(Array.isArray(supplierData.items) ? supplierData.items : []);
      setProducts(Array.isArray(productData) ? productData : []);
    } catch (requestError: any) {
      pushToast(getErrorMessage(requestError, 'Không tải được dữ liệu chọn nhà cung cấp/sản phẩm.'), 'error');
    }
  };

  useEffect(() => {
    void loadReceipts();
  }, [page, appliedFilters]);

  useEffect(() => {
    void loadOptions();
  }, []);

  const openCreateModal = () => {
    setForm(emptyForm());
    setModalMode('create');
  };

  const closeModal = () => {
    setModalMode(null);
    setDetail(null);
    setDetailLoading(false);
  };

  const openDetailModal = async (receipt: PurchaseReceiptListItem) => {
    setDetail(null);
    setDetailLoading(true);
    setModalMode('detail');
    try {
      setDetail(await getPurchaseReceiptDetail(receipt.purchaseReceiptId));
    } catch (requestError: any) {
      pushToast(getErrorMessage(requestError, 'Không tải được chi tiết phiếu nhập.'), 'error');
      setModalMode(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setAppliedFilters({ ...filters });
  };

  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setAppliedFilters(DEFAULT_FILTERS);
    setPage(1);
  };

  const updateItem = (index: number, field: keyof ReceiptFormItem, value: string) => {
    setForm((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        if (field === 'productId') {
          const product = productById.get(String(value));
          const defaultVariantId = product?.variants.length === 1 ? String(product.variants[0].variantId) : '';
          return { ...item, productId: value, variantId: defaultVariantId };
        }
        return { ...item, [field]: value };
      }),
    }));
  };

  const addItem = () => {
    setForm((current) => ({ ...current, items: [...current.items, { ...EMPTY_ITEM }] }));
  };

  const removeItem = (index: number) => {
    setForm((current) => ({
      ...current,
      items: current.items.length === 1
        ? [{ ...EMPTY_ITEM }]
        : current.items.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const validateReceiptForm = () => {
    if (!form.supplierId) return 'Vui lòng chọn nhà cung cấp.';
    if (!form.importDate) return 'Vui lòng chọn ngày nhập.';
    if (form.items.length === 0) return 'Phiếu nhập phải có ít nhất một dòng sản phẩm.';

    for (const [index, item] of form.items.entries()) {
      const product = productById.get(item.productId);
      if (!product) return `Dòng ${index + 1}: vui lòng chọn sản phẩm.`;
      if (product.variants.length > 0 && !item.variantId) return `Dòng ${index + 1}: vui lòng chọn biến thể/dung tích.`;
      if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0) return `Dòng ${index + 1}: số lượng phải lớn hơn 0.`;
      if (!Number.isFinite(Number(item.importPrice)) || Number(item.importPrice) < 0) return `Dòng ${index + 1}: giá nhập không được âm.`;
    }

    return '';
  };

  const submitReceipt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationMessage = validateReceiptForm();
    if (validationMessage) {
      pushToast(validationMessage, 'error');
      return;
    }

    const payload: PurchaseReceiptPayload = {
      supplierId: Number(form.supplierId),
      importDate: form.importDate,
      note: form.note.trim(),
      items: form.items.map((item) => ({
        productId: Number(item.productId),
        variantId: item.variantId ? Number(item.variantId) : null,
        quantity: Number(item.quantity),
        importPrice: Number(item.importPrice),
        note: item.note.trim(),
      })),
    };

    setActionBusy(true);
    try {
      const created = await createPurchaseReceipt(payload);
      pushToast(`Đã tạo phiếu nhập ${created.receipt.receiptCode} và cộng tồn kho.`, 'success');
      closeModal();
      await Promise.all([loadReceipts(), loadOptions()]);
    } catch (requestError: any) {
      pushToast(getErrorMessage(requestError, 'Không tạo được phiếu nhập.'), 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const cancelReceipt = async (receipt: PurchaseReceiptListItem) => {
    if (!window.confirm(`Hủy phiếu nhập ${receipt.receiptCode}? Tồn kho sẽ được trừ lại theo từng sản phẩm.`)) return;
    setActionBusy(true);
    try {
      const data = await cancelPurchaseReceipt(receipt.purchaseReceiptId);
      setDetail(data);
      pushToast(`Đã hủy phiếu nhập ${receipt.receiptCode}.`, 'success');
      await Promise.all([loadReceipts(), loadOptions()]);
    } catch (requestError: any) {
      pushToast(getErrorMessage(requestError, 'Không hủy được phiếu nhập.'), 'error');
    } finally {
      setActionBusy(false);
    }
  };

  const removeReceipt = async (receipt: PurchaseReceiptListItem) => {
    if (!window.confirm(`Xóa phiếu nhập ${receipt.receiptCode}?`)) return;
    setActionBusy(true);
    try {
      await deletePurchaseReceipt(receipt.purchaseReceiptId);
      pushToast(`Đã xóa phiếu nhập ${receipt.receiptCode}.`, 'success');
      closeModal();
      await loadReceipts();
    } catch (requestError: any) {
      pushToast(getErrorMessage(requestError, 'Không xóa được phiếu nhập.'), 'error');
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="admin-page admin-receipt-page">
      <AdminPageHeader
        eyebrow="Chuỗi cung ứng"
        title="Quản lý nhập hàng"
        description="Tạo phiếu nhập từ nhà cung cấp, chọn sản phẩm có sẵn, cộng tồn kho tự động và theo dõi thống kê nhập hàng."
        action={(
          <div className="admin-page-action-row">
            <button type="button" className="btn btn-outline-dark" onClick={() => { void loadReceipts(); void loadOptions(); }}>
              Làm mới
            </button>
            <button type="button" className="btn luxury-primary-btn" onClick={openCreateModal}>
              Tạo phiếu nhập
            </button>
          </div>
        )}
      />

      <AdminStatGrid items={stats} />

      <section className="admin-receipt-dashboard">
        <article className="admin-surface-card admin-receipt-insight">
          <div className="admin-table-title compact">
            <div>
              <span className="admin-eyebrow">Top sản phẩm</span>
              <h2>Sản phẩm nhập nhiều</h2>
            </div>
          </div>
          <div className="admin-supplier-bar-list">
            {statistics.topImportedProducts.length === 0 ? (
              <p className="admin-supplier-muted">Chưa có dữ liệu nhập hàng.</p>
            ) : statistics.topImportedProducts.map((item) => (
              <div className="admin-supplier-bar-row" key={item.productId}>
                <span>{item.productName}</span>
                <strong>{formatNumber(item.totalQuantity)}</strong>
                <i style={{ width: `${Math.max(8, (Number(item.totalQuantity || 0) / maxProductQuantity) * 100)}%` }} />
              </div>
            ))}
          </div>
        </article>

        <article className="admin-surface-card admin-receipt-insight">
          <div className="admin-table-title compact">
            <div>
              <span className="admin-eyebrow">Top NCC</span>
              <h2>Giá trị nhập theo NCC</h2>
            </div>
          </div>
          <div className="admin-supplier-bar-list">
            {statistics.topSuppliers.length === 0 ? (
              <p className="admin-supplier-muted">Chưa có nhà cung cấp phát sinh nhập hàng.</p>
            ) : statistics.topSuppliers.map((item) => (
              <div className="admin-supplier-bar-row" key={item.supplierId}>
                <span>{item.supplierName}</span>
                <strong>{formatCurrency(item.totalValue)}</strong>
                <i style={{ width: `${Math.max(8, (Number(item.totalValue || 0) / maxSupplierValue) * 100)}%` }} />
              </div>
            ))}
          </div>
        </article>
      </section>

      <form className="admin-filter-panel admin-receipt-filter-panel" onSubmit={applyFilters}>
        <div className="admin-filter-field grow">
          <label htmlFor="receipt-search">Tìm kiếm</label>
          <input
            id="receipt-search"
            className="form-control"
            value={filters.search}
            placeholder="Mã phiếu hoặc nhà cung cấp"
            onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
          />
        </div>
        <div className="admin-filter-field">
          <label htmlFor="receipt-supplier">Nhà cung cấp</label>
          <select
            id="receipt-supplier"
            className="form-select"
            value={filters.supplierId}
            onChange={(event) => setFilters((current) => ({ ...current, supplierId: event.target.value }))}
          >
            <option value="">Tất cả</option>
            {suppliers.map((supplier) => (
              <option key={supplier.supplierId} value={supplier.supplierId}>{supplier.supplierName}</option>
            ))}
          </select>
        </div>
        <div className="admin-filter-field">
          <label htmlFor="receipt-status">Trạng thái</label>
          <select
            id="receipt-status"
            className="form-select"
            value={filters.status}
            onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
          >
            <option value="">Tất cả</option>
            <option value="COMPLETED">Đã nhập kho</option>
            <option value="CANCELLED">Đã hủy</option>
            <option value="DRAFT">Phiếu nháp</option>
          </select>
        </div>
        <div className="admin-filter-field">
          <label htmlFor="receipt-date-from">Từ ngày</label>
          <input
            id="receipt-date-from"
            className="form-control"
            type="date"
            value={filters.dateFrom}
            onChange={(event) => setFilters((current) => ({ ...current, dateFrom: event.target.value }))}
          />
        </div>
        <div className="admin-filter-field">
          <label htmlFor="receipt-date-to">Đến ngày</label>
          <input
            id="receipt-date-to"
            className="form-control"
            type="date"
            value={filters.dateTo}
            onChange={(event) => setFilters((current) => ({ ...current, dateTo: event.target.value }))}
          />
        </div>
        <button type="submit" className="btn luxury-primary-btn">Lọc</button>
        <button type="button" className="btn btn-outline-dark" onClick={clearFilters}>Xóa lọc</button>
      </form>

      {error && <div className="alert alert-danger admin-alert">{error}</div>}

      <section className="admin-table-panel admin-receipt-table-panel">
        <div className="admin-table-title">
          <div>
            <span className="admin-eyebrow">Danh sách</span>
            <h2>Phiếu nhập hàng</h2>
          </div>
          <strong className="admin-supplier-count">{formatNumber(pagination.totalItems)} phiếu</strong>
        </div>

        {loading ? (
          <div className="admin-loading"><div className="spinner-border" /> Đang tải phiếu nhập...</div>
        ) : receipts.length === 0 ? (
          <AdminEmptyState title="Chưa có phiếu nhập" description="Tạo phiếu nhập đầu tiên từ nhà cung cấp đang hoạt động." />
        ) : (
          <>
            <div className="table-responsive">
              <table className="table admin-table admin-receipt-table align-middle">
                <thead>
                  <tr>
                    <th>Mã phiếu</th>
                    <th>Nhà cung cấp</th>
                    <th>Ngày nhập</th>
                    <th>Số lượng</th>
                    <th>Tổng tiền</th>
                    <th>Người tạo</th>
                    <th>Trạng thái</th>
                    <th className="text-end">Hành động</th>
                  </tr>
                </thead>
                <tbody>
                  {receipts.map((receipt) => (
                    <tr key={receipt.purchaseReceiptId}>
                      <td><strong>{receipt.receiptCode}</strong></td>
                      <td>
                        <div className="admin-contact-cell">
                          <span>{receipt.supplierName}</span>
                          <small>{receipt.supplierCode || `#${receipt.supplierId}`}</small>
                        </div>
                      </td>
                      <td>{formatAdminDate(receipt.importDate)}</td>
                      <td><strong>{formatNumber(receipt.totalQuantity)}</strong></td>
                      <td><strong>{formatCurrency(receipt.totalAmount)}</strong></td>
                      <td>{receipt.createdByName || '-'}</td>
                      <td><ReceiptStatusBadge status={receipt.status} /></td>
                      <td>
                        <div className="admin-row-actions justify-content-end">
                          <button type="button" className="btn btn-sm btn-outline-dark" onClick={() => void openDetailModal(receipt)}>
                            Chi tiết
                          </button>
                          {receipt.status === 'COMPLETED' && (
                            <button type="button" className="btn btn-sm btn-outline-danger" disabled={actionBusy} onClick={() => void cancelReceipt(receipt)}>
                              Hủy
                            </button>
                          )}
                          {receipt.status !== 'COMPLETED' && (
                            <button type="button" className="btn btn-sm btn-outline-danger" disabled={actionBusy} onClick={() => void removeReceipt(receipt)}>
                              Xóa
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <AdminPagination
              page={pagination.page}
              totalPages={pagination.totalPages}
              totalElements={pagination.totalItems}
              onChange={setPage}
            />
          </>
        )}
      </section>

      {modalMode === 'create' && (
        <ReceiptModalShell
          title="Tạo phiếu nhập"
          onClose={closeModal}
          wide
          footer={(
            <>
              <button type="button" className="btn btn-outline-dark" onClick={closeModal}>Hủy</button>
              <button type="submit" form="purchase-receipt-form" className="btn luxury-primary-btn" disabled={actionBusy}>
                {actionBusy ? 'Đang lưu...' : 'Lưu phiếu nhập'}
              </button>
            </>
          )}
        >
          <form id="purchase-receipt-form" className="admin-receipt-form" onSubmit={submitReceipt}>
            <div className="admin-receipt-form-grid">
              <label>
                <span>Nhà cung cấp *</span>
                <select className="form-select" value={form.supplierId} onChange={(event) => setForm((current) => ({ ...current, supplierId: event.target.value }))}>
                  <option value="">Chọn nhà cung cấp</option>
                  {suppliers.map((supplier) => (
                    <option key={supplier.supplierId} value={supplier.supplierId}>{supplier.supplierName}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Ngày nhập *</span>
                <input className="form-control" type="date" value={form.importDate} onChange={(event) => setForm((current) => ({ ...current, importDate: event.target.value }))} />
              </label>
              <label className="admin-receipt-field-wide">
                <span>Ghi chú</span>
                <input className="form-control" value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} />
              </label>
            </div>

            <div className="admin-receipt-items">
              <div className="admin-table-title compact">
                <div>
                  <span className="admin-eyebrow">Sản phẩm nhập</span>
                  <h3>Chi tiết hàng nhập</h3>
                </div>
                <button type="button" className="btn btn-sm btn-outline-dark" onClick={addItem}>Thêm dòng</button>
              </div>

              {form.items.map((item, index) => {
                const product = productById.get(item.productId);
                const lineTotal = Math.max(0, Number(item.quantity) || 0) * Math.max(0, Number(item.importPrice) || 0);
                const selectedStockPreview = stockPreview(product, item.variantId, item.quantity);
                return (
                  <div className="admin-receipt-item-row" key={`${index}-${item.productId}-${item.variantId}`}>
                    <label className="product">
                      <span>Sản phẩm</span>
                      <select className="form-select" value={item.productId} onChange={(event) => updateItem(index, 'productId', event.target.value)}>
                        <option value="">Chọn sản phẩm</option>
                        {products.map((productOption) => (
                          <option key={productOption.productId} value={productOption.productId}>{productLabel(productOption)}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Biến thể</span>
                      <select
                        className="form-select"
                        value={item.variantId}
                        disabled={!product?.variants.length}
                        onChange={(event) => updateItem(index, 'variantId', event.target.value)}
                      >
                        <option value="">{product?.variants.length ? 'Chọn dung tích' : 'Không có'}</option>
                        {product?.variants.map((variant) => (
                          <option key={variant.variantId} value={variant.variantId}>{variantLabel(variant)}</option>
                        ))}
                      </select>
                      {selectedStockPreview && <small className="admin-receipt-stock-preview">{selectedStockPreview}</small>}
                    </label>
                    <label>
                      <span>Số lượng</span>
                      <input className="form-control" type="number" min="1" value={item.quantity} onChange={(event) => updateItem(index, 'quantity', event.target.value)} />
                    </label>
                    <label>
                      <span>Giá nhập</span>
                      <input className="form-control" type="number" min="0" value={item.importPrice} onChange={(event) => updateItem(index, 'importPrice', event.target.value)} />
                    </label>
                    <div className="admin-receipt-line-total">
                      <span>Thành tiền</span>
                      <strong>{formatCurrency(lineTotal)}</strong>
                    </div>
                    <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => removeItem(index)}>Xóa</button>
                  </div>
                );
              })}
            </div>

            <div className="admin-receipt-form-total">
              <span>Tổng số lượng: <strong>{formatNumber(formTotals.quantity)}</strong></span>
              <span>Tổng tiền: <strong>{formatCurrency(formTotals.amount)}</strong></span>
            </div>
          </form>
        </ReceiptModalShell>
      )}

      {modalMode === 'detail' && (
        <ReceiptModalShell
          title="Chi tiết phiếu nhập"
          onClose={closeModal}
          wide
          footer={detail?.receipt ? (
            <>
              <button type="button" className="btn btn-outline-dark" onClick={closeModal}>Đóng</button>
              {detail.receipt.status === 'COMPLETED' && (
                <button type="button" className="btn btn-outline-danger" disabled={actionBusy} onClick={() => void cancelReceipt(detail.receipt)}>
                  Hủy phiếu
                </button>
              )}
              {detail.receipt.status !== 'COMPLETED' && (
                <button type="button" className="btn btn-outline-danger" disabled={actionBusy} onClick={() => void removeReceipt(detail.receipt)}>
                  Xóa phiếu
                </button>
              )}
            </>
          ) : null}
        >
          {detailLoading ? (
            <div className="admin-loading"><div className="spinner-border" /> Đang tải chi tiết...</div>
          ) : detail ? (
            <div className="admin-receipt-detail">
              <div className="admin-receipt-detail-grid">
                <article><span>Mã phiếu</span><strong>{detail.receipt.receiptCode}</strong></article>
                <article><span>Nhà cung cấp</span><strong>{detail.supplier.supplierName}</strong></article>
                <article><span>Ngày nhập</span><strong>{formatAdminDate(detail.receipt.importDate)}</strong></article>
                <article><span>Người tạo</span><strong>{detail.receipt.createdByName || '-'}</strong></article>
                <article><span>Tổng số lượng</span><strong>{formatNumber(detail.receipt.totalQuantity)}</strong></article>
                <article><span>Tổng tiền</span><strong>{formatCurrency(detail.receipt.totalAmount)}</strong></article>
                <article><span>Trạng thái</span><ReceiptStatusBadge status={detail.receipt.status} /></article>
                <article className="wide"><span>Ghi chú</span><strong>{detail.receipt.note || '-'}</strong></article>
              </div>

              <div className="table-responsive">
                <table className="table admin-table admin-receipt-detail-table align-middle">
                  <thead>
                    <tr>
                      <th>Sản phẩm</th>
                      <th>Biến thể</th>
                      <th>Số lượng</th>
                      <th>Giá nhập</th>
                      <th>Thành tiền</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((item) => (
                      <tr key={item.purchaseReceiptItemId}>
                        <td>
                          <div className="admin-contact-cell">
                            <span>{item.productName}</span>
                            <small>{item.productSku || `#${item.productId}`}</small>
                          </div>
                        </td>
                        <td>{item.variantLabel || item.variantType || item.variantSku || '-'}</td>
                        <td><strong>{formatNumber(item.quantity)}</strong></td>
                        <td>{formatCurrency(item.importPrice)}</td>
                        <td><strong>{formatCurrency(item.totalPrice)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <AdminEmptyState title="Không tải được chi tiết" description="Vui lòng đóng modal và thử lại." />
          )}
        </ReceiptModalShell>
      )}
    </div>
  );
}
