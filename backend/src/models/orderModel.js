import { getDbPool, query, sql } from '../config/database.js';
import { getCart, markCartCheckedOut } from './cartModel.js';
import { invalidateProductCache } from './productModel.js';
import { computeDecantStock, decrementDecantInventory, decrementFullBottleInventory, ensureDecantInventoryTables, restoreDecantInventory, syncVariantStock } from './decantInventoryModel.js';
import { getProductStorageCapabilities, hasOrderItemVariantColumn } from '../modules/products/product.repository.js';
import { getCheckoutStorageCapabilities } from '../modules/checkout/checkout.storage.js';
import {
  decrementBatchVolumes,
  findActiveDecantOption,
  restoreBatchVolumesFromOrderMovements,
  restoreBatchVolume,
  selectDecantBatchesForUpdate,
} from './decantModel.js';
import {
  confirmInventoryReservation,
  createInventoryReservation,
  recordInventoryTransaction,
  releaseInventoryReservation,
} from '../modules/checkout/inventory.repository.js';
import {
  createRedisReservations,
  releaseRedisReservations,
  withInventoryReservationLocks,
} from '../modules/checkout/reservation.redis.js';
import {
  ORDER_STATUS,
  canCustomerCancelOrder,
  canTransitionOrderStatus,
  normalizeOrderStatus,
} from '../constants/orderStatus.js';
import { normalizeVoucherCode, validateVoucherForSubtotal } from '../services/voucherService.js';

function toPositivePrice(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveUnitPrice(originalPrice, salePrice) {
  const original = toPositivePrice(originalPrice);
  const sale = toPositivePrice(salePrice);
  if (!original) return null;
  return sale && sale < original ? sale : original;
}

function hasColumn(columns, name) {
  return columns.has(String(name).toLowerCase());
}

function deletedFilter(columns, alias) {
  return hasColumn(columns, 'deleted_at') ? `AND ${alias}.deleted_at IS NULL` : '';
}

function stockError(productName = '') {
  const safeName = String(productName || '').trim() || 'này';
  return {
    code: 409,
    message: safeName === 'này'
      ? 'Sản phẩm này không đủ tồn kho.'
      : `Sản phẩm ${safeName} không đủ tồn kho.`,
  };
}

function isInventoryShortageError(error) {
  return Boolean(error?.inventoryShortage);
}

function isFullBottleVariantType(value) {
  return ['FULL', 'FULL_BOTTLE'].includes(String(value || '').trim().toUpperCase());
}

function toOrderItem(row) {
  return {
    id: row.item_id,
    productId: row.product_id,
    variantId: row.product_variant_id || null,
    productName: row.product_name,
    productImage: row.product_image || '',
    quantity: Number(row.quantity || 0),
    price: Number(row.price || 0),
    priceAtPurchase: Number(row.price_at_purchase || row.price || 0),
    selectedBatchCode: row.selected_batch_code || '',
    itemType: row.item_type || 'FULL_BOTTLE',
    selectedVolumeMl: row.selected_volume_ml ? Number(row.selected_volume_ml) : null,
    sourceBatchId: row.source_batch_id || null,
  };
}

function toOrder(row, items = []) {
  const subtotal = row.order_subtotal === null || row.order_subtotal === undefined
    ? Number(row.total || 0)
    : Number(row.order_subtotal || 0);
  const voucherDiscountAmount = Number(row.voucher_discount_amount || 0);
  return {
    id: row.id,
    orderCode: row.order_code || `#${row.id}`,
    userId: row.user_id,
    userName: row.user_name || '',
    total: Number(row.total || 0),
    subtotal,
    voucherId: row.voucher_id || null,
    voucherCode: row.voucher_code || '',
    voucherDiscountType: row.voucher_discount_type || '',
    voucherDiscountValue: row.voucher_discount_value === null || row.voucher_discount_value === undefined
      ? null
      : Number(row.voucher_discount_value),
    voucherDiscountAmount,
    shippingAddress: row.shipping_address || '',
    phone: row.phone || '',
    paymentMethod: row.payment_method || '',
    paymentMethodLabel: formatPaymentMethodLabel(row.payment_method),
    paymentStatus: row.payment_status || '',
    momoOrderId: row.momo_order_id || '',
    momoTransId: row.momo_trans_id || '',
    zalopayAppTransId: row.zalopay_app_trans_id || '',
    failureReason: row.failure_reason || '',
    status: normalizeOrderStatus(row.status),
    createdAt: row.created_at,
    items,
  };
}

function buildOrderVoucherSelect(checkoutCapabilities, alias = 'o') {
  const columns = checkoutCapabilities?.orderColumns || new Set();
  const column = (name, fallback = 'NULL') => (
    hasColumn(columns, name) ? `${alias}.${name}` : `${fallback} AS ${name}`
  );
  return [
    column('order_subtotal'),
    column('voucher_id'),
    column('voucher_code', "N''"),
    column('voucher_discount_type', "N''"),
    column('voucher_discount_value'),
    column('voucher_discount_amount', '0'),
  ].join(', ');
}

async function reserveVoucherUsage(transaction, voucherId) {
  if (!voucherId) return { ok: true };

  const request = new sql.Request(transaction);
  request.input('voucherId', sql.Int, Number(voucherId));
  const result = await request.query(
    `UPDATE vouchers
     SET used_count = ISNULL(used_count, 0) + 1
     OUTPUT inserted.used_count AS used_count
     WHERE id = @voucherId
       AND ISNULL(status, 1) = 1
       AND (start_at IS NULL OR start_at <= GETDATE())
       AND (end_at IS NULL OR end_at >= GETDATE())
       AND (usage_limit IS NULL OR ISNULL(used_count, 0) < usage_limit)`
  );

  if (!result.recordset?.[0]) {
    return { code: 409, message: 'Mã voucher vừa hết lượt hoặc không còn khả dụng.' };
  }
  return { ok: true };
}

async function insertOrderStatusHistory(transaction, {
  orderId,
  oldStatus = null,
  newStatus,
  changedBy = null,
  note = null,
}) {
  const request = transaction ? new sql.Request(transaction) : null;
  const normalizedOldStatus = oldStatus ? normalizeOrderStatus(oldStatus) : null;
  const normalizedNewStatus = normalizeOrderStatus(newStatus);
  const statement = `INSERT INTO order_status_history
    (order_id, old_status, new_status, changed_by, note, created_at)
    VALUES (?, ?, ?, ?, ?, GETDATE())`;
  const params = [orderId, normalizedOldStatus, normalizedNewStatus, changedBy, note];

  if (!request) {
    await query(statement, params);
    return;
  }

  request.input('orderId', sql.Int, orderId);
  request.input('oldStatus', sql.NVarChar, normalizedOldStatus);
  request.input('newStatus', sql.NVarChar, normalizedNewStatus);
  request.input('changedBy', sql.Int, changedBy);
  request.input('note', sql.NVarChar, note);
  await request.query(
    `INSERT INTO order_status_history
      (order_id, old_status, new_status, changed_by, note, created_at)
     VALUES (@orderId, @oldStatus, @newStatus, @changedBy, @note, GETDATE())`
  );
}

export async function getOrderStatusTimeline(orderId) {
  const rows = await query(
    `SELECT h.id, h.old_status, h.new_status, h.changed_by, h.note, h.created_at,
            COALESCE(u.name, '') AS changed_by_name
     FROM order_status_history h
     LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.order_id = ?
     ORDER BY h.created_at ASC, h.id ASC`,
    [orderId]
  );

  return rows.map((row) => ({
    id: row.id,
    oldStatus: row.old_status ? normalizeOrderStatus(row.old_status) : null,
    newStatus: normalizeOrderStatus(row.new_status),
    changedBy: row.changed_by || null,
    changedByName: row.changed_by_name || '',
    note: row.note || '',
    createdAt: row.created_at,
  }));
}

export async function updateOrderStatusWithHistory({
  orderId,
  newStatus,
  changedBy = null,
  note = null,
  allowAnyTransition = false,
}) {
  const targetStatus = normalizeOrderStatus(newStatus);
  const pool = await getDbPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const selectRequest = new sql.Request(transaction);
    selectRequest.input('orderId', sql.Int, orderId);
    const result = await selectRequest.query(
      `SELECT TOP 1 id, status
       FROM orders WITH (UPDLOCK, ROWLOCK)
       WHERE id = @orderId`
    );
    const order = result.recordset?.[0];
    if (!order) {
      await transaction.rollback();
      return { code: 404, message: 'Không tìm thấy đơn hàng' };
    }

    const currentStatus = normalizeOrderStatus(order.status);
    if (currentStatus === targetStatus) {
      await transaction.commit();
      return { success: true, orderId, status: targetStatus, unchanged: true };
    }
    if (!allowAnyTransition && !canTransitionOrderStatus(currentStatus, targetStatus)) {
      await transaction.rollback();
      return { code: 409, message: `Không thể chuyển trạng thái từ ${currentStatus} sang ${targetStatus}` };
    }

    const updateRequest = new sql.Request(transaction);
    updateRequest.input('orderId', sql.Int, orderId);
    updateRequest.input('status', sql.NVarChar, targetStatus);
    await updateRequest.query('UPDATE orders SET status = @status WHERE id = @orderId');
    await insertOrderStatusHistory(transaction, {
      orderId,
      oldStatus: currentStatus,
      newStatus: targetStatus,
      changedBy,
      note,
    });
    await transaction.commit();
    return { success: true, orderId, oldStatus: currentStatus, status: targetStatus };
  } catch (error) {
    try { await transaction.rollback(); } catch {}
    throw error;
  }
}

