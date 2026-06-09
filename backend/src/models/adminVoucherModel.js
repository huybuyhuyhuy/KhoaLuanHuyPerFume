import { getDbPool, query, sql } from '../config/database.js';

let voucherTableReadyPromise = null;

async function ensureVoucherTable() {
  if (!voucherTableReadyPromise) {
    voucherTableReadyPromise = query(`
      IF OBJECT_ID(N'dbo.vouchers', N'U') IS NULL
      BEGIN
        EXEC(N'CREATE TABLE dbo.vouchers (
          id INT IDENTITY PRIMARY KEY,
          code NVARCHAR(50) NOT NULL UNIQUE,
          name NVARCHAR(255) NOT NULL,
          discount_type NVARCHAR(20) NOT NULL,
          discount_value FLOAT NOT NULL,
          min_order_value FLOAT NULL,
          max_discount_value FLOAT NULL,
          usage_limit INT NULL,
          used_count INT NOT NULL DEFAULT 0,
          start_at DATETIME NULL,
          end_at DATETIME NULL,
          status BIT NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT GETDATE()
        )');
      END
      IF COL_LENGTH(N'dbo.vouchers', N'code') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD code NVARCHAR(50) NULL');
      IF COL_LENGTH(N'dbo.vouchers', N'name') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD name NVARCHAR(255) NULL');
      IF COL_LENGTH(N'dbo.vouchers', N'discount_type') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD discount_type NVARCHAR(20) NULL');
      IF COL_LENGTH(N'dbo.vouchers', N'discount_value') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD discount_value FLOAT NOT NULL DEFAULT 0 WITH VALUES');
      IF COL_LENGTH(N'dbo.vouchers', N'min_order_value') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD min_order_value FLOAT NULL');
      IF COL_LENGTH(N'dbo.vouchers', N'max_discount_value') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD max_discount_value FLOAT NULL');
      IF COL_LENGTH(N'dbo.vouchers', N'usage_limit') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD usage_limit INT NULL');
      IF COL_LENGTH(N'dbo.vouchers', N'used_count') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD used_count INT NOT NULL DEFAULT 0 WITH VALUES');
      IF COL_LENGTH(N'dbo.vouchers', N'start_at') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD start_at DATETIME NULL');
      IF COL_LENGTH(N'dbo.vouchers', N'end_at') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD end_at DATETIME NULL');
      IF COL_LENGTH(N'dbo.vouchers', N'status') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD status BIT NOT NULL DEFAULT 1 WITH VALUES');
      IF COL_LENGTH(N'dbo.vouchers', N'created_at') IS NULL
        EXEC(N'ALTER TABLE dbo.vouchers ADD created_at DATETIME NOT NULL DEFAULT GETDATE() WITH VALUES');
    `);
    voucherTableReadyPromise = voucherTableReadyPromise.catch((error) => {
      voucherTableReadyPromise = null;
      throw error;
    });
  }
  return voucherTableReadyPromise;
}

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function toSqlDateTimeText(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value).trim());
  if (Number.isNaN(date.getTime())) return null;

  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('-') + ' ' + [
    padDatePart(date.getHours()),
    padDatePart(date.getMinutes()),
    padDatePart(date.getSeconds()),
  ].join(':');
}

function toClientDateTimeText(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value).trim());
  if (Number.isNaN(date.getTime())) return null;

  // SQL Server DATETIME has no timezone. msnodesqlv8 exposes its components
  // through UTC getters, so serialize those components without a trailing "Z".
  return [
    date.getUTCFullYear(),
    padDatePart(date.getUTCMonth() + 1),
    padDatePart(date.getUTCDate()),
  ].join('-') + 'T' + [
    padDatePart(date.getUTCHours()),
    padDatePart(date.getUTCMinutes()),
    padDatePart(date.getUTCSeconds()),
  ].join(':');
}

function bindVoucherPayload(request, data) {
  request.input('code', sql.NVarChar(50), data.code);
  request.input('name', sql.NVarChar(255), data.name);
  request.input('discountType', sql.NVarChar(20), data.discountType);
  request.input('discountValue', sql.Float, Number(data.discountValue));
  request.input('minOrderValue', sql.Float, data.minOrderValue ?? null);
  request.input('maxDiscountValue', sql.Float, data.maxDiscountValue ?? null);
  request.input('usageLimit', sql.Int, data.usageLimit ?? null);
  request.input('startAt', sql.NVarChar(19), toSqlDateTimeText(data.startAt));
  request.input('endAt', sql.NVarChar(19), toSqlDateTimeText(data.endAt));
  request.input('status', sql.Bit, data.status ? 1 : 0);
}

