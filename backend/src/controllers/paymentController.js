import crypto from 'crypto';
import { errorResponse, successResponse } from '../utils/response.js';
import { query } from '../config/database.js';
import { getCheckoutStorageCapabilities, hasColumn as hasCheckoutColumn } from '../modules/checkout/checkout.storage.js';
import { ORDER_STATUS, normalizeOrderStatus } from '../constants/orderStatus.js';
import { updateOrderStatusWithHistory } from '../models/orderModel.js';
import { markCartCheckedOut } from '../models/cartModel.js';
import {
  createPaymentAttempt,
  findPaymentAttemptByExternalOrderId,
  updatePaymentAttempt,
} from '../modules/payment/paymentAttempt.repository.js';

function envValue(name, fallback = '') {
  const value = process.env[name];
  if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();

  const aliasMap = {
    MOMO_PARTNER_CODE: ['MOMO_PARTNER_CODE', 'MOMO_PARTNERCODE', 'MOMO_PARTNER_ID'],
    MOMO_ACCESS_KEY: ['MOMO_ACCESS_KEY', 'MOMO_ACCESSKEY'],
    MOMO_SECRET_KEY: ['MOMO_SECRET_KEY', 'MOMO_SECRETKEY'],
    MOMO_PARTNER_NAME: ['MOMO_PARTNER_NAME'],
    MOMO_STORE_ID: ['MOMO_STORE_ID'],
    MOMO_PAY_URL: ['MOMO_PAY_URL', 'MOMO_ENDPOINT', 'MOMO_CREATE_URL'],
    MOMO_REDIRECT_URL: ['MOMO_REDIRECT_URL'],
    MOMO_IPN_URL: ['MOMO_IPN_URL'],
    ZALOPAY_APP_ID: ['ZALOPAY_APP_ID', 'ZALOPAY_APPID', 'appid'],
    ZALOPAY_KEY1: ['ZALOPAY_KEY1', 'key1'],
    ZALOPAY_KEY2: ['ZALOPAY_KEY2', 'key2'],
    ZALOPAY_CREATE_URL: ['ZALOPAY_CREATE_URL', 'ZALOPAY_ENDPOINT'],
    ZALOPAY_QUERY_URL: ['ZALOPAY_QUERY_URL'],
    ZALOPAY_REDIRECT_URL: ['ZALOPAY_REDIRECT_URL'],
    ZALOPAY_CALLBACK_URL: ['ZALOPAY_CALLBACK_URL'],
  };

  const aliases = aliasMap[name] || [];
  for (const alias of aliases) {
    const aliasValue = process.env[alias];
    if (aliasValue !== undefined && aliasValue !== null && String(aliasValue).trim() !== '') return String(aliasValue).trim();
  }

  return String(fallback || '').trim();
}

function apiBaseUrl(req) {
  return envValue('APP_BASE_URL', `${req.protocol}://${req.get('host')}`);
}

function frontendBaseUrl(req) {
  return envValue('FRONTEND_BASE_URL', req.get('origin') || 'http://localhost:5177');
}