function validatePaymentMethod(paymentMethod) {
  const allowed = ['COD', 'VNPAY', 'BANKING', 'MOMO', 'ZALOPAY'];
  return allowed.includes(String(paymentMethod || '').toUpperCase());
}

function buildOrderFailureSelect(checkoutCapabilities, alias = 'o') {
  return hasColumn(checkoutCapabilities?.orderColumns || new Set(), 'failure_reason')
    ? `${alias}.failure_reason`
    : 'NULL AS failure_reason';
}

function buildOrderPaymentSelect(checkoutCapabilities, alias = 'o') {
  const columns = checkoutCapabilities?.orderColumns || new Set();
  return [
    hasColumn(columns, 'order_code') ? `${alias}.order_code` : `CONCAT(N'#', ${alias}.id) AS order_code`,
    hasColumn(columns, 'payment_status') ? `${alias}.payment_status` : 'NULL AS payment_status',
  ].join(', ');
}

function normalizePaymentMethod(paymentMethod) {
  return String(paymentMethod || '').trim().toUpperCase();
}

function formatPaymentMethodLabel(paymentMethod) {
  const method = normalizePaymentMethod(paymentMethod);
  if (method === 'COD') return 'Thanh toán khi nhận hàng';
  if (method === 'MOMO') return 'MoMo UAT';
  if (method === 'ZALOPAY') return 'ZaloPay Sandbox';
  if (method === 'VNPAY') return 'VNPay';
  if (method === 'BANKING') return 'Chuyển khoản ngân hàng';
  if (method === 'CREDITCARD') return 'Thẻ ngân hàng';
  return paymentMethod || '';
}

function isOnlinePaymentMethod(paymentMethod) {
  return ['MOMO', 'ZALOPAY', 'VNPAY', 'BANKING'].includes(normalizePaymentMethod(paymentMethod));
}

function validateCheckoutCart(cart) {
  if (!cart?.items?.length) {
    return { code: 400, message: 'Gio hang dang trong' };
  }

  for (const item of cart.items) {
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { code: 400, message: 'So luong san pham trong gio hang khong hop le' };
    }
    if (!item.product?.id) {
      return { code: 400, message: 'Gio hang co san pham khong hop le' };
    }
  }

  return null;
}

function toLockItems(cart) {
  return cart.items.map((item) => ({
    productId: Number(item.product.id),
    variantId: item.product.variantId ? Number(item.product.variantId) : null,
    itemType: item.product.itemType || 'FULL_BOTTLE',
    volumeMl: item.product.selectedVolumeMl || null,
    quantity: Number(item.quantity),
  }));
}

async function productHasVariants(transaction, productId, capabilities) {
  if (!capabilities.hasVariants) return false;

  const request = new sql.Request(transaction);
  request.input('productId', sql.Int, productId);
  const deletedClause = deletedFilter(capabilities.variantColumns, 'product_variants').replace(/^AND /, 'WHERE ');
  const statusClause = hasColumn(capabilities.variantColumns, 'status')
    ? `${deletedClause ? 'AND' : 'WHERE'} ISNULL(status, 1) = 1`
    : '';

  const result = await request.query(
    `SELECT COUNT(*) AS total
     FROM product_variants WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
     ${deletedClause}
     ${statusClause}
     ${deletedClause || statusClause ? 'AND' : 'WHERE'} product_id = @productId`
  );
  return Number(result.recordset?.[0]?.total || 0) > 0;
}

