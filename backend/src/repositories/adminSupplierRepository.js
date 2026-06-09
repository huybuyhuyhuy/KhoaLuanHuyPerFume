import { getDbPool, query, sql } from '../config/database.js';

let supplierSchemaReadyPromise = null;

export async function ensureSupplierSchema() {
  if (!supplierSchemaReadyPromise) {
    supplierSchemaReadyPromise = query(`
      IF OBJECT_ID(N'dbo.Suppliers', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.Suppliers (
          SupplierId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          SupplierCode NVARCHAR(30) NOT NULL,
          SupplierName NVARCHAR(255) NOT NULL,
          RepresentativeName NVARCHAR(255) NULL,
          Phone NVARCHAR(30) NOT NULL,
          Email NVARCHAR(255) NOT NULL,
          Address NVARCHAR(500) NULL,
          Note NVARCHAR(MAX) NULL,
          Status NVARCHAR(30) NOT NULL CONSTRAINT DF_Suppliers_Status DEFAULT N'ACTIVE',
          CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_Suppliers_CreatedAt DEFAULT SYSDATETIME(),
          UpdatedAt DATETIME2 NULL,
          IsDeleted BIT NOT NULL CONSTRAINT DF_Suppliers_IsDeleted DEFAULT 0
        );
      END;
      IF OBJECT_ID(N'dbo.SupplierUpdateHistory', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.SupplierUpdateHistory (
          HistoryId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          SupplierId INT NOT NULL,
          ActionType NVARCHAR(50) NOT NULL,
          OldValue NVARCHAR(MAX) NULL,
          NewValue NVARCHAR(MAX) NULL,
          UpdatedBy INT NULL,
          UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_SupplierUpdateHistory_UpdatedAt DEFAULT SYSDATETIME()
        );
      END;
      IF OBJECT_ID(N'dbo.PurchaseReceipts', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.PurchaseReceipts (
          PurchaseReceiptId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          ReceiptCode NVARCHAR(30) NOT NULL,
          SupplierId INT NOT NULL,
          ImportDate DATETIME2 NOT NULL CONSTRAINT DF_PurchaseReceipts_ImportDate DEFAULT SYSDATETIME(),
          ReceiptDate DATETIME2 NOT NULL CONSTRAINT DF_PurchaseReceipts_ReceiptDate DEFAULT SYSDATETIME(),
          TotalAmount DECIMAL(18,2) NOT NULL CONSTRAINT DF_PurchaseReceipts_TotalAmount DEFAULT 0,
          Note NVARCHAR(MAX) NULL,
          Status NVARCHAR(30) NOT NULL CONSTRAINT DF_PurchaseReceipts_Status DEFAULT N'COMPLETED',
          CreatedBy INT NULL,
          CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_PurchaseReceipts_CreatedAt DEFAULT SYSDATETIME(),
          UpdatedAt DATETIME2 NULL,
          IsDeleted BIT NOT NULL CONSTRAINT DF_PurchaseReceipts_IsDeleted DEFAULT 0
        );
      END;
      IF COL_LENGTH('dbo.PurchaseReceipts', 'ReceiptCode') IS NULL
        ALTER TABLE dbo.PurchaseReceipts ADD ReceiptCode NVARCHAR(30) NULL;
      IF COL_LENGTH('dbo.PurchaseReceipts', 'ImportDate') IS NULL
        ALTER TABLE dbo.PurchaseReceipts ADD ImportDate DATETIME2 NULL;
      IF COL_LENGTH('dbo.PurchaseReceipts', 'ReceiptDate') IS NULL
        ALTER TABLE dbo.PurchaseReceipts ADD ReceiptDate DATETIME2 NULL;
      IF COL_LENGTH('dbo.PurchaseReceipts', 'Note') IS NULL
        ALTER TABLE dbo.PurchaseReceipts ADD Note NVARCHAR(MAX) NULL;
      IF COL_LENGTH('dbo.PurchaseReceipts', 'CreatedBy') IS NULL
        ALTER TABLE dbo.PurchaseReceipts ADD CreatedBy INT NULL;
      IF COL_LENGTH('dbo.PurchaseReceipts', 'CreatedAt') IS NULL
        ALTER TABLE dbo.PurchaseReceipts ADD CreatedAt DATETIME2 NULL;
      IF COL_LENGTH('dbo.PurchaseReceipts', 'UpdatedAt') IS NULL
        ALTER TABLE dbo.PurchaseReceipts ADD UpdatedAt DATETIME2 NULL;
      UPDATE dbo.PurchaseReceipts
      SET ImportDate = COALESCE(ImportDate, ReceiptDate, SYSDATETIME()),
          ReceiptDate = COALESCE(ReceiptDate, ImportDate, SYSDATETIME()),
          CreatedAt = COALESCE(CreatedAt, ReceiptDate, ImportDate, SYSDATETIME()),
          ReceiptCode = COALESCE(NULLIF(ReceiptCode, N''), CONCAT(N'PN', RIGHT(CONCAT(N'0000', PurchaseReceiptId), 4)));
    `);
    supplierSchemaReadyPromise = supplierSchemaReadyPromise.catch((error) => {
      supplierSchemaReadyPromise = null;
      throw error;
    });
  }
  return supplierSchemaReadyPromise;
}