function normalizeLegacyMoneyValue(value) {
  if (value === null || value === undefined) return null;

  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;

  // Old admin form used type=number, so "500.000" was saved as 500.
  // In this shop context amount vouchers are VND values, so treat small
  // legacy amount values as thousands for backward compatibility.
  if (number > 0 && number < 1000) return number * 1000;
  return number;
}

function mapVoucher(row) {
  const discountType = String(row.discount_type || '').toUpperCase();

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    discountType: row.discount_type,
    discountValue: discountType === 'AMOUNT'
      ? normalizeLegacyMoneyValue(row.discount_value)
      : Number(row.discount_value || 0),
    minOrderValue: row.min_order_value === null ? null : normalizeLegacyMoneyValue(row.min_order_value),
    maxDiscountValue: row.max_discount_value === null ? null : normalizeLegacyMoneyValue(row.max_discount_value),
    usageLimit: row.usage_limit === null ? null : Number(row.usage_limit),
    usedCount: Number(row.used_count || 0),
    startAt: toClientDateTimeText(row.start_at),
    endAt: toClientDateTimeText(row.end_at),
    status: Boolean(row.status),
    createdAt: toClientDateTimeText(row.created_at),
  };
}

export async function listVouchers() {
  await ensureVoucherTable();
  const rows = await query('SELECT id, code, name, discount_type, discount_value, min_order_value, max_discount_value, usage_limit, used_count, start_at, end_at, status, created_at FROM vouchers ORDER BY id DESC');
  return rows.map(mapVoucher);
}

export async function getVoucherById(id) {
  await ensureVoucherTable();
  const rows = await query('SELECT TOP 1 id, code, name, discount_type, discount_value, min_order_value, max_discount_value, usage_limit, used_count, start_at, end_at, status, created_at FROM vouchers WHERE id = ?', [id]);
  return rows[0] ? mapVoucher(rows[0]) : null;
}

export async function getVoucherByCode(code) {
  await ensureVoucherTable();
  const rows = await query('SELECT TOP 1 id, code, name, discount_type, discount_value, min_order_value, max_discount_value, usage_limit, used_count, start_at, end_at, status, created_at FROM vouchers WHERE code = ? ORDER BY id DESC', [code]);
  return rows[0] ? mapVoucher(rows[0]) : null;
}

export async function createVoucher(data) {
  await ensureVoucherTable();
  const pool = await getDbPool();
  const request = pool.request();
  bindVoucherPayload(request, data);
  await request.query(
    `INSERT INTO vouchers (code, name, discount_type, discount_value, min_order_value, max_discount_value, usage_limit, start_at, end_at, status)
     VALUES (@code, @name, @discountType, @discountValue, @minOrderValue, @maxDiscountValue, @usageLimit, CONVERT(DATETIME, @startAt, 120), CONVERT(DATETIME, @endAt, 120), @status)`
  );
  return getVoucherByCode(data.code);
}

export async function updateVoucher(id, data) {
  await ensureVoucherTable();
  const pool = await getDbPool();
  const request = pool.request();
  bindVoucherPayload(request, data);
  request.input('id', sql.Int, id);
  await request.query(
    `UPDATE vouchers
     SET code = @code,
         name = @name,
         discount_type = @discountType,
         discount_value = @discountValue,
         min_order_value = @minOrderValue,
         max_discount_value = @maxDiscountValue,
         usage_limit = @usageLimit,
         start_at = CONVERT(DATETIME, @startAt, 120),
         end_at = CONVERT(DATETIME, @endAt, 120),
         status = @status
     WHERE id = @id`
  );
  return getVoucherById(id);
}

export async function patchVoucherStatus(id, status) {
  await ensureVoucherTable();
  await query('UPDATE vouchers SET status = ? WHERE id = ?', [status ? 1 : 0, id]);
  return getVoucherById(id);
}

export async function deleteVoucher(id) {
  await ensureVoucherTable();
  await query('DELETE FROM vouchers WHERE id = ?', [id]);
  return true;
}