async function selectDefaultAvailableVariant(transaction, productId, quantity, capabilities) {
  if (!capabilities.hasVariants || !hasOrderItemVariantColumn(capabilities)) return null;

  const request = new sql.Request(transaction);
  request.input('productId', sql.Int, productId);
  request.input('quantity', sql.Int, quantity);
  const result = await request.query(
    `SELECT TOP 1 pv.id
     FROM product_variants pv WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
     WHERE pv.product_id = @productId
       AND ISNULL(pv.stock_quantity, 0) >= @quantity
       AND ISNULL(pv.price, 0) > 0
       AND UPPER(ISNULL(pv.variant_type, 'FULL')) <> 'DECANT'
       ${deletedFilter(capabilities.variantColumns, 'pv')}
       ${hasColumn(capabilities.variantColumns, 'status') ? 'AND ISNULL(pv.status, 1) = 1' : ''}
     ORDER BY pv.id ASC`
  );
  return result.recordset?.[0]?.id || null;
}

async function prepareBatchDecantInventoryItem(transaction, cartItem) {
  const productId = Number(cartItem.product?.id);
  const quantity = Number(cartItem.quantity);
  const volumeMl = Number(cartItem.product?.selectedVolumeMl || cartItem.product?.volumeMl || cartItem.selectedVolumeMl || 0);
  if (String(cartItem.product?.itemType || '').toUpperCase() !== 'DECANT') return null;
  if (!volumeMl || volumeMl <= 0) return { code: 400, message: 'Dung tích chiết không hợp lệ.' };

  const request = new sql.Request(transaction);
  request.input('productId', sql.Int, productId);
  const result = await request.query(
    `SELECT TOP 1 p.id, p.name, p.image, p.batch_code
     FROM products p WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
     WHERE p.id = @productId AND p.status = 1`
  );
  const row = result.recordset?.[0];
  if (!row) return { code: 404, message: `Không tìm thấy sản phẩm ${productId}` };

  const option = await findActiveDecantOption(productId, volumeMl);
  if (!option) return { code: 404, message: 'Không tìm thấy tùy chọn chiết cho sản phẩm này.' };
  if (Number(option.price || 0) <= 0) return { code: 400, message: `Sản phẩm ${row.name} chưa có giá hợp lệ.` };

  const neededMl = volumeMl * quantity;
  const batchPlan = await selectDecantBatchesForUpdate(transaction, productId, neededMl);
  if (!batchPlan.enough) return stockError(row.name);

  return {
    productId,
    variantId: null,
    productName: row.name,
    productImage: row.image || '',
    quantity,
    unitPrice: Number(option.price || 0),
    stockBefore: Number(batchPlan.stockBefore || 0),
    selectedBatchCode: batchPlan.selectedBatchCode || row.batch_code || '',
    itemType: 'DECANT',
    decantVolumeMl: volumeMl,
    sourceBatchId: batchPlan.sourceBatchId,
    isDecant: false,
    isBatchDecant: true,
    isFullBottle: false,
  };
}

async function prepareVariantInventoryItem(transaction, cartItem, capabilities) {
  const productId = Number(cartItem.product?.id);
  const variantId = Number(cartItem.product?.variantId || cartItem.variantId);
  const quantity = Number(cartItem.quantity);

  if (!variantId) return null;
  if (!hasOrderItemVariantColumn(capabilities)) {
    return { code: 500, message: 'Schema order_items chua ho tro product_variant_id' };
  }

  const request = new sql.Request(transaction);
  request.input('productId', sql.Int, productId);
  request.input('variantId', sql.Int, variantId);
  const result = await request.query(
    `SELECT TOP 1
            p.id AS product_id,
            p.name AS product_name,
            p.image AS product_image,
            p.batch_code,
            pv.id AS variant_id,
            pv.sku AS variant_sku,
            pv.volume_ml AS variant_volume_ml,
            pv.variant_type,
            pv.stock_quantity,
            pv.price AS variant_price,
            pv.sale_price AS variant_sale_price,
            pv.image AS variant_image
     FROM product_variants pv WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
     INNER JOIN products p WITH (UPDLOCK, HOLDLOCK, ROWLOCK) ON p.id = pv.product_id
     WHERE pv.id = @variantId
       AND pv.product_id = @productId
       AND p.status = 1
       ${deletedFilter(capabilities.productColumns, 'p')}
       ${deletedFilter(capabilities.variantColumns, 'pv')}
       ${hasColumn(capabilities.variantColumns, 'status') ? 'AND ISNULL(pv.status, 1) = 1' : ''}`
  );

  const row = result.recordset?.[0];
  if (!row) return { code: 404, message: 'Không tìm thấy biến thể sản phẩm.' };

  const variantType = String(row.variant_type || '').toUpperCase();
  const isDecant = variantType === 'DECANT';
  const isFullBottle = isFullBottleVariantType(variantType);

  // ── decant stock validation: check product_inventory ──
  if (isDecant) {
    const decantVolumeMl = Number(row.variant_volume_ml) || 0;
    if (decantVolumeMl <= 0) return { code: 400, message: 'Biến thể decant chưa có dung tích hợp lệ.' };

    const neededMl = decantVolumeMl * quantity;
    const stock = await computeDecantStock(transaction, productId, decantVolumeMl);
    if (neededMl > stock.totalAvailableMl) {
      return stockError(row.product_name);
    }

    const unitPrice = resolveUnitPrice(row.variant_price, row.variant_sale_price);
    if (!unitPrice) return { code: 400, message: `Sản phẩm ${row.product_name} chưa có giá hợp lệ.` };

    return {
      productId,
      variantId,
      productName: row.product_name,
      productImage: row.variant_image || row.product_image || '',
      quantity,
      unitPrice,
      stockBefore: stock.totalAvailableMl,
      selectedBatchCode: row.variant_sku || row.batch_code || '',
      itemType: 'DECANT',
      isDecant: true,
      decantVolumeMl,
      isFullBottle: false,
    };
  }

  // ── full bottle: check variant stock_quantity ──
  if (quantity > Number(row.stock_quantity || 0)) {
    return stockError(row.product_name);
  }

  const unitPrice = resolveUnitPrice(row.variant_price, row.variant_sale_price);
  if (!unitPrice) return { code: 400, message: `Sản phẩm ${row.product_name} chưa có giá hợp lệ.` };

  return {
    productId,
    variantId,
    productName: row.product_name,
    productImage: row.variant_image || row.product_image || '',
    quantity,
    unitPrice,
    stockBefore: Number(row.stock_quantity || 0),
    selectedBatchCode: row.variant_sku || row.batch_code || '',
    itemType: 'FULL_BOTTLE',
    isDecant: false,
    isFullBottle: isFullBottle,
  };
}