function hmacSha256Hex(data, secret) {
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

function signaturesMatch(received, computed) {
  const receivedBuffer = Buffer.from(String(received || ''), 'hex');
  const computedBuffer = Buffer.from(String(computed || ''), 'hex');
  return receivedBuffer.length === computedBuffer.length && crypto.timingSafeEqual(receivedBuffer, computedBuffer);
}

function validateOrderId(value) {
  const orderId = Number(value);
  return Number.isInteger(orderId) && orderId > 0 ? orderId : null;
}

function parseOrderIdFromGatewayId(value) {
  const match = String(value || '').match(/^(\d+)/);
  return match ? validateOrderId(match[1]) : null;
}

function parseOrderIdFromZaloPayAppTransId(value) {
  const [, orderId] = String(value || '').split('_');
  return validateOrderId(orderId);
}

function isConfigured(value) {
  return Boolean(value && !/^YOUR_/i.test(value));
}

function envFlag(name, fallback = false) {
  const value = envValue(name, fallback ? 'true' : 'false').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function paymentMockEnabled() {
  return envFlag('PAYMENT_MOCK_ENABLED', process.env.NODE_ENV !== 'production');
}

function paymentReturnAutoConfirmEnabled() {
  return envFlag('PAYMENT_RETURN_AUTO_CONFIRM', process.env.NODE_ENV !== 'production');
}

const MOMO_UAT_REJECTED_MESSAGE = 'Thanh toán MoMo UAT bị từ chối bởi phương thức thanh toán test. Vui lòng thử lại hoặc chọn ZaloPay/COD.';

function normalizeGatewayText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\u0110/g, 'd')
    .replace(/\u0111/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isMomoFailureMessage(message) {
  const text = normalizeGatewayText(message);
  if (!text) return false;
  return [
    'transaction rejected',
    'rejected',
    'issuer',
    'declined',
    'failed',
    'failure',
    'error',
    'tu choi',
    'khong thanh cong',
    'that bai',
    'loi',
  ].some((keyword) => text.includes(keyword));
}

function extractMomoFailureReason(data, fallback = MOMO_UAT_REJECTED_MESSAGE) {
  const reason = data?.message || data?.localMessage || data?.errorMessage || data?.subMessage || data?.description || fallback;
  return String(reason || fallback).trim().slice(0, 500);
}

function isMomoApprovedResult(data) {
  return Number(data?.resultCode ?? -1) === 0 && !isMomoFailureMessage(data?.message);
}

function isMomoRejectedResult(data) {
  return Number(data?.resultCode ?? -1) !== 0 || isMomoFailureMessage(data?.message);
}

function logMomoGatewayResponse(event, payload) {
  try {
    console.info(`[MOMO_${event}_RESPONSE]`, JSON.stringify(payload, null, 2));
  } catch {
    console.info(`[MOMO_${event}_RESPONSE]`, payload);
  }
}

function ensurePayableOrder(order, expectedPaymentMethod) {
  const status = normalizeOrderStatus(order.status);
  const paymentStatus = String(order.payment_status || '').trim().toUpperCase();
  if (paymentStatus === 'PAID' || status === ORDER_STATUS.CONFIRMED) {
    return { code: 409, message: 'Đơn hàng đã được thanh toán' };
  }
  if ([ORDER_STATUS.CANCELLED_PAYMENT, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED].includes(status) || paymentStatus === 'CANCELLED') {
    return { code: 409, message: 'Đơn hàng đã bị hủy. Vui lòng tạo đơn mới.' };
  }
  if ([ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PENDING].includes(status)) return null;
  if ([ORDER_STATUS.PAYMENT_REJECTED, ORDER_STATUS.PAYMENT_FAILED].includes(status)) {
    return { code: 409, message: 'Đơn hàng cũ đã giải phóng tồn kho. Vui lòng tạo đơn mới.' };
  }
  return { code: 409, message: 'Đơn hàng không còn chờ thanh toán. Vui lòng tạo đơn mới từ giỏ hàng.' };
}

function createMockReturnUrl(req, payment, params = {}) {
  const path = payment === 'zalopay' ? '/api/payment/zalopay/return' : '/api/payment/momo/return';
  const url = new URL(path, apiBaseUrl(req));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function createQrImageUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=10&data=${encodeURIComponent(text)}`;
}

function createMoMoQrPayload(req, paymentResponse, fallbackPaymentUrl) {
  const paymentUrl = paymentResponse?.payUrl || paymentResponse?.paymentUrl || paymentResponse?.orderUrl || paymentResponse?.deeplink || fallbackPaymentUrl || '';
  const qrUrl = paymentResponse?.qrCodeUrl || paymentResponse?.qrUrl || paymentResponse?.qrImageUrl || createQrImageUrl(paymentUrl);
  return {
    paymentUrl,
    qrUrl,
    qrCodeUrl: qrUrl,
    payUrl: paymentUrl,
    orderUrl: paymentResponse?.orderUrl || paymentUrl,
    deeplink: paymentResponse?.deeplink || '',
    rawResponse: paymentResponse,
  };
}

function requireMomoConfig() {
  const apiBase = envValue('APP_BASE_URL', 'http://localhost:4000');
  const config = {
    partnerCode: envValue('MOMO_PARTNER_CODE', envValue('MOMO_PARTNERCODE')),
    accessKey: envValue('MOMO_ACCESS_KEY', envValue('MOMO_ACCESSKEY')),
    secretKey: envValue('MOMO_SECRET_KEY', envValue('MOMO_SECRETKEY')),
    partnerName: envValue('MOMO_PARTNER_NAME', 'HuyPerfume'),
    storeId: envValue('MOMO_STORE_ID', 'HuyPerfume'),
    payUrl: envValue('MOMO_PAY_URL', envValue('MOMO_CREATE_URL', 'https://test-payment.momo.vn/v2/gateway/api/create')),
    redirectUrl: envValue('MOMO_REDIRECT_URL', `${apiBase}/api/payment/momo/return`),
    ipnUrl: envValue('MOMO_IPN_URL', `${apiBase}/api/payment/momo/ipn`),
    requestType: envValue('MOMO_REQUEST_TYPE', 'payWithATM'),
  };

  const missing = Object.entries(config).filter(([, value]) => !isConfigured(value)).map(([key]) => key);
  if (missing.length) {
    const required = ['partnerCode', 'accessKey', 'secretKey'];
    const missingRequired = missing.filter((key) => required.includes(key));
    if (!missingRequired.length) return config;
    return { code: 500, message: `Thiếu cấu hình MoMo trong .env: ${missingRequired.join(', ')}` };
  }

  return config;
}

function requireZaloPayConfig(req = null) {
  const apiBase = req ? apiBaseUrl(req) : envValue('APP_BASE_URL', 'http://localhost:4000');
  const config = {
    appId: envValue('ZALOPAY_APP_ID'),
    key1: envValue('ZALOPAY_KEY1'),
    key2: envValue('ZALOPAY_KEY2'),
    createUrl: envValue('ZALOPAY_CREATE_URL', 'https://sb-openapi.zalopay.vn/v2/create'),
    queryUrl: envValue('ZALOPAY_QUERY_URL', 'https://sb-openapi.zalopay.vn/v2/query'),
    redirectUrl: envValue('ZALOPAY_REDIRECT_URL', `${apiBase}/api/payment/zalopay/return`),
    callbackUrl: envValue('ZALOPAY_CALLBACK_URL', `${apiBase}/api/payment/zalopay/callback`),
  };
  const missing = ['appId', 'key1', 'key2'].filter((key) => !isConfigured(config[key]));
  if (missing.length) {
    return { code: 500, message: `Thiếu cấu hình ZaloPay trong .env: ${missing.join(', ')}` };
  }
  return config;
}

function paymentRedirectResponse(req, payment, status, orderId = null, extra = {}) {
  const url = new URL('/payment/return', frontendBaseUrl(req));
  url.searchParams.set('payment', payment);
  url.searchParams.set('status', status);
  if (orderId) url.searchParams.set('orderId', String(orderId));
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function redirectToFrontend(res, url) {
  return res.redirect(url);
}

async function getOrderForPayment(orderId, userId = null) {
  const { orderColumns } = await getCheckoutStorageCapabilities();
  const momoOrderSelect = hasCheckoutColumn(orderColumns, 'momo_order_id') ? 'momo_order_id' : 'NULL AS momo_order_id';
  const momoTransSelect = hasCheckoutColumn(orderColumns, 'momo_trans_id') ? 'momo_trans_id' : 'NULL AS momo_trans_id';
  const zaloPaySelect = hasCheckoutColumn(orderColumns, 'zalopay_app_trans_id') ? 'zalopay_app_trans_id' : 'NULL AS zalopay_app_trans_id';
  const paymentStatusSelect = hasCheckoutColumn(orderColumns, 'payment_status') ? 'payment_status' : 'NULL AS payment_status';
  const orderCodeSelect = hasCheckoutColumn(orderColumns, 'order_code') ? 'order_code' : 'NULL AS order_code';
  const rows = await query(
    `SELECT TOP 1 id, user_id, total, status, payment_method, ${paymentStatusSelect}, ${orderCodeSelect}, ${momoOrderSelect}, ${momoTransSelect}, ${zaloPaySelect}
     FROM orders
     WHERE id = ?${userId ? ' AND user_id = ?' : ''}`,
    userId ? [orderId, userId] : [orderId]
  );
  return rows[0] || null;
}

async function getOrderByMomoOrderId(momoOrderId) {
  const attempt = await findPaymentAttemptByExternalOrderId('MOMO', momoOrderId);
  if (attempt?.orderId) return getOrderForPayment(attempt.orderId);

  const { orderColumns } = await getCheckoutStorageCapabilities();
  if (hasCheckoutColumn(orderColumns, 'momo_order_id')) {
    const paymentStatusSelect = hasCheckoutColumn(orderColumns, 'payment_status') ? 'payment_status' : 'NULL AS payment_status';
    const orderCodeSelect = hasCheckoutColumn(orderColumns, 'order_code') ? 'order_code' : 'NULL AS order_code';
    const rows = await query(
      `SELECT TOP 1 id, user_id, total, status, payment_method, ${paymentStatusSelect}, ${orderCodeSelect}, momo_order_id,
              ${hasCheckoutColumn(orderColumns, 'momo_trans_id') ? 'momo_trans_id' : 'NULL AS momo_trans_id'},
              ${hasCheckoutColumn(orderColumns, 'zalopay_app_trans_id') ? 'zalopay_app_trans_id' : 'NULL AS zalopay_app_trans_id'}
       FROM orders
       WHERE momo_order_id = ?`,
      [momoOrderId]
    );
    if (rows[0]) return rows[0];
  }

  const orderId = parseOrderIdFromGatewayId(momoOrderId);
  return orderId ? getOrderForPayment(orderId) : null;
}

async function getOrderByZaloPayAppTransId(appTransId) {
  const attempt = await findPaymentAttemptByExternalOrderId('ZALOPAY', appTransId);
  if (attempt?.orderId) return getOrderForPayment(attempt.orderId);

  const { orderColumns } = await getCheckoutStorageCapabilities();
  if (hasCheckoutColumn(orderColumns, 'zalopay_app_trans_id')) {
    const paymentStatusSelect = hasCheckoutColumn(orderColumns, 'payment_status') ? 'payment_status' : 'NULL AS payment_status';
    const orderCodeSelect = hasCheckoutColumn(orderColumns, 'order_code') ? 'order_code' : 'NULL AS order_code';
    const rows = await query(
      `SELECT TOP 1 id, user_id, total, status, payment_method, ${paymentStatusSelect}, ${orderCodeSelect},
              ${hasCheckoutColumn(orderColumns, 'momo_order_id') ? 'momo_order_id' : 'NULL AS momo_order_id'},
              ${hasCheckoutColumn(orderColumns, 'momo_trans_id') ? 'momo_trans_id' : 'NULL AS momo_trans_id'},
              zalopay_app_trans_id
       FROM orders
       WHERE zalopay_app_trans_id = ?`,
      [appTransId]
    );
    if (rows[0]) return rows[0];
  }

  const orderId = parseOrderIdFromZaloPayAppTransId(appTransId);
  return orderId ? getOrderForPayment(orderId) : null;
}

async function updatePaidOrder({ orderId, userId = null, expectedPaymentMethod = null, momoOrderId = null, momoTransId = null, zalopayAppTransId = null }) {
  const order = await getOrderForPayment(orderId, userId);
  if (!order) return { code: 404, message: 'Không tìm thấy đơn hàng' };
  const currentStatus = normalizeOrderStatus(order.status);
  const paymentStatus = String(order.payment_status || '').trim().toUpperCase();
  if (paymentStatus === 'PAID' || currentStatus === ORDER_STATUS.CONFIRMED) {
    return { ok: true, status: currentStatus, paymentStatus: 'PAID' };
  }
  if ([ORDER_STATUS.CANCELLED_PAYMENT, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED].includes(currentStatus) || paymentStatus === 'CANCELLED') {
    return { code: 400, message: 'Đơn hàng đã bị hủy hoặc hoàn tiền' };
  }

  const { orderColumns } = await getCheckoutStorageCapabilities();
  const assignments = [];
  const params = [];

  if (expectedPaymentMethod && hasCheckoutColumn(orderColumns, 'payment_method')) {
    assignments.push('payment_method = ?');
    params.push(String(expectedPaymentMethod).toUpperCase());
  }
  if (hasCheckoutColumn(orderColumns, 'momo_order_id')) { assignments.push('momo_order_id = COALESCE(?, momo_order_id)'); params.push(momoOrderId); }
  if (hasCheckoutColumn(orderColumns, 'momo_trans_id')) { assignments.push('momo_trans_id = COALESCE(?, momo_trans_id)'); params.push(momoTransId); }
  if (hasCheckoutColumn(orderColumns, 'zalopay_app_trans_id')) { assignments.push('zalopay_app_trans_id = COALESCE(?, zalopay_app_trans_id)'); params.push(zalopayAppTransId); }
  if (hasCheckoutColumn(orderColumns, 'payment_status')) { assignments.push("payment_status = N'PAID'"); }
  if (hasCheckoutColumn(orderColumns, 'failure_reason')) { assignments.push('failure_reason = NULL'); }

  if (assignments.length) {
    params.push(orderId);
    await query(`UPDATE orders SET ${assignments.join(', ')} WHERE id = ?`, params);
  }
  if ([ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PENDING].includes(currentStatus)) {
    const result = await updateOrderStatusWithHistory({
      orderId,
      newStatus: ORDER_STATUS.CONFIRMED,
      note: `${String(order.payment_method || 'ONLINE').toUpperCase()} thanh toán thành công`,
    });
    if (result.code) return result;
    if (order.user_id) {
      await markCartCheckedOut({ type: 'user', key: order.user_id });
    }
    return { ...result, status: ORDER_STATUS.CONFIRMED };
  }
  if (currentStatus === ORDER_STATUS.CONFIRMED && order.user_id) {
    await markCartCheckedOut({ type: 'user', key: order.user_id });
  }
  return { ok: true, status: currentStatus };
}

async function rememberGatewayReference({ orderId, paymentMethod = null, momoOrderId = null, zalopayAppTransId = null, clearFailureReason = false }) {
  const { orderColumns } = await getCheckoutStorageCapabilities();
  const assignments = [];
  const params = [];
  if (paymentMethod && hasCheckoutColumn(orderColumns, 'payment_method')) { assignments.push('payment_method = ?'); params.push(String(paymentMethod).toUpperCase()); }
  if (momoOrderId && hasCheckoutColumn(orderColumns, 'momo_order_id')) { assignments.push('momo_order_id = ?'); params.push(momoOrderId); }
  if (zalopayAppTransId && hasCheckoutColumn(orderColumns, 'zalopay_app_trans_id')) { assignments.push('zalopay_app_trans_id = ?'); params.push(zalopayAppTransId); }
  if (hasCheckoutColumn(orderColumns, 'payment_status')) { assignments.push("payment_status = N'PENDING'"); }
  if (clearFailureReason && hasCheckoutColumn(orderColumns, 'failure_reason')) { assignments.push('failure_reason = NULL'); }
  if (!assignments.length) return;
  params.push(orderId);
  await query(`UPDATE orders SET ${assignments.join(', ')} WHERE id = ?`, params);
}

async function rememberPaymentFailure({ orderId, failureReason = null }) {
  const reason = String(failureReason || '').trim().slice(0, 500);
  if (!orderId || !reason) return;
  const { orderColumns } = await getCheckoutStorageCapabilities();
  if (!hasCheckoutColumn(orderColumns, 'failure_reason')) return;
  await query('UPDATE orders SET failure_reason = ? WHERE id = ?', [reason, orderId]);
}

async function queryZaloPayOrder(config, appTransId) {
  const macData = `${config.appId}|${appTransId}|${config.key1}`;
  const form = new URLSearchParams({
    app_id: String(config.appId),
    app_trans_id: appTransId,
    mac: hmacSha256Hex(macData, config.key1),
  });

  const response = await fetch(config.queryUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, status: 'pending', body };
  }

  const returnCode = Number(body.return_code || 0);
  if (returnCode === 1) return { ok: true, status: 'success', body };
  if (returnCode === 3 || body.is_processing === true) return { ok: true, status: 'pending', body };
  return { ok: true, status: 'failed', body };
}

function zaloPayReturnStatus(resultCode) {
  const raw = String(resultCode ?? '').trim().toLowerCase();
  if (['success', 'succeeded', 'paid', 'ok'].includes(raw)) return 'success';
  if (['pending', 'processing'].includes(raw)) return 'pending';
  if (['cancel', 'cancelled', 'canceled'].includes(raw)) return 'cancel';
  if (['fail', 'failed', 'failure', 'error', 'rejected'].includes(raw)) return 'failed';

  const code = Number(raw);
  if ([0, 1].includes(code)) return 'success';
  if (code === 3) return 'pending';
  if ([-49, 2, 4, 6, 7, 8, 9].includes(code)) return 'cancel';
  return 'failed';
}

async function markPaymentNotPaidOrder({
  orderId,
  expectedPaymentMethod,
  targetStatus,
  momoOrderId = null,
  zalopayAppTransId = null,
  failureReason = null,
  note = null,
}) {
  const order = await getOrderForPayment(orderId);
  if (!order) return { code: 404, message: 'Không tìm thấy đơn hàng' };

  const currentStatus = normalizeOrderStatus(order.status);
  const currentPaymentStatus = String(order.payment_status || '').trim().toUpperCase();
  if (currentPaymentStatus === 'PAID' || currentStatus === ORDER_STATUS.CONFIRMED) {
    return { ok: true, status: ORDER_STATUS.CONFIRMED, paymentStatus: 'PAID' };
  }
  if ([ORDER_STATUS.CANCELLED_PAYMENT, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED].includes(currentStatus) || currentPaymentStatus === 'CANCELLED') {
    await rememberPaymentFailure({ orderId, failureReason });
    return { code: 409, message: 'Đơn hàng đã bị hủy. Vui lòng tạo đơn mới.' };
  }

  const paymentStatus = targetStatus === ORDER_STATUS.PAYMENT_REJECTED
    ? 'PAYMENT_REJECTED'
    : targetStatus === ORDER_STATUS.CANCELLED_PAYMENT
      ? 'PAYMENT_CANCELLED'
      : 'PAYMENT_FAILED';

  await rememberGatewayReference({ orderId, paymentMethod: expectedPaymentMethod, momoOrderId, zalopayAppTransId });
  await rememberPaymentFailure({ orderId, failureReason });

  const { orderColumns } = await getCheckoutStorageCapabilities();
  const assignments = [];
  const params = [];
  if (hasCheckoutColumn(orderColumns, 'payment_status')) {
    assignments.push('payment_status = ?');
    params.push(paymentStatus);
  }
  if (hasCheckoutColumn(orderColumns, 'failure_reason')) {
    assignments.push('failure_reason = ?');
    params.push(String(failureReason || note || '').slice(0, 500));
  }
  if (!assignments.length && ![ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PENDING].includes(currentStatus)) {
    assignments.push('status = ?');
    params.push(targetStatus);
  }
  if (assignments.length) {
    params.push(orderId);
    await query(`UPDATE orders SET ${assignments.join(', ')} WHERE id = ?`, params);
  }
  return { ok: true, status: currentStatus, paymentStatus };
}

function momoResultSignaturePayload(data, accessKey) {
  return [
    `accessKey=${accessKey}`,
    `amount=${data.amount || ''}`,
    `extraData=${data.extraData || ''}`,
    `message=${data.message || ''}`,
    `orderId=${data.orderId || ''}`,
    `orderInfo=${data.orderInfo || ''}`,
    `orderType=${data.orderType || ''}`,
    `partnerCode=${data.partnerCode || ''}`,
    `payType=${data.payType || ''}`,
    `requestId=${data.requestId || ''}`,
    `responseTime=${data.responseTime || ''}`,
    `resultCode=${data.resultCode || ''}`,
    `transId=${data.transId || ''}`,
  ].join('&');
}

function expectedMomoAmount(order) {
  return Math.max(Math.round(Number(order.total || 0)), 10000);
}

function validateMomoResultPayload(data, credentials, order) {
  if (String(data.partnerCode || '') !== credentials.partnerCode) {
    return { ok: false, message: 'MoMo partnerCode không hợp lệ' };
  }

  const receivedSignature = String(data.signature || '');
  const computedSignature = hmacSha256Hex(momoResultSignaturePayload(data, credentials.accessKey), credentials.secretKey);
  if (!receivedSignature || !signaturesMatch(receivedSignature, computedSignature)) {
    return { ok: false, message: 'Chữ ký MoMo không hợp lệ' };
  }

  if (order.momo_order_id && String(data.orderId || '') !== String(order.momo_order_id)) {
    return { ok: false, message: 'MoMo orderId không khớp đơn hàng' };
  }

  if (Number(data.amount || 0) !== expectedMomoAmount(order)) {
    return { ok: false, message: 'Số tiền MoMo không khớp đơn hàng' };
  }

  if (isMomoApprovedResult(data) && !String(data.transId || '').trim()) {
    return { ok: false, message: 'MoMo transId không hợp lệ' };
  }

  return { ok: true };
}

export async function createMomo(req, res) {
  try {
    const orderId = validateOrderId(req.body?.orderId);
    if (!orderId) return errorResponse(res, 400, 'orderId không hợp lệ');

    const order = await getOrderForPayment(orderId, req.user?.id || null);
    if (!order) return errorResponse(res, 404, 'Không tìm thấy đơn hàng');
    const payableError = ensurePayableOrder(order, 'MOMO');
    if (payableError) return errorResponse(res, payableError.code, payableError.message);

    const credentials = requireMomoConfig();
    if (credentials.code) {
      if (!paymentMockEnabled()) return errorResponse(res, credentials.code, credentials.message);

      const amountNumber = Math.max(Math.round(Number(order.total || 0)), 10000);
      const attempt = await createPaymentAttempt({ orderId, provider: 'MOMO', amount: amountNumber });
      const momoOrderId = attempt.requestId;
      await rememberGatewayReference({ orderId, paymentMethod: 'MOMO', momoOrderId, clearFailureReason: true });
      const payUrl = createMockReturnUrl(req, 'momo', { orderId: momoOrderId, resultCode: 0, mock: 1 });
      const failUrl = createMockReturnUrl(req, 'momo', { orderId: momoOrderId, resultCode: 1006, mock: 1 });
      const cancelUrl = createMockReturnUrl(req, 'momo', { orderId: momoOrderId, resultCode: 7004, mock: 1 });
      await updatePaymentAttempt(attempt.id, {
        externalOrderId: momoOrderId,
        status: 'PENDING',
        payUrl,
        rawResponse: JSON.stringify({ mock: true, payUrl, failUrl, cancelUrl }),
      });
      return successResponse(res, 'Tạo thanh toán MoMo demo thành công', {
        orderId,
        orderCode: order.order_code || `#${orderId}`,
        paymentAttemptId: attempt.id,
        paymentRequestId: attempt.requestId,
        attemptNumber: attempt.attemptNumber,
        momoOrderId,
        ...createMoMoQrPayload(req, { payUrl, qrUrl: payUrl }, payUrl),
        mock: true,
        mockFailUrl: failUrl,
        mockCancelUrl: cancelUrl,
      });
    }

    const amountNumber = Math.max(Math.round(Number(order.total || 0)), 10000);
    const attempt = await createPaymentAttempt({ orderId, provider: 'MOMO', amount: amountNumber });
    const requestId = attempt.requestId;
    const momoOrderId = attempt.requestId;
    const orderInfo = `Thanh toan don hang #${orderId}`;
    const amount = String(amountNumber);
    const requestType = credentials.requestType || 'payWithATM';

    const rawSignature = [
      `accessKey=${credentials.accessKey}`,
      `amount=${amount}`,
      `extraData=`,
      `ipnUrl=${credentials.ipnUrl}`,
      `orderId=${momoOrderId}`,
      `orderInfo=${orderInfo}`,
      `partnerCode=${credentials.partnerCode}`,
      `redirectUrl=${credentials.redirectUrl}`,
      `requestId=${requestId}`,
      `requestType=${requestType}`,
    ].join('&');

    const payload = {
      partnerCode: credentials.partnerCode,
      partnerName: credentials.partnerName,
      storeName: credentials.partnerName,
      storeId: credentials.storeId,
      requestId,
      amount: amountNumber,
      orderId: momoOrderId,
      orderInfo,
      redirectUrl: credentials.redirectUrl,
      ipnUrl: credentials.ipnUrl,
      lang: 'vi',
      requestType,
      autoCapture: true,
      extraData: '',
      signature: hmacSha256Hex(rawSignature, credentials.secretKey),
    };

    await rememberGatewayReference({ orderId, paymentMethod: 'MOMO', momoOrderId, clearFailureReason: true });
    const momoResponse = await fetch(credentials.payUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const momoBody = await momoResponse.json().catch(() => ({}));
    logMomoGatewayResponse('CREATE', {
      httpStatus: momoResponse.status,
      orderId,
      momoOrderId,
      requestId,
      response: momoBody,
    });
    const payUrl = momoBody.payUrl || momoBody.deeplink || momoBody.qrCodeUrl || momoBody.qrUrl || '';
    if (!momoResponse.ok || !payUrl || isMomoRejectedResult(momoBody)) {
      const failureReason = extractMomoFailureReason(momoBody, 'MoMo UAT không trả về link thanh toán hợp lệ');
      await updatePaymentAttempt(attempt.id, {
        externalOrderId: momoOrderId,
        status: 'PAYMENT_REJECTED',
        resultCode: momoBody.resultCode,
        message: failureReason,
        payUrl,
        rawResponse: JSON.stringify(momoBody),
      });
      await markPaymentNotPaidOrder({
        orderId,
        expectedPaymentMethod: 'MOMO',
        targetStatus: ORDER_STATUS.PAYMENT_REJECTED,
        momoOrderId,
        failureReason,
        note: failureReason,
      });
      return errorResponse(res, 409, MOMO_UAT_REJECTED_MESSAGE, {
        gateway: 'MOMO',
        status: 'PAYMENT_REJECTED',
        paymentAttemptId: attempt.id,
        paymentRequestId: attempt.requestId,
        attemptNumber: attempt.attemptNumber,
        resultCode: momoBody.resultCode,
        failureReason,
        momoResponse: momoBody,
      });
    }
    await updatePaymentAttempt(attempt.id, {
      externalOrderId: momoOrderId,
      status: 'PENDING',
      resultCode: momoBody.resultCode,
      message: momoBody.message,
      payUrl,
      rawResponse: JSON.stringify(momoBody),
    });

    return successResponse(res, 'Tạo thanh toán MoMo thành công', {
      orderId,
      orderCode: order.order_code || `#${orderId}`,
      paymentAttemptId: attempt.id,
      paymentRequestId: attempt.requestId,
      attemptNumber: attempt.attemptNumber,
      momoOrderId,
      ...createMoMoQrPayload(req, momoBody, payUrl),
    });
  } catch (error) {
    console.error('[MOMO_CREATE_ERROR]', error);
    return errorResponse(res, 500, 'Lỗi tạo thanh toán MoMo', { detail: error.message });
  }
}