function mapSupplier(row = {}) {
  return {
    supplierId: Number(row.SupplierId ?? row.supplierId ?? 0),
    supplierCode: row.SupplierCode ?? row.supplierCode ?? '',
    supplierName: row.SupplierName ?? row.supplierName ?? '',
    representativeName: row.RepresentativeName ?? row.representativeName ?? '',
    phone: row.Phone ?? row.phone ?? '',
    email: row.Email ?? row.email ?? '',
    address: row.Address ?? row.address ?? '',
    note: row.Note ?? row.note ?? '',
    status: row.Status ?? row.status ?? 'ACTIVE',
    createdAt: row.CreatedAt ?? row.createdAt ?? null,
    updatedAt: row.UpdatedAt ?? row.updatedAt ?? null,
    totalReceipts: Number(row.TotalReceipts ?? row.totalReceipts ?? 0),
    totalImportValue: Number(row.TotalImportValue ?? row.totalImportValue ?? 0),
    lastImportDate: row.LastImportDate ?? row.lastImportDate ?? null,
  };
}

function mapHistory(row = {}) {
  return {
    historyId: Number(row.HistoryId ?? 0),
    supplierId: Number(row.SupplierId ?? 0),
    actionType: row.ActionType || '',
    oldValue: row.OldValue || null,
    newValue: row.NewValue || null,
    updatedBy: row.UpdatedBy || null,
    updatedAt: row.UpdatedAt || null,
    updatedByName: row.UpdatedByName || '',
  };
}

function safeJson(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildWhere({ search = '', status = '' } = {}) {
  const conditions = ['s.IsDeleted = 0'];
  const params = [];

  if (search) {
    conditions.push('(s.SupplierName LIKE ? OR s.Phone LIKE ? OR s.Email LIKE ? OR s.SupplierCode LIKE ?)');
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern, pattern);
  }

  if (status && String(status).toUpperCase() !== 'ALL') {
    conditions.push('s.Status = ?');
    params.push(String(status).toUpperCase());
  }

  return { whereSql: `WHERE ${conditions.join(' AND ')}`, params };
}