async function prepareProductInventoryItem(transaction, cartItem, capabilities) {
  const productId = Number(cartItem.product?.id);
  const quantity = Number(cartItem.quantity);

  if (await productHasVariants(transaction, productId, capabilities)) {
    const fallbackVariantId = await selectDefaultAvailableVariant(transaction, productId, quantity, capabilities);
    if (!fallbackVariantId) {
      return stockError(cartItem.product?.name);
    }
    return prepareVariantInventoryItem(transaction, {
      ...cartItem,
      product: { ...cartItem.product, variantId: fallbackVariantId },
    }, capabilities);
  }

  const stockColumn = hasColumn(capabilities.productColumns, 'stock')
    ? 'stock'
    : hasColumn(capabilities.productColumns, 'quantity')
      ? 'quantity'
      : null;
  if (!stockColumn) {
    return { code: 500, message: 'Schema products chưa có cột tồn kho.' };
  }

  const request = new sql.Request(transaction);
  request.input('productId', sql.Int, productId);
  const result = await request.query(
    `SELECT TOP 1 p.id, p.name, p.image, p.batch_code, p.${stockColumn} AS stock, p.price, p.discount_price
     FROM products p WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
     WHERE p.id = @productId
       AND p.status = 1
       ${deletedFilter(capabilities.productColumns, 'p')}`
  );

  const row = result.recordset?.[0];
  if (!row) return { code: 404, message: `Không tìm thấy sản phẩm ${productId}` };
  if (quantity > Number(row.stock || 0)) {
    return stockError(row.name);
  }

  const unitPrice = resolveUnitPrice(row.price, row.discount_price);
  if (!unitPrice) return { code: 400, message: `Sản phẩm ${row.name} chưa có giá hợp lệ.` };

  return {
    productId,
    variantId: null,
    productName: row.name,
    productImage: row.image || '',
    quantity,
    unitPrice,
    stockBefore: Number(row.stock || 0),
    selectedBatchCode: row.batch_code || '',
    itemType: 'FULL_BOTTLE',
    stockColumn,
  };
}

async function decrementVariantStockQuantity(transaction, item) {
  if (!item.variantId) return true;

  const request = new sql.Request(transaction);
  request.input('productId', sql.Int, item.productId);
  request.input('variantId', sql.Int, item.variantId);
  request.input('quantity', sql.Int, item.quantity);
  const result = await request.query(
    `UPDATE product_variants
     SET stock_quantity = stock_quantity - @quantity
     WHERE id = @variantId
       AND product_id = @productId
       AND stock_quantity >= @quantity`
  );
  return result.rowsAffected?.[0] > 0;
}

async function decrementInventory(transaction, item) {
  if (item.itemType === 'DECANT' && item.sourceBatchId) {
    const neededMl = (item.decantVolumeMl || 0) * item.quantity;
    const stock = await decrementBatchVolumes(transaction, {
      productId: item.productId,
      neededMl,
      orderId: item.orderId || null,
      adminId: item.adminId || null,
    });
    return stock?.stockAfter ?? null;
  }

  // ── decant: use product_inventory instead of variant stock ──
  if (item.isDecant) {
    const neededMl = (item.decantVolumeMl || 0) * item.quantity;
    const result = await decrementDecantInventory(transaction, {
      productId: item.productId,
      neededMl,
    });
    return result.openedMlAfter;
  }

  // ── full bottle via inventory tracking ──
  if (item.isFullBottle) {
    const result = await decrementFullBottleInventory(transaction, {
      productId: item.productId,
      quantity: item.quantity,
    });
    if (!(await decrementVariantStockQuantity(transaction, item))) return null;
    return result.sealedBottlesAfter;
  }

  const request = new sql.Request(transaction);
  request.input('productId', sql.Int, item.productId);
  request.input('quantity', sql.Int, item.quantity);

  if (item.variantId) {
    request.input('variantId', sql.Int, item.variantId);
    const result = await request.query(
      `UPDATE product_variants
       SET stock_quantity = stock_quantity - @quantity
       WHERE id = @variantId AND product_id = @productId AND stock_quantity >= @quantity`
    );
    return result.rowsAffected?.[0] > 0 ? item.stockBefore - item.quantity : null;
  }

  const result = await request.query(
    `UPDATE products
     SET ${item.stockColumn === 'quantity' ? 'quantity' : 'stock'} = ${item.stockColumn === 'quantity' ? 'quantity' : 'stock'} - @quantity
     WHERE id = @productId AND ${item.stockColumn === 'quantity' ? 'quantity' : 'stock'} >= @quantity`
  );
  return result.rowsAffected?.[0] > 0 ? item.stockBefore - item.quantity : null;
}

async function insertOrderItem(transaction, orderId, item, capabilities) {
  const request = new sql.Request(transaction);
  request.input('orderId', sql.Int, orderId);
  request.input('productId', sql.Int, item.productId);
  request.input('quantity', sql.Int, item.quantity);
  request.input('price', sql.Float, item.unitPrice);
  request.input('selectedBatchCode', sql.NVarChar, item.selectedBatchCode);
  request.input('priceAtPurchase', sql.Float, item.unitPrice);

  const columns = ['order_id', 'product_id'];
  const values = ['@orderId', '@productId'];
  if (item.variantId && hasOrderItemVariantColumn(capabilities)) {
    request.input('productVariantId', sql.Int, item.variantId);
    columns.push('product_variant_id');
    values.push('@productVariantId');
  }
  columns.push('quantity', 'price');
  values.push('@quantity', '@price');
  if (hasColumn(capabilities.orderItemColumns, 'selected_batch_code')) {
    columns.push('selected_batch_code');
    values.push('@selectedBatchCode');
  }
  if (hasColumn(capabilities.orderItemColumns, 'price_at_purchase')) {
    columns.push('price_at_purchase');
    values.push('@priceAtPurchase');
  }
  if (hasColumn(capabilities.orderItemColumns, 'item_type')) {
    request.input('itemType', sql.NVarChar, item.itemType || 'FULL_BOTTLE');
    columns.push('item_type');
    values.push('@itemType');
  }
  if (hasColumn(capabilities.orderItemColumns, 'selected_volume_ml')) {
    request.input('selectedVolumeMl', sql.Int, item.decantVolumeMl || null);
    columns.push('selected_volume_ml');
    values.push('@selectedVolumeMl');
  }
  if (hasColumn(capabilities.orderItemColumns, 'source_batch_id')) {
    request.input('sourceBatchId', sql.Int, item.sourceBatchId || null);
    columns.push('source_batch_id');
    values.push('@sourceBatchId');
  }
  if (hasColumn(capabilities.orderItemColumns, 'status')) {
    columns.push('status');
    values.push("'Normal'");
  }

  await request.query(
    `INSERT INTO order_items (${columns.join(', ')})
     VALUES (${values.join(', ')})`
  );
}