export async function momoIpn(req, res) {
  try {
    const body = req.body || {};
    logMomoGatewayResponse('IPN', body);
    const credentials = requireMomoConfig();
    if (credentials.code) return errorResponse(res, credentials.code, credentials.message);
    const receivedSignature = String(body.signature || '');
    const raw = [
      `accessKey=${credentials.accessKey}`,
      `amount=${body.amount || ''}`,
      `extraData=${body.extraData || ''}`,
      `message=${body.message || ''}`,
      `orderId=${body.orderId || ''}`,
      `orderInfo=${body.orderInfo || ''}`,
      `orderType=${body.orderType || ''}`,
      `partnerCode=${body.partnerCode || ''}`,
      `payType=${body.payType || ''}`,
      `requestId=${body.requestId || ''}`,
      `responseTime=${body.responseTime || ''}`,
      `resultCode=${body.resultCode || ''}`,
      `transId=${body.transId || ''}`,
    ].join('&');
    const computed = hmacSha256Hex(raw, credentials.secretKey);
    if (!receivedSignature || receivedSignature !== computed) return errorResponse(res, 400, 'Chữ ký MoMo không hợp lệ');

    const momoExternalOrderId = String(body.orderId || '');
    const attempt = await findPaymentAttemptByExternalOrderId('MOMO', momoExternalOrderId);
    const order = attempt?.orderId ? await getOrderForPayment(attempt.orderId) : await getOrderByMomoOrderId(momoExternalOrderId);
    if (!order) return errorResponse(res, 400, 'orderId không hợp lệ');

    const validation = validateMomoResultPayload(body, credentials, order);
    if (!validation.ok) return errorResponse(res, 400, validation.message);

    if (isMomoApprovedResult(body)) {
      const result = await updatePaidOrder({
        orderId: order.id,
        expectedPaymentMethod: 'MOMO',
        momoOrderId: momoExternalOrderId,
        momoTransId: String(body.transId || ''),
      });
      if (result.code) return errorResponse(res, result.code, result.message);
      if (attempt?.id) {
        await updatePaymentAttempt(attempt.id, {
          status: 'PAID',
          resultCode: body.resultCode,
          message: body.message,
          transactionId: body.transId,
          rawResponse: JSON.stringify(body),
        });
      }
    } else {
      const failureReason = extractMomoFailureReason(body);
      if (attempt?.id) {
        await updatePaymentAttempt(attempt.id, {
          status: 'PAYMENT_REJECTED',
          resultCode: body.resultCode,
          message: failureReason,
          transactionId: body.transId,
          rawResponse: JSON.stringify(body),
        });
      }
      const result = await markPaymentNotPaidOrder({
        orderId: order.id,
        expectedPaymentMethod: 'MOMO',
        targetStatus: ORDER_STATUS.PAYMENT_REJECTED,
        momoOrderId: momoExternalOrderId,
        failureReason,
        note: failureReason,
      });
      if (result.code) return errorResponse(res, result.code, result.message);
    }
    return res.status(204).send();
  } catch (error) {
    console.error('[MOMO_IPN_ERROR]', error);
    return errorResponse(res, 400, 'Dữ liệu IPN không đúng định dạng');
  }
}

