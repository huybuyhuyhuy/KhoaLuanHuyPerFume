import {
  cancelPurchaseReceipt as cancelPurchaseReceiptService,
  createPurchaseReceipt as createPurchaseReceiptService,
  deletePurchaseReceipt as deletePurchaseReceiptService,
  getPurchaseReceipt,
  getStatistics,
  listPurchaseReceipts as listPurchaseReceiptsService,
  listReceiptProductOptions,
  PurchaseReceiptServiceError,
  updatePurchaseReceipt as updatePurchaseReceiptService,
} from '../services/adminPurchaseReceiptService.js';
import { errorResponse, successResponse } from '../utils/response.js';
import { buildAuditContext, writeAdminAuditLog } from '../utils/adminAuditLogger.js';

function handlePurchaseReceiptError(res, error, fallback) {
  console.error('[PURCHASE_RECEIPT_ERROR]', {
    name: error?.name,
    status: error?.status,
    message: error?.message,
    details: error?.details,
    stack: error?.stack,
  });

  if (error instanceof PurchaseReceiptServiceError) {
    return errorResponse(res, error.status, error.message, error.details || {});
  }

  return errorResponse(res, 500, fallback, {
    message: error?.message || fallback,
    stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
  });
}

async function writePurchaseReceiptAudit(req, action, detail = null, oldValue = null) {
  const receipt = detail?.receipt || detail;
  await writeAdminAuditLog({
    ...buildAuditContext(req),
    action,
    targetType: 'purchase_receipt',
    targetId: receipt?.purchaseReceiptId || req.params.id || null,
    oldValue,
    newValue: detail,
  });
}

export async function listPurchaseReceipts(req, res) {
  try {
    const data = await listPurchaseReceiptsService(req.query);
    return successResponse(res, 'Lấy danh sách phiếu nhập thành công', data);
  } catch (error) {
    return handlePurchaseReceiptError(res, error, 'Lỗi khi lấy danh sách phiếu nhập');
  }
}

export async function purchaseReceiptStatistics(_req, res) {
  try {
    const data = await getStatistics();
    return successResponse(res, 'Lấy thống kê nhập hàng thành công', data);
  } catch (error) {
    return handlePurchaseReceiptError(res, error, 'Lỗi khi lấy thống kê nhập hàng');
  }
}

export async function purchaseReceiptProductOptions(req, res) {
  try {
    const data = await listReceiptProductOptions(req.query);
    return successResponse(res, 'Lấy danh sách sản phẩm nhập hàng thành công', data);
  } catch (error) {
    return handlePurchaseReceiptError(res, error, 'Lỗi khi lấy sản phẩm nhập hàng');
  }
}

export async function purchaseReceiptDetail(req, res) {
  try {
    const data = await getPurchaseReceipt(req.params.id);
    return successResponse(res, 'Lấy chi tiết phiếu nhập thành công', data);
  } catch (error) {
    return handlePurchaseReceiptError(res, error, 'Lỗi khi lấy chi tiết phiếu nhập');
  }
}

export async function createPurchaseReceipt(req, res) {
  try {
    console.log('[CREATE_PURCHASE_RECEIPT_PAYLOAD]', JSON.stringify(req.body, null, 2));

    const data = await createPurchaseReceiptService(req.body, req.user?.id || null);
    await writePurchaseReceiptAudit(req, 'PURCHASE_RECEIPT_CREATE', data);
    return successResponse(res, 'Tạo phiếu nhập và cộng tồn kho thành công', data, 201);
  } catch (error) {
    return handlePurchaseReceiptError(res, error, 'Lỗi khi tạo phiếu nhập');
  }
}

export async function updatePurchaseReceipt(req, res) {
  try {
    const before = await getPurchaseReceipt(req.params.id).catch(() => null);
    const data = await updatePurchaseReceiptService(req.params.id, req.body);
    await writePurchaseReceiptAudit(req, 'PURCHASE_RECEIPT_UPDATE', data, before);
    return successResponse(res, 'Cập nhật phiếu nhập thành công', data);
  } catch (error) {
    return handlePurchaseReceiptError(res, error, 'Lỗi khi cập nhật phiếu nhập');
  }
}

export async function cancelPurchaseReceipt(req, res) {
  try {
    const before = await getPurchaseReceipt(req.params.id).catch(() => null);
    const data = await cancelPurchaseReceiptService(req.params.id, req.user?.id || null);
    await writePurchaseReceiptAudit(req, 'PURCHASE_RECEIPT_CANCEL', data, before);
    return successResponse(res, 'Hủy phiếu nhập và hoàn tồn kho thành công', data);
  } catch (error) {
    return handlePurchaseReceiptError(res, error, 'Lỗi khi hủy phiếu nhập');
  }
}

export async function deletePurchaseReceipt(req, res) {
  try {
    const data = await deletePurchaseReceiptService(req.params.id);
    await writePurchaseReceiptAudit(req, 'PURCHASE_RECEIPT_DELETE', data, data);
    return successResponse(res, 'Xóa phiếu nhập thành công', data);
  } catch (error) {
    return handlePurchaseReceiptError(res, error, 'Lỗi khi xóa phiếu nhập');
  }
}