export async function checkoutOrder({ userId, shippingAddress, phone, paymentMethod, idempotencyKey = null, voucherCode = null }) {
  if (!userId) {
    return { code: 401, message: 'Vui long dang nhap de thanh toan' };
  }
  if (!String(shippingAddress || '').trim()) {
    return { code: 400, message: 'Dia chi giao hang khong duoc de trong' };
  }
  if (!/^\d{10}$/.test(String(phone || ''))) {
    return { code: 400, message: 'So dien thoai phai co 10 chu so' };
  }
  if (!validatePaymentMethod(paymentMethod)) {
    return { code: 400, message: 'Phuong thuc thanh toan khong hop le' };
  }

  const safePaymentMethod = normalizePaymentMethod(paymentMethod);
  const initialOrderStatus = isOnlinePaymentMethod(safePaymentMethod)
    ? ORDER_STATUS.PENDING_PAYMENT
    : ORDER_STATUS.PENDING;
  const checkoutCapabilities = await getCheckoutStorageCapabilities();
  const safeVoucherCode = normalizeVoucherCode(voucherCode);
  const safeIdempotencyKey = String(idempotencyKey || '').trim();
  if (safeIdempotencyKey && hasColumn(checkoutCapabilities.orderColumns, 'checkout_idempotency_key')) {
    const existingRows = await query(
      `SELECT TOP 1 id
       FROM orders
       WHERE user_id = ? AND checkout_idempotency_key = ?
       ORDER BY id DESC`,
      [userId, safeIdempotencyKey]
    );
    const existingOrderId = existingRows[0]?.id;
    if (existingOrderId) {
      return { order: await getOrderByIdForUser(existingOrderId, userId), idempotent: true };
    }
  }

  const cart = await getCart({ type: 'user', key: userId });
  const cartError = validateCheckoutCart(cart);
  if (cartError) return cartError;

  return withInventoryReservationLocks(toLockItems(cart), async () => {
    let redisReservationKeys = [];
    let transaction = null;

    try {
      redisReservationKeys = await createRedisReservations(toLockItems(cart), {
        owner: `user:${userId}`,
        ttlSeconds: process.env.CHECKOUT_RESERVATION_TTL_SECONDS,
      });

      const capabilities = await getProductStorageCapabilities();
      await ensureDecantInventoryTables();
      const pool = await getDbPool();
      transaction = new sql.Transaction(pool);
      await transaction.begin();

      let total = 0;
      const preparedItems = [];

      for (const cartItem of cart.items) {
        const batchDecantPrepared = await prepareBatchDecantInventoryItem(transaction, cartItem);
        if (batchDecantPrepared?.code) {
          await transaction.rollback();
          return batchDecantPrepared;
        }

        const variantPrepared = !batchDecantPrepared && capabilities.hasVariants
          ? await prepareVariantInventoryItem(transaction, cartItem, capabilities)
          : null;
        if (variantPrepared?.code) {
          await transaction.rollback();
          return variantPrepared;
        }

        const prepared = batchDecantPrepared || variantPrepared || await prepareProductInventoryItem(transaction, cartItem, capabilities);
        if (prepared.code) {
          await transaction.rollback();
          return prepared;
        }

        total += prepared.unitPrice * prepared.quantity;
        preparedItems.push(prepared);
      }

      let voucher = null;
      const orderSubtotal = total;
      let orderTotal = total;
      if (safeVoucherCode) {
        const voucherResult = await validateVoucherForSubtotal({ code: safeVoucherCode, subtotal: orderSubtotal });
        if (voucherResult.code) {
          await transaction.rollback();
          return voucherResult;
        }
        voucher = voucherResult.voucher;
        orderTotal = voucher.totalAfterDiscount;
      }

      const request = new sql.Request(transaction);
      request.input('userId', sql.Int, userId);
      request.input('total', sql.Float, orderTotal);
      request.input('shippingAddress', sql.NVarChar, String(shippingAddress).trim());
      request.input('phone', sql.NVarChar, String(phone).trim());
      request.input('paymentMethod', sql.NVarChar, safePaymentMethod);
      request.input('status', sql.NVarChar, initialOrderStatus);
      request.input('paymentStatus', sql.NVarChar, 'PENDING');

      const orderColumns = ['user_id', 'total', 'shipping_address', 'phone', 'payment_method', 'status'];
      const orderValues = ['@userId', '@total', '@shippingAddress', '@phone', '@paymentMethod', '@status'];
      if (hasColumn(checkoutCapabilities.orderColumns, 'payment_status')) {
        orderColumns.push('payment_status');
        orderValues.push('@paymentStatus');
      }
      if (safeIdempotencyKey && hasColumn(checkoutCapabilities.orderColumns, 'checkout_idempotency_key')) {
        request.input('idempotencyKey', sql.NVarChar, safeIdempotencyKey);
        orderColumns.push('checkout_idempotency_key');
        orderValues.push('@idempotencyKey');
      }
      if (hasColumn(checkoutCapabilities.orderColumns, 'inventory_status')) {
        request.input('inventoryStatus', sql.NVarChar, 'RESERVED');
        orderColumns.push('inventory_status');
        orderValues.push('@inventoryStatus');
      }
      if (hasColumn(checkoutCapabilities.orderColumns, 'order_subtotal')) {
        request.input('orderSubtotal', sql.Float, orderSubtotal);
        orderColumns.push('order_subtotal');
        orderValues.push('@orderSubtotal');
      }
      if (voucher && hasColumn(checkoutCapabilities.orderColumns, 'voucher_id')) {
        request.input('voucherId', sql.Int, Number(voucher.id));
        orderColumns.push('voucher_id');
        orderValues.push('@voucherId');
      }
      if (voucher && hasColumn(checkoutCapabilities.orderColumns, 'voucher_code')) {
        request.input('voucherCode', sql.NVarChar, voucher.code);
        orderColumns.push('voucher_code');
        orderValues.push('@voucherCode');
      }
      if (voucher && hasColumn(checkoutCapabilities.orderColumns, 'voucher_discount_type')) {
        request.input('voucherDiscountType', sql.NVarChar, voucher.discountType);
        orderColumns.push('voucher_discount_type');
        orderValues.push('@voucherDiscountType');
      }
      if (voucher && hasColumn(checkoutCapabilities.orderColumns, 'voucher_discount_value')) {
        request.input('voucherDiscountValue', sql.Float, Number(voucher.discountValue || 0));
        orderColumns.push('voucher_discount_value');
        orderValues.push('@voucherDiscountValue');
      }
      if (voucher && hasColumn(checkoutCapabilities.orderColumns, 'voucher_discount_amount')) {
        request.input('voucherDiscountAmount', sql.Float, Number(voucher.discountAmount || 0));
        orderColumns.push('voucher_discount_amount');
        orderValues.push('@voucherDiscountAmount');
      }

      const orderResult = await request.query(
        `INSERT INTO orders (${orderColumns.join(', ')})
         OUTPUT INSERTED.id AS id
         VALUES (${orderValues.join(', ')})`
      );

      const orderId = orderResult.recordset?.[0]?.id;
      if (!orderId) throw new Error('Khong tao duoc don hang');
      if (hasColumn(checkoutCapabilities.orderColumns, 'order_code')) {
        const codeRequest = new sql.Request(transaction);
        codeRequest.input('orderId', sql.Int, orderId);
        codeRequest.input('orderCode', sql.NVarChar, `#${orderId}`);
        await codeRequest.query(
          `UPDATE orders
           SET order_code = COALESCE(NULLIF(LTRIM(RTRIM(order_code)), N''), @orderCode)
           WHERE id = @orderId`
        );
      }

      if (voucher?.id) {
        const voucherUsageResult = await reserveVoucherUsage(transaction, voucher.id);
        if (voucherUsageResult.code) {
          await transaction.rollback();
          return voucherUsageResult;
        }
      }

      await insertOrderStatusHistory(transaction, {
        orderId,
        newStatus: initialOrderStatus,
        changedBy: userId,
        note: 'Đơn hàng được tạo',
      });

      for (const item of preparedItems) {
        item.orderId = orderId;
        const reservation = await createInventoryReservation(transaction, item, {
          cartId: cart.cartId || null,
          orderId,
          userId,
        });
        let stockAfter = null;
        try {
          stockAfter = await decrementInventory(transaction, item);
        } catch (error) {
          if (!isInventoryShortageError(error)) throw error;
          await transaction.rollback();
          transaction = null;
          return stockError(item.productName);
        }
        if (stockAfter === null) {
          await transaction.rollback();
          transaction = null;
          return stockError(item.productName);
        }

        await insertOrderItem(transaction, orderId, item, capabilities);
        await recordInventoryTransaction(transaction, {
          productId: item.productId,
          variantId: item.variantId,
          orderId,
          cartId: cart.cartId || null,
          reservationId: reservation?.id || null,
          transactionType: 'RESERVE',
          quantity: -item.quantity,
          stockBefore: item.stockBefore,
          stockAfter,
          metadata: { paymentMethod: safePaymentMethod, idempotencyKey: safeIdempotencyKey || null, voucherCode: voucher?.code || null },
        });
        await confirmInventoryReservation(transaction, reservation?.id);
        await recordInventoryTransaction(transaction, {
          productId: item.productId,
          variantId: item.variantId,
          orderId,
          cartId: cart.cartId || null,
          reservationId: reservation?.id || null,
          transactionType: 'COMMIT',
          quantity: 0,
          stockBefore: stockAfter,
          stockAfter,
          metadata: { orderStatus: initialOrderStatus },
        });
      }

      await transaction.commit();
      transaction = null;
      if (!isOnlinePaymentMethod(safePaymentMethod)) {
        try {
          await markCartCheckedOut({ type: 'user', key: userId });
        } catch (error) {
          console.warn('Order committed but cart checkout marker failed:', error.message);
        }
      }
      try {
        await Promise.all([...new Set(preparedItems.map((item) => item.productId))].map((id) => invalidateProductCache(id)));
      } catch (error) {
        console.warn('Order committed but product cache invalidation failed:', error.message);
      }

      // Sync variant stock_quantity for decant/full-bottle products
      try {
        await Promise.all(
          [...new Set(preparedItems.filter((item) => item.isDecant || item.isFullBottle || item.isBatchDecant).map((item) => item.productId))]
            .map((id) => syncVariantStock(id))
        );
      } catch (error) {
        console.warn('Order committed but variant stock sync failed:', error.message);
      }

      const createdOrder = await getOrderByIdForUser(orderId, userId);
      return { order: createdOrder };
    } catch (error) {
      try { await transaction?.rollback(); } catch {}
      if (safeIdempotencyKey && /duplicate|unique|UX_orders_checkout_idempotency/i.test(String(error.message || ''))) {
        const rows = await query(
          'SELECT TOP 1 id FROM orders WHERE user_id = ? AND checkout_idempotency_key = ? ORDER BY id DESC',
          [userId, safeIdempotencyKey]
        );
        if (rows[0]?.id) return { order: await getOrderByIdForUser(rows[0].id, userId), idempotent: true };
      }
      throw error;
    } finally {
      await releaseRedisReservations(redisReservationKeys);
    }
  });
}