export async function momoReturn(req, res) {
  try {
    const resultCode = Number(req.query.resultCode || -1);
    const momoOrderId = String(req.query.orderId || '');
    const momoReturnPayload = { ...req.query, resultCode };
    logMomoGatewayResponse('RETURN', momoReturnPayload);
    const attempt = await findPaymentAttemptByExternalOrderId('MOMO', momoOrderId);
    const order = attempt?.orderId ? await getOrderForPayment(attempt.orderId) : await getOrderByMomoOrderId(momoOrderId);
    if (!order) return redirectToFrontend(res, paymentRedirectResponse(req, 'momo', 'rejected', null, { resultCode }));

    let status = isMomoApprovedResult(momoReturnPayload) ? 'success' : 'rejected';
    let failureReason = null;
    if (status === 'success') {
      if (paymentReturnAutoConfirmEnabled() || String(req.query.mock || '') === '1') {
        await updatePaidOrder({
          orderId: order.id,
          expectedPaymentMethod: 'MOMO',
          momoOrderId,
          momoTransId: String(req.query.transId || ''),
        });
      }
      if (attempt?.id) {
        await updatePaymentAttempt(attempt.id, {
          status: 'PAID',
          resultCode,
          message: String(req.query.message || ''),
          transactionId: String(req.query.transId || ''),
          rawResponse: JSON.stringify(momoReturnPayload),
        });
      }
      const refreshedOrder = await getOrderForPayment(order.id);
      status = normalizeOrderStatus(refreshedOrder?.status) === ORDER_STATUS.CONFIRMED ? 'success' : 'pending';
    } else {
      failureReason = extractMomoFailureReason(momoReturnPayload);
      if (attempt?.id) {
        await updatePaymentAttempt(attempt.id, {
          status: 'PAYMENT_REJECTED',
          resultCode,
          message: failureReason,
          transactionId: String(req.query.transId || ''),
          rawResponse: JSON.stringify(momoReturnPayload),
        });
      }
      const result = await markPaymentNotPaidOrder({
        orderId: order.id,
        expectedPaymentMethod: 'MOMO',
        targetStatus: ORDER_STATUS.PAYMENT_REJECTED,
        momoOrderId,
        failureReason,
        note: failureReason,
      });
      if (!result.code && result.status === ORDER_STATUS.CONFIRMED) status = 'success';
    }
    return redirectToFrontend(res, paymentRedirectResponse(req, 'momo', status, order.id, { resultCode, reason: failureReason }));
  } catch (error) {
    console.error('[MOMO_RETURN_ERROR]', error);
    return redirectToFrontend(res, paymentRedirectResponse(req, 'momo', 'error'));
  }
}