function sortExpression(sortBy = 'CreatedAt', sortOrder = 'desc') {
  const safeSortBy = String(sortBy || '').toLowerCase();
  const safeSortOrder = String(sortOrder || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const column = safeSortBy === 'suppliername' ? 's.SupplierName' : 's.CreatedAt';
  return `${column} ${safeSortOrder}, s.SupplierId DESC`;
}

export async function listSuppliers({ search = '', status = '', sortBy = 'CreatedAt', sortOrder = 'desc', page = 1, pageSize = 10 } = {}) {
  await ensureSupplierSchema();
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const offset = (safePage - 1) * safePageSize;
  const { whereSql, params } = buildWhere({ search, status });

  const totalRows = await query(
    `SELECT COUNT(*) AS total
     FROM dbo.Suppliers s
     ${whereSql}`,
    params
  );

  const rows = await query(
    `SELECT s.SupplierId, s.SupplierCode, s.SupplierName, s.RepresentativeName,
            s.Phone, s.Email, s.Address, s.Note, s.Status, s.CreatedAt, s.UpdatedAt,
            receiptStats.TotalReceipts, receiptStats.TotalImportValue, receiptStats.LastImportDate
     FROM dbo.Suppliers s
     OUTER APPLY (
       SELECT COUNT(*) AS TotalReceipts,
              COALESCE(SUM(CASE WHEN pr.Status = N'COMPLETED' THEN pr.TotalAmount ELSE 0 END), 0) AS TotalImportValue,
              MAX(CASE WHEN pr.Status = N'COMPLETED' THEN COALESCE(pr.ImportDate, pr.ReceiptDate) ELSE NULL END) AS LastImportDate
       FROM dbo.PurchaseReceipts pr
       WHERE pr.SupplierId = s.SupplierId AND pr.IsDeleted = 0
     ) receiptStats
     ${whereSql}
     ORDER BY ${sortExpression(sortBy, sortOrder)}
     OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
    [...params, offset, safePageSize]
  );

  const totalItems = Number(totalRows[0]?.total || 0);
  return {
    items: rows.map(mapSupplier),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / safePageSize)),
    },
  };
}

export async function listSuppliersForExport(filters = {}) {
  await ensureSupplierSchema();
  const { whereSql, params } = buildWhere(filters);
  const rows = await query(
    `SELECT s.SupplierId, s.SupplierCode, s.SupplierName, s.RepresentativeName,
            s.Phone, s.Email, s.Address, s.Note, s.Status, s.CreatedAt, s.UpdatedAt,
            receiptStats.TotalReceipts, receiptStats.TotalImportValue, receiptStats.LastImportDate
     FROM dbo.Suppliers s
     OUTER APPLY (
       SELECT COUNT(*) AS TotalReceipts,
              COALESCE(SUM(CASE WHEN pr.Status = N'COMPLETED' THEN pr.TotalAmount ELSE 0 END), 0) AS TotalImportValue,
              MAX(CASE WHEN pr.Status = N'COMPLETED' THEN COALESCE(pr.ImportDate, pr.ReceiptDate) ELSE NULL END) AS LastImportDate
       FROM dbo.PurchaseReceipts pr
       WHERE pr.SupplierId = s.SupplierId AND pr.IsDeleted = 0
     ) receiptStats
     ${whereSql}
     ORDER BY ${sortExpression(filters.sortBy, filters.sortOrder)}`,
    params
  );
  return rows.map(mapSupplier);
}

export async function getSupplierById(id) {
  await ensureSupplierSchema();
  const rows = await query(
    `SELECT TOP 1 SupplierId, SupplierCode, SupplierName, RepresentativeName,
            Phone, Email, Address, Note, Status, CreatedAt, UpdatedAt
     FROM dbo.Suppliers
     WHERE SupplierId = ? AND IsDeleted = 0`,
    [id]
  );
  return rows[0] ? mapSupplier(rows[0]) : null;
}

export async function getSupplierDetail(id) {
  await ensureSupplierSchema();
  const supplier = await getSupplierById(id);
  if (!supplier) return null;

  const [summaryRows, historyRows] = await Promise.all([
    query(
      `SELECT COUNT(*) AS totalReceipts,
              COALESCE(SUM(CASE WHEN IsDeleted = 0 AND Status = N'COMPLETED' THEN TotalAmount ELSE 0 END), 0) AS totalImportValue,
              MAX(CASE WHEN IsDeleted = 0 AND Status = N'COMPLETED' THEN COALESCE(ImportDate, ReceiptDate) ELSE NULL END) AS lastImportDate
       FROM dbo.PurchaseReceipts
       WHERE SupplierId = ? AND IsDeleted = 0`,
      [id]
    ),
    query(
      `SELECT TOP 20 h.HistoryId, h.SupplierId, h.ActionType, h.OldValue, h.NewValue,
              h.UpdatedBy, h.UpdatedAt, COALESCE(u.name, '') AS UpdatedByName
       FROM dbo.SupplierUpdateHistory h
       LEFT JOIN dbo.users u ON u.id = h.UpdatedBy
       WHERE h.SupplierId = ?
       ORDER BY h.UpdatedAt DESC, h.HistoryId DESC`,
      [id]
    ),
  ]);

  const summary = summaryRows[0] || {};
  return {
    supplier,
    summary: {
      totalReceipts: Number(summary.totalReceipts || 0),
      totalImportValue: Number(summary.totalImportValue || 0),
      lastImportDate: summary.lastImportDate || null,
    },
    histories: historyRows.map(mapHistory),
  };
}

export async function findSupplierByEmail(email, excludeId = null) {
  await ensureSupplierSchema();
  const params = [email];
  const excludeSql = excludeId ? 'AND SupplierId <> ?' : '';
  if (excludeId) params.push(excludeId);
  const rows = await query(
    `SELECT TOP 1 SupplierId, SupplierCode, SupplierName, Email
     FROM dbo.Suppliers
     WHERE Email = ? AND IsDeleted = 0 ${excludeSql}`,
    params
  );
  return rows[0] || null;
}

export async function findSupplierByPhone(phone, excludeId = null) {
  await ensureSupplierSchema();
  const params = [phone];
  const excludeSql = excludeId ? 'AND SupplierId <> ?' : '';
  if (excludeId) params.push(excludeId);
  const rows = await query(
    `SELECT TOP 1 SupplierId, SupplierCode, SupplierName, Phone
     FROM dbo.Suppliers
     WHERE Phone = ? AND IsDeleted = 0 ${excludeSql}`,
    params
  );
  return rows[0] || null;
}

function nextSupplierCode(currentCode) {
  const match = String(currentCode || '').match(/(\d+)$/);
  const nextNumber = match ? Number(match[1]) + 1 : 1;
  return `NCC${String(nextNumber).padStart(4, '0')}`;
}

export async function createSupplier(data, updatedBy = null) {
  await ensureSupplierSchema();
  const pool = await getDbPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const request = new sql.Request(transaction);
    const codeResult = await request.query(
      `SELECT TOP 1 SupplierCode
       FROM dbo.Suppliers WITH (UPDLOCK, HOLDLOCK)
       WHERE SupplierCode LIKE N'NCC%'
       ORDER BY TRY_CONVERT(INT, SUBSTRING(SupplierCode, 4, 20)) DESC, SupplierId DESC`
    );
    const supplierCode = nextSupplierCode(codeResult.recordset?.[0]?.SupplierCode);

    request.input('supplierCode', sql.NVarChar(30), supplierCode);
    request.input('supplierName', sql.NVarChar(255), data.supplierName);
    request.input('representativeName', sql.NVarChar(255), data.representativeName || null);
    request.input('phone', sql.NVarChar(30), data.phone);
    request.input('email', sql.NVarChar(255), data.email);
    request.input('address', sql.NVarChar(500), data.address || null);
    request.input('note', sql.NVarChar(4000), data.note || null);
    request.input('status', sql.NVarChar(30), data.status || 'ACTIVE');
    request.input('updatedBy', sql.Int, updatedBy || null);

    const insertResult = await request.query(
      `INSERT INTO dbo.Suppliers
       (SupplierCode, SupplierName, RepresentativeName, Phone, Email, Address, Note, Status)
       OUTPUT inserted.SupplierId AS SupplierId
       VALUES (@supplierCode, @supplierName, @representativeName, @phone, @email, @address, @note, @status)`
    );
    const supplierId = insertResult.recordset?.[0]?.SupplierId;
    const newValue = { ...data, supplierCode };
    request.input('supplierId', sql.Int, supplierId);
    request.input('actionType', sql.NVarChar(50), 'CREATE');
    request.input('oldValue', sql.NVarChar(4000), null);
    request.input('newValue', sql.NVarChar(4000), safeJson(newValue));
    await request.query(
      `INSERT INTO dbo.SupplierUpdateHistory
       (SupplierId, ActionType, OldValue, NewValue, UpdatedBy)
       VALUES (@supplierId, @actionType, @oldValue, @newValue, @updatedBy)`
    );

    await transaction.commit();
    return getSupplierById(supplierId);
  } catch (error) {
    try { await transaction.rollback(); } catch {}
    throw error;
  }
}

export async function updateSupplier(id, data, updatedBy = null, actionType = 'UPDATE') {
  await ensureSupplierSchema();
  const existing = await getSupplierById(id);
  if (!existing) return null;

  await query(
    `UPDATE dbo.Suppliers
     SET SupplierName = ?,
         RepresentativeName = ?,
         Phone = ?,
         Email = ?,
         Address = ?,
         Note = ?,
         Status = ?,
         UpdatedAt = SYSDATETIME()
     WHERE SupplierId = ? AND IsDeleted = 0`,
    [
      data.supplierName,
      data.representativeName || null,
      data.phone,
      data.email,
      data.address || null,
      data.note || null,
      data.status || 'ACTIVE',
      id,
    ]
  );

  const updated = await getSupplierById(id);
  await insertSupplierHistory({
    supplierId: id,
    actionType,
    oldValue: existing,
    newValue: updated,
    updatedBy,
  });
  return updated;
}

export async function insertSupplierHistory({ supplierId, actionType, oldValue = null, newValue = null, updatedBy = null }) {
  await ensureSupplierSchema();
  await query(
    `INSERT INTO dbo.SupplierUpdateHistory
     (SupplierId, ActionType, OldValue, NewValue, UpdatedBy)
     VALUES (?, ?, ?, ?, ?)`,
    [supplierId, actionType, safeJson(oldValue), safeJson(newValue), updatedBy || null]
  );
}

export async function countSupplierReceipts(id) {
  await ensureSupplierSchema();
  const rows = await query(
    `SELECT COUNT(*) AS total
     FROM dbo.PurchaseReceipts
     WHERE SupplierId = ? AND IsDeleted = 0`,
    [id]
  );
  return Number(rows[0]?.total || 0);
}

export async function softDeleteSupplier(id, updatedBy = null) {
  await ensureSupplierSchema();
  const existing = await getSupplierById(id);
  if (!existing) return null;

  await query(
    `UPDATE dbo.Suppliers
     SET IsDeleted = 1, UpdatedAt = SYSDATETIME()
     WHERE SupplierId = ? AND IsDeleted = 0`,
    [id]
  );
  await insertSupplierHistory({
    supplierId: id,
    actionType: 'SOFT_DELETE',
    oldValue: existing,
    newValue: { ...existing, isDeleted: true },
    updatedBy,
  });
  return existing;
}

export async function getSupplierStatistics() {
  await ensureSupplierSchema();
  const [summaryRows, importSummaryRows, topRows, supplierValueRows, monthRows] = await Promise.all([
    query(
      `SELECT COUNT(*) AS totalSuppliers,
              SUM(CASE WHEN Status = N'ACTIVE' THEN 1 ELSE 0 END) AS activeSuppliers,
              SUM(CASE WHEN Status = N'INACTIVE' THEN 1 ELSE 0 END) AS inactiveSuppliers
       FROM dbo.Suppliers
       WHERE IsDeleted = 0`
    ),
    query(
      `SELECT COALESCE(SUM(TotalAmount), 0) AS totalImportValue
       FROM dbo.PurchaseReceipts
       WHERE IsDeleted = 0 AND Status = N'COMPLETED'`
    ),
    query(
      `SELECT TOP 5 s.SupplierId, s.SupplierName,
              COALESCE(SUM(CASE WHEN pr.IsDeleted = 0 AND pr.Status = N'COMPLETED' THEN pr.TotalAmount ELSE 0 END), 0) AS totalImportValue
       FROM dbo.Suppliers s
       LEFT JOIN dbo.PurchaseReceipts pr ON pr.SupplierId = s.SupplierId AND pr.IsDeleted = 0
       WHERE s.IsDeleted = 0
       GROUP BY s.SupplierId, s.SupplierName
       ORDER BY totalImportValue DESC, s.SupplierName ASC`
    ),
    query(
      `SELECT s.SupplierId, s.SupplierName,
              COALESCE(SUM(CASE WHEN pr.IsDeleted = 0 AND pr.Status = N'COMPLETED' THEN pr.TotalAmount ELSE 0 END), 0) AS totalImportValue
       FROM dbo.Suppliers s
       LEFT JOIN dbo.PurchaseReceipts pr ON pr.SupplierId = s.SupplierId AND pr.IsDeleted = 0
       WHERE s.IsDeleted = 0
       GROUP BY s.SupplierId, s.SupplierName
       ORDER BY s.SupplierName ASC`
    ),
    query(
      `SELECT CONVERT(CHAR(7), COALESCE(ImportDate, ReceiptDate), 120) AS month,
              COALESCE(SUM(TotalAmount), 0) AS totalValue
       FROM dbo.PurchaseReceipts
       WHERE IsDeleted = 0 AND Status = N'COMPLETED'
         AND COALESCE(ImportDate, ReceiptDate) >= DATEADD(month, -11, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
       GROUP BY CONVERT(CHAR(7), COALESCE(ImportDate, ReceiptDate), 120)
       ORDER BY month ASC`
    ),
  ]);
  const summary = summaryRows[0] || {};
  const importSummary = importSummaryRows[0] || {};

  return {
    totalSuppliers: Number(summary.totalSuppliers || 0),
    activeSuppliers: Number(summary.activeSuppliers || 0),
    inactiveSuppliers: Number(summary.inactiveSuppliers || 0),
    totalImportValue: Number(importSummary.totalImportValue || 0),
    topSuppliersByImportValue: topRows.map((row) => ({
      supplierId: Number(row.SupplierId || 0),
      supplierName: row.SupplierName || '',
      totalImportValue: Number(row.totalImportValue || 0),
    })),
    supplierImportValues: supplierValueRows.map((row) => ({
      supplierId: Number(row.SupplierId || 0),
      supplierName: row.SupplierName || '',
      totalImportValue: Number(row.totalImportValue || 0),
    })),
    monthlyImportValues: monthRows.map((row) => ({
      month: row.month,
      totalValue: Number(row.totalValue || 0),
    })),
  };
}