function buildOrderItemSelect(capabilities) {
  const variantSelect = hasOrderItemVariantColumn(capabilities)
    ? 'oi.product_variant_id'
    : 'NULL AS product_variant_id';
  const batchSelect = hasColumn(capabilities.orderItemColumns, 'selected_batch_code')
    ? 'oi.selected_batch_code'
    : "N'' AS selected_batch_code";
  const priceAtPurchaseSelect = hasColumn(capabilities.orderItemColumns, 'price_at_purchase')
    ? 'oi.price_at_purchase'
    : 'oi.price AS price_at_purchase';
  const itemTypeSelect = hasColumn(capabilities.orderItemColumns, 'item_type')
    ? 'oi.item_type'
    : "N'FULL_BOTTLE' AS item_type";
  const selectedVolumeSelect = hasColumn(capabilities.orderItemColumns, 'selected_volume_ml')
    ? 'oi.selected_volume_ml'
    : 'NULL AS selected_volume_ml';
  const sourceBatchSelect = hasColumn(capabilities.orderItemColumns, 'source_batch_id')
    ? 'oi.source_batch_id'
    : 'NULL AS source_batch_id';
  return `
    SELECT oi.id AS item_id, oi.product_id, ${variantSelect}, p.name AS product_name,
           COALESCE(pv.image, p.image) AS product_image,
           oi.quantity, oi.price, ${priceAtPurchaseSelect}, ${batchSelect},
           ${itemTypeSelect}, ${selectedVolumeSelect}, ${sourceBatchSelect}
    FROM order_items oi
    INNER JOIN products p ON p.id = oi.product_id
    ${capabilities.hasVariants && hasOrderItemVariantColumn(capabilities)
      ? 'LEFT JOIN product_variants pv ON pv.id = oi.product_variant_id'
      : 'LEFT JOIN (SELECT NULL AS id, NULL AS image) pv ON 1 = 0'}
  `;
}

export async function getOrderByIdForUser(orderId, userId) {
  const checkoutCapabilities = await getCheckoutStorageCapabilities();
  const orderRows = await query(
    `SELECT TOP 1 o.id, o.user_id, u.name AS user_name, o.total, o.shipping_address, o.phone,
            o.payment_method, o.momo_order_id, o.momo_trans_id, o.zalopay_app_trans_id,
            ${buildOrderPaymentSelect(checkoutCapabilities, 'o')},
            ${buildOrderFailureSelect(checkoutCapabilities, 'o')},
            o.status, o.created_at, ${buildOrderVoucherSelect(checkoutCapabilities, 'o')}
     FROM orders o
     INNER JOIN users u ON u.id = o.user_id
     WHERE o.id = ? AND o.user_id = ?`,
    [orderId, userId]
  );
  const order = orderRows[0];
  if (!order) return null;

  const capabilities = await getProductStorageCapabilities();
  const itemRows = await query(
    `${buildOrderItemSelect(capabilities)}
     WHERE oi.order_id = ?
     ORDER BY oi.id ASC`,
    [orderId]
  );

  const timeline = await getOrderStatusTimeline(orderId);
  return { ...toOrder(order, itemRows.map(toOrderItem)), timeline };
}