export async function createZaloPay(req, res) {
  try {
    const orderId = validateOrderId(req.body?.orderId);
    if (!orderId) return errorResponse(res, 400, 'orderId không hợp lệ');

    const order = await getOrderForPayment(orderId, req.user?.id || null);
    if (!order) return errorResponse(res, 404, 'Không tìm thấy đơn hàng');
    const payableError = ensurePayableOrder(order, 'ZALOPAY');
    if (payableError) return errorResponse(res, payableError.code, payableError.message);

    const config = requireZaloPayConfig(req);
    if (config.code) {
      if (!paymentMockEnabled()) return errorResponse(res, config.code, config.message);

      const now = new Date();
      const yymmdd = now.toISOString().slice(2, 10).replace(/-/g, '');
      const amount = Math.round(Number(order.total || 0));
      const attempt = await createPaymentAttempt({ orderId, provider: 'ZALOPAY', amount });
      const appTransId = `${yymmdd}_${attempt.requestId}`;
      await rememberGatewayReference({ orderId, paymentMethod: 'ZALOPAY', zalopayAppTransId: appTransId, clearFailureReason: true });
      const payUrl = createMockReturnUrl(req, 'zalopay', { apptransid: appTransId, resultcode: 1, mock: 1 });
      const failUrl = createMockReturnUrl(req, 'zalopay', { apptransid: appTransId, resultcode: 3, mock: 1 });
      const cancelUrl = createMockReturnUrl(req, 'zalopay', { apptransid: appTransId, resultcode: 2, mock: 1 });
      await updatePaymentAttempt(attempt.id, {
        externalOrderId: appTransId,
        status: 'PENDING',
        payUrl,
        rawResponse: JSON.stringify({ mock: true, payUrl, failUrl, cancelUrl }),
      });
      return successResponse(res, 'Tạo thanh toán ZaloPay demo thành công', {
        orderId,
        orderCode: order.order_code || `#${orderId}`,
        paymentAttemptId: attempt.id,
        paymentRequestId: attempt.requestId,
        attemptNumber: attempt.attemptNumber,
        appTransId,
        orderUrl: payUrl,
        paymentUrl: payUrl,
        mock: true,
        mockFailUrl: failUrl,
        mockCancelUrl: cancelUrl,
      });
    }

    const now = new Date();
    const yymmdd = now.toISOString().slice(2, 10).replace(/-/g, '');
    const amount = Math.round(Number(order.total || 0));
    const attempt = await createPaymentAttempt({ orderId, provider: 'ZALOPAY', amount });
    const appTransId = `${yymmdd}_${attempt.requestId}`;
    const appUser = String(req.user?.email || `user_${req.user?.id || 'guest'}`);
    const appTime = Date.now();
    const gatewayReturnUrl = new URL(config.redirectUrl);
    gatewayReturnUrl.searchParams.set('apptransid', appTransId);
    gatewayReturnUrl.searchParams.set('orderId', String(orderId));
    const embedData = JSON.stringify({ redirecturl: gatewayReturnUrl.toString() });
    const item = '[]';
    const description = `Thanh toán đơn hàng #${orderId}`;
    const macData = [config.appId, appTransId, appUser, amount, appTime, embedData, item].join('|');

    const form = new URLSearchParams({
      app_id: String(config.appId),
      app_user: appUser,
      app_time: String(appTime),
      amount: String(amount),
      app_trans_id: appTransId,
      embed_data: embedData,
      item,
      description,
      bank_code: '',
      callback_url: config.callbackUrl,
      redirect_url: gatewayReturnUrl.toString(),
      mac: hmacSha256Hex(macData, config.key1),
    });

    await rememberGatewayReference({ orderId, paymentMethod: 'ZALOPAY', zalopayAppTransId: appTransId, clearFailureReason: true });
    const response = await fetch(config.createUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    const zaloPayResponse = await response.json().catch(() => ({}));
    if (!response.ok || Number(zaloPayResponse.return_code || 0) !== 1 || !zaloPayResponse.order_url) {
      const failureReason = zaloPayResponse.return_message || zaloPayResponse.sub_return_message || 'ZaloPay không trả về link thanh toán';
      await updatePaymentAttempt(attempt.id, {
        externalOrderId: appTransId,
        status: 'PAYMENT_FAILED',
        resultCode: zaloPayResponse.return_code,
        message: failureReason,
        rawResponse: JSON.stringify(zaloPayResponse),
      });
      await markPaymentNotPaidOrder({
        orderId,
        expectedPaymentMethod: 'ZALOPAY',
        targetStatus: ORDER_STATUS.PAYMENT_FAILED,
        zalopayAppTransId: appTransId,
        failureReason,
        note: failureReason,
      });
      return errorResponse(res, 502, 'ZaloPay không trả về link thanh toán', zaloPayResponse);
    }
    await updatePaymentAttempt(attempt.id, {
      externalOrderId: appTransId,
      status: 'PENDING',
      resultCode: zaloPayResponse.return_code,
      message: zaloPayResponse.return_message,
      payUrl: zaloPayResponse.order_url,
      rawResponse: JSON.stringify(zaloPayResponse),
    });

    return successResponse(res, 'Tạo thanh toán ZaloPay thành công', {
      orderId,
      orderCode: order.order_code || `#${orderId}`,
      paymentAttemptId: attempt.id,
      paymentRequestId: attempt.requestId,
      attemptNumber: attempt.attemptNumber,
      appTransId,
      orderUrl: zaloPayResponse.order_url,
      paymentUrl: zaloPayResponse.order_url,
      zaloPayResponse,
    });
  } catch (error) {
    console.error('[ZALOPAY_CREATE_ERROR]', error);
    return errorResponse(res, 500, 'Lỗi tạo thanh toán ZaloPay', { detail: error.message });
  }
}

export async function zaloPayCallback(req, res) {
  try {
    const config = requireZaloPayConfig(req);
    if (config.code) {
      return res.json({ return_code: 0, return_message: config.message });
    }

    const dataStr = String(req.body?.data || '');
    const receivedMac = String(req.body?.mac || '');
    const computedMac = hmacSha256Hex(dataStr, config.key2);
    if (!dataStr || !receivedMac || !signaturesMatch(receivedMac, computedMac)) {
      return res.json({ return_code: -1, return_message: 'mac not equal' });
    }

    const data = JSON.parse(dataStr);
    const appTransId = String(data.app_trans_id || '');
    const attempt = await findPaymentAttemptByExternalOrderId('ZALOPAY', appTransId);
    const order = attempt?.orderId ? await getOrderForPayment(attempt.orderId) : await getOrderByZaloPayAppTransId(appTransId);
    if (!order) {
      return res.json({ return_code: 0, return_message: 'Không tìm thấy đơn hàng' });
    }

    const expectedAmount = Math.round(Number(order.total || 0));
    if (Number(data.amount || 0) !== expectedAmount) {
      return res.json({ return_code: -1, return_message: 'Số tiền ZaloPay không khớp đơn hàng' });
    }

    const result = await updatePaidOrder({
      orderId: order.id,
      expectedPaymentMethod: 'ZALOPAY',
      zalopayAppTransId: appTransId,
    });
    if (result.code) {
      return res.json({ return_code: 0, return_message: result.message });
    }
    if (attempt?.id) {
      await updatePaymentAttempt(attempt.id, {
        status: 'PAID',
        resultCode: data.status || data.return_code || 1,
        message: 'success',
        transactionId: data.zp_trans_id || data.server_time || '',
        rawResponse: dataStr,
      });
    }

    return res.json({ return_code: 1, return_message: 'success' });
  } catch (error) {
    console.error('[ZALOPAY_CALLBACK_ERROR]', error);
    return res.json({ return_code: 0, return_message: error.message || 'Lỗi xử lý callback ZaloPay' });
  }
}

export async function zaloPayReturn(req, res) {
  try {
    const appTransId = String(req.query.apptransid || req.query.app_trans_id || req.query.appTransId || '');
    const attempt = await findPaymentAttemptByExternalOrderId('ZALOPAY', appTransId);
    const order = attempt?.orderId ? await getOrderForPayment(attempt.orderId) : await getOrderByZaloPayAppTransId(appTransId);
    if (!order) return redirectToFrontend(res, paymentRedirectResponse(req, 'zalopay', 'failed'));

    const orderId = Number(order.id);
    const resultCodeRaw = req.query.resultcode ?? req.query.resultCode ?? req.query.returncode ?? req.query.return_code ?? req.query.status;
    const isMockReturn = String(req.query.mock || '') === '1';
    const returnedStatus = resultCodeRaw === undefined ? 'pending' : zaloPayReturnStatus(resultCodeRaw);
    const trustSuccessfulReturn = paymentReturnAutoConfirmEnabled() && returnedStatus === 'success';
    let status = returnedStatus;
    let verificationResponse = null;

    if (!isMockReturn) {
      const config = requireZaloPayConfig(req);
      if (!config.code) {
        try {
          const queryResult = await queryZaloPayOrder(config, appTransId);
          verificationResponse = queryResult.body || null;
          status = trustSuccessfulReturn && queryResult.status !== 'success'
            ? 'success'
            : queryResult.status;
        } catch (error) {
          verificationResponse = { error: error.message };
          if (!trustSuccessfulReturn) throw error;
          status = 'success';
        }
      }
    }

    if (status === 'success') {
      const successResultCode = verificationResponse?.return_code
        ?? verificationResponse?.status
        ?? resultCodeRaw
        ?? 1;
      const result = await updatePaidOrder({
        orderId,
        expectedPaymentMethod: 'ZALOPAY',
        zalopayAppTransId: appTransId,
      });
      if (!result.code) {
        if (attempt?.id) {
          await updatePaymentAttempt(attempt.id, {
            status: 'PAID',
            resultCode: successResultCode,
            message: 'success',
            transactionId: verificationResponse?.zp_trans_id || verificationResponse?.server_time || '',
            rawResponse: JSON.stringify({ returnQuery: req.query || {}, verificationResponse }),
          });
        }
        return redirectToFrontend(res, paymentRedirectResponse(req, 'zalopay', 'success', orderId, { resultCode: successResultCode }));
      }
      status = 'pending';
    }

    if (status === 'pending') {
      return redirectToFrontend(res, paymentRedirectResponse(req, 'zalopay', 'pending', orderId, { resultCode: resultCodeRaw }));
    }

    const result = await markPaymentNotPaidOrder({
      orderId,
      expectedPaymentMethod: 'ZALOPAY',
      targetStatus: status === 'cancel' ? ORDER_STATUS.CANCELLED_PAYMENT : ORDER_STATUS.PAYMENT_FAILED,
      zalopayAppTransId: appTransId,
      failureReason: status === 'cancel' ? 'ZaloPay thanh toán bị hủy' : 'ZaloPay thanh toán thất bại',
      note: status === 'cancel' ? 'ZaloPay thanh toán bị hủy' : 'ZaloPay thanh toán thất bại',
    });
    if (attempt?.id) {
      await updatePaymentAttempt(attempt.id, {
        status: status === 'cancel' ? 'PAYMENT_CANCELLED' : 'PAYMENT_FAILED',
        resultCode: resultCodeRaw,
        message: status === 'cancel' ? 'ZaloPay thanh toán bị hủy' : 'ZaloPay thanh toán thất bại',
        rawResponse: JSON.stringify(req.query || {}),
      });
    }
    if (!result.code && result.status === ORDER_STATUS.CONFIRMED) {
      return redirectToFrontend(res, paymentRedirectResponse(req, 'zalopay', 'success', orderId));
    }
    return redirectToFrontend(res, paymentRedirectResponse(req, 'zalopay', status, orderId, { resultCode: resultCodeRaw }));
  } catch (error) {
    console.error('[ZALOPAY_RETURN_ERROR]', error);
    return redirectToFrontend(res, paymentRedirectResponse(req, 'zalopay', 'error'));
  }
}