export async function listOrderHistory(userId) {
  const checkoutCapabilities = await getCheckoutStorageCapabilities();
  const orderRows = await query(
    `SELECT o.id, o.user_id, u.name AS user_name, o.total, o.shipping_address, o.phone,
            o.payment_method, o.momo_order_id, o.momo_trans_id, o.zalopay_app_trans_id,
            ${buildOrderPaymentSelect(checkoutCapabilities, 'o')},
            ${buildOrderFailureSelect(checkoutCapabilities, 'o')},
            o.status, o.created_at, ${buildOrderVoucherSelect(checkoutCapabilities, 'o')}
     FROM orders o
     INNER JOIN users u ON u.id = o.user_id
     WHERE o.user_id = ?
     ORDER BY o.id DESC`,
    [userId]
  );

  const capabilities = await getProductStorageCapabilities();
  const orders = [];
  for (const orderRow of orderRows) {
    const itemRows = await query(
      `${buildOrderItemSelect(capabilities)}
       WHERE oi.order_id = ?
       ORDER BY oi.id ASC`,
      [orderRow.id]
    );
    orders.push(toOrder(orderRow, itemRows.map(toOrderItem)));
  }
  return orders;
}

async function restoreInventory(transaction, item, capabilities = null) {
  if (String(item.item_type || '').toUpperCase() === 'DECANT' && item.source_batch_id) {
    const volumeMl = Number(item.selected_volume_ml || 0) * Number(item.quantity || 0);
    if (item.skipBatchMovementRestore) return null;

    const movementStock = await restoreBatchVolumesFromOrderMovements(transaction, {
      orderId: item.orderId,
      productId: item.product_id,
      adminId: item.adminId || null,
    });
    if (movementStock) return movementStock;

    return restoreBatchVolume(transaction, {
      batchId: item.source_batch_id,
      volumeMl,
    });
  }

  // ── decant restore ──
  if (item.isDecant) {
    const neededMl = (item.decantVolumeMl || 0) * (item.quantity || 0);
    const result = await restoreDecantInventory(transaction, {
      productId: item.product_id,
      neededMl,
      isFullBottle: false,
    });
    return { stock_before: result.openedMl - neededMl, stock_after: result.openedMl };
  }

  // ── full bottle restore via product_inventory ──
  if (item.isFullBottle) {
    const quantity = Number(item.quantity || 0);
    const result = await restoreDecantInventory(transaction, {
      productId: item.product_id,
      neededMl: 0,
      isFullBottle: true,
      quantity,
    });
    if (item.product_variant_id) {
      const variantRequest = new sql.Request(transaction);
      variantRequest.input('productId', sql.Int, item.product_id);
      variantRequest.input('variantId', sql.Int, item.product_variant_id);
      variantRequest.input('quantity', sql.Int, quantity);
      await variantRequest.query(
        `UPDATE product_variants
         SET stock_quantity = stock_quantity + @quantity
         WHERE id = @variantId AND product_id = @productId`
      );
    }
    return { stock_before: result.sealedBottles - quantity, stock_after: result.sealedBottles };
  }

  const request = new sql.Request(transaction);
  request.input('productId', sql.Int, item.product_id);
  request.input('quantity', sql.Int, item.quantity);

  if (item.product_variant_id) {
    request.input('variantId', sql.Int, item.product_variant_id);
    const result = await request.query(
      `UPDATE product_variants
       SET stock_quantity = stock_quantity + @quantity
       OUTPUT deleted.stock_quantity AS stock_before, inserted.stock_quantity AS stock_after
       WHERE id = @variantId AND product_id = @productId`
    );
    return result.recordset?.[0] || null;
  }

  const productCapabilities = capabilities || await getProductStorageCapabilities();
  const stockColumn = hasColumn(productCapabilities.productColumns, 'stock')
    ? 'stock'
    : hasColumn(productCapabilities.productColumns, 'quantity')
      ? 'quantity'
      : 'stock';

  const result = await request.query(
    `UPDATE products
     SET ${stockColumn} = ${stockColumn} + @quantity
     OUTPUT deleted.${stockColumn} AS stock_before, inserted.${stockColumn} AS stock_after
     WHERE id = @productId`
  );
  return result.recordset?.[0] || null;
}

async function findReservationForOrderItem(transaction, orderId, item, checkoutCapabilities) {
  if (!checkoutCapabilities.hasInventoryReservations) return null;

  const request = new sql.Request(transaction);
  request.input('orderId', sql.Int, orderId);
  request.input('productId', sql.Int, item.product_id);
  request.input('variantId', sql.Int, item.product_variant_id || null);
  const result = await request.query(
    `SELECT TOP 1 id
     FROM inventory_reservations WITH (UPDLOCK, ROWLOCK)
     WHERE order_id = @orderId
       AND product_id = @productId
       AND ISNULL(product_variant_id, 0) = ISNULL(@variantId, 0)
       AND status = 'CONFIRMED'
     ORDER BY id DESC`
  );

  return result.recordset?.[0]?.id || null;
}

async function releaseCancelledOrderInventory({
  orderId,
  userId = null,
  customerInitiated = false,
  targetStatus = ORDER_STATUS.CANCELLED,
  changedBy = null,
  note = null,
}) {
  const capabilities = await getProductStorageCapabilities();
  const checkoutCapabilities = await getCheckoutStorageCapabilities();
  await ensureDecantInventoryTables();
  const pool = await getDbPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const orderRequest = new sql.Request(transaction);
    orderRequest.input('orderId', sql.Int, orderId);
    if (userId) orderRequest.input('userId', sql.Int, userId);
    const ownerClause = userId ? 'AND user_id = @userId' : '';
    const orderResult = await orderRequest.query(
      `SELECT TOP 1 id, user_id, status, payment_method, created_at
       FROM orders WITH (UPDLOCK, ROWLOCK)
       WHERE id = @orderId ${ownerClause}`
    );

    const order = orderResult.recordset?.[0];
    if (!order) {
      await transaction.rollback();
      return { code: 404, message: 'Khong tim thay don hang' };
    }
    const currentStatus = normalizeOrderStatus(order.status);
    if ([ORDER_STATUS.PAYMENT_REJECTED, ORDER_STATUS.PAYMENT_FAILED, ORDER_STATUS.CANCELLED_PAYMENT, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED].includes(currentStatus)) {
      await transaction.rollback();
      return { code: 400, message: 'Đơn hàng đã bị hủy hoặc hoàn tiền' };
    }

    if (customerInitiated && !canCustomerCancelOrder(currentStatus)) {
      await transaction.rollback();
      return { code: 409, message: 'Đơn đang giao hoặc đã hoàn tất, không thể hủy' };
    }
    const effectiveTargetStatus = targetStatus;

    if (!canTransitionOrderStatus(currentStatus, effectiveTargetStatus)) {
      await transaction.rollback();
      return { code: 409, message: `Không thể chuyển trạng thái từ ${currentStatus} sang ${targetStatus}` };
    }

    const statusRequest = new sql.Request(transaction);
    statusRequest.input('orderId', sql.Int, orderId);
    statusRequest.input('status', sql.NVarChar, effectiveTargetStatus);
    const statusAssignments = ['status = @status'];
    if (hasColumn(checkoutCapabilities.orderColumns, 'inventory_status')) statusAssignments.push("inventory_status = 'RELEASED'");
    if (hasColumn(checkoutCapabilities.orderColumns, 'payment_status')) statusAssignments.push("payment_status = 'CANCELLED'");
    await statusRequest.query(
      `UPDATE orders SET ${statusAssignments.join(', ')} WHERE id = @orderId`
    );
    await insertOrderStatusHistory(transaction, {
      orderId,
      oldStatus: currentStatus,
      newStatus: effectiveTargetStatus,
      changedBy,
      note,
    });

    const variantSelect = hasOrderItemVariantColumn(capabilities)
      ? 'oi.product_variant_id'
      : 'NULL AS product_variant_id';
    const variantJoinClause = capabilities.hasVariants && hasOrderItemVariantColumn(capabilities)
      ? 'LEFT JOIN product_variants pv ON pv.id = oi.product_variant_id'
      : '';
    const variantMetaSelect = capabilities.hasVariants && hasOrderItemVariantColumn(capabilities)
      ? 'pv.variant_type, pv.volume_ml AS variant_volume_ml'
      : 'NULL AS variant_type, NULL AS variant_volume_ml';
    const itemTypeSelect = hasColumn(capabilities.orderItemColumns, 'item_type')
      ? 'oi.item_type'
      : "N'FULL_BOTTLE' AS item_type";
    const selectedVolumeSelect = hasColumn(capabilities.orderItemColumns, 'selected_volume_ml')
      ? 'oi.selected_volume_ml'
      : 'NULL AS selected_volume_ml';
    const sourceBatchSelect = hasColumn(capabilities.orderItemColumns, 'source_batch_id')
      ? 'oi.source_batch_id'
      : 'NULL AS source_batch_id';
    const itemRequest = new sql.Request(transaction);
    itemRequest.input('orderId', sql.Int, orderId);
    const itemResult = await itemRequest.query(
      `SELECT oi.product_id, ${variantSelect}, oi.quantity,
              ${variantMetaSelect},
              ${itemTypeSelect}, ${selectedVolumeSelect}, ${sourceBatchSelect}
       FROM order_items oi
       ${variantJoinClause}
       WHERE oi.order_id = @orderId`
    );

    const batchMovementRestoredProductIds = new Set();
    for (const item of itemResult.recordset || []) {
      const variantType = String(item.variant_type || '').toUpperCase();
      const isBatchDecantOrderItem = String(item.item_type || '').toUpperCase() === 'DECANT' && item.source_batch_id;
      const batchRestoreKey = `${orderId}:${item.product_id}`;
      const enrichedItem = {
        ...item,
        orderId,
        adminId: changedBy || null,
        skipBatchMovementRestore: isBatchDecantOrderItem && batchMovementRestoredProductIds.has(batchRestoreKey),
        isDecant: variantType === 'DECANT',
        isFullBottle: isFullBottleVariantType(variantType),
        decantVolumeMl: Number(item.variant_volume_ml) || 0,
      };
      const stock = await restoreInventory(transaction, enrichedItem, capabilities);
      if (stock?.restoredFromMovements) batchMovementRestoredProductIds.add(batchRestoreKey);
      const reservationId = await findReservationForOrderItem(transaction, orderId, enrichedItem, checkoutCapabilities);
      await releaseInventoryReservation(transaction, reservationId);
      await recordInventoryTransaction(transaction, {
        productId: enrichedItem.product_id,
        variantId: enrichedItem.product_variant_id,
        orderId,
        reservationId,
        transactionType: 'RELEASE',
        quantity: Number(item.quantity || 0),
        stockBefore: stock?.stock_before ?? null,
        stockAfter: stock?.stock_after ?? null,
        metadata: {
          reason: effectiveTargetStatus === ORDER_STATUS.REFUNDED
            ? 'order_refunded'
            : effectiveTargetStatus === ORDER_STATUS.PAYMENT_REJECTED
              ? 'payment_rejected'
              : effectiveTargetStatus === ORDER_STATUS.PAYMENT_FAILED
                ? 'payment_failed'
                : effectiveTargetStatus === ORDER_STATUS.CANCELLED_PAYMENT
                  ? 'payment_cancelled'
                  : 'order_cancelled',
        },
      });
    }

    await transaction.commit();
    try {
      await Promise.all([...new Set((itemResult.recordset || []).map((item) => item.product_id))].map((id) => invalidateProductCache(id)));
    } catch (error) {
      console.warn('Order cancelled but product cache invalidation failed:', error.message);
    }

    // Sync variant stock for decant products after cancellation
    try {
      const decantProductIds = [...new Set((itemResult.recordset || [])
        .filter((item) => {
          const variantType = String(item.variant_type || '').toUpperCase();
          return variantType === 'DECANT' ||
            isFullBottleVariantType(variantType) ||
            String(item.item_type || '').toUpperCase() === 'DECANT';
        })
        .map((item) => item.product_id))];
      if (decantProductIds.length > 0) {
        await Promise.all(decantProductIds.map((id) => syncVariantStock(id)));
      }
    } catch (error) {
      console.warn('Order cancelled but variant stock sync failed:', error.message);
    }
    return { ok: true };
  } catch (error) {
    try { await transaction.rollback(); } catch {}
    throw error;
  }
}

export async function cancelOrder(userId, orderId, note = null) {
  return releaseCancelledOrderInventory({
    orderId,
    userId,
    customerInitiated: true,
    changedBy: userId,
    note: note || 'Khách hàng hủy đơn',
  });
}

export async function cancelOrderForAdmin(orderId, options = {}) {
  return releaseCancelledOrderInventory({ orderId, ...options });
}
