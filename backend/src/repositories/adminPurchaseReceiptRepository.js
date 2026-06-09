import { getDbPool, query, sql } from '../config/database.js';
import { getProductStorageCapabilities } from '../modules/products/product.repository.js';
import { invalidateProductCache } from '../modules/products/product.service.js';

let receiptSchemaReadyPromise = null;
let receiptCapabilitiesPromise = null;

function hasColumn(columns, name) {
  return columns?.has?.(String(name).toLowerCase());
}

function columnSet(rows) {
  return new Set(rows.map((row) => String(row.COLUMN_NAME || row.column_name || '').toLowerCase()));
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
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

function mapReceiptRow(row = {}) {
  return {
    purchaseReceiptId: Number(row.PurchaseReceiptId || row.purchaseReceiptId || 0),
    receiptCode: row.ReceiptCode || row.receiptCode || '',
    supplierId: Number(row.SupplierId || row.supplierId || 0),
    supplierCode: row.SupplierCode || row.supplierCode || '',
    supplierName: row.SupplierName || row.supplierName || '',
    importDate: row.ImportDate || row.importDate || row.ReceiptDate || row.receiptDate || null,
    totalQuantity: Number(row.TotalQuantity || row.totalQuantity || 0),
    totalAmount: Number(row.TotalAmount || row.totalAmount || 0),
    note: row.Note || row.note || '',
    status: row.Status || row.status || 'COMPLETED',
    createdBy: row.CreatedBy ?? row.createdBy ?? null,
    createdByName: row.CreatedByName || row.createdByName || '',
    createdAt: row.CreatedAt || row.createdAt || null,
    updatedAt: row.UpdatedAt || row.updatedAt || null,
  };
}

function mapReceiptItem(row = {}) {
  return {
    purchaseReceiptItemId: Number(row.PurchaseReceiptItemId || 0),
    purchaseReceiptId: Number(row.PurchaseReceiptId || 0),
    productId: Number(row.ProductId || 0),
    productName: row.ProductName || '',
    productSku: row.ProductSku || '',
    variantId: row.VariantId === null || row.VariantId === undefined ? null : Number(row.VariantId),
    variantSku: row.VariantSku || '',
    variantLabel: row.VariantLabel || '',
    variantType: row.VariantType || '',
    quantity: Number(row.Quantity || 0),
    importPrice: Number(row.ImportPrice || 0),
    totalPrice: Number(row.TotalPrice || 0),
    note: row.Note || '',
    createdAt: row.CreatedAt || null,
  };
}

function sortExpression(sortBy = 'ImportDate', sortOrder = 'desc') {
  const direction = String(sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const columns = {
    receiptcode: 'pr.ReceiptCode',
    importdate: 'pr.ImportDate',
    totalamount: 'pr.TotalAmount',
    suppliername: 's.SupplierName',
    createdat: 'pr.CreatedAt',
  };
  const column = columns[String(sortBy).toLowerCase()] || 'pr.ImportDate';
  return `${column} ${direction}, pr.PurchaseReceiptId DESC`;
}

function addInput(request, name, value, type = null) {
  if (type) {
    request.input(name, type, value);
    return;
  }
  if (value === null || value === undefined) request.input(name, sql.NVarChar, null);
  else if (typeof value === 'number') request.input(name, Number.isInteger(value) ? sql.Int : sql.Decimal(18, 2), value);
  else if (value instanceof Date) request.input(name, sql.NVarChar(19), toSqlDateTimeText(value));
  else if (typeof value === 'boolean') request.input(name, sql.Bit, value ? 1 : 0);
  else request.input(name, sql.NVarChar, String(value));
}

async function txQuery(transaction, sqlText, inputs = []) {
  const request = new sql.Request(transaction);
  for (const input of inputs) {
    addInput(request, input.name, input.value, input.type || null);
  }
  return request.query(sqlText);
}
async function namedQuery(sqlText, inputs = []) {
  const pool = await getDbPool();
  const request = pool.request();

  for (const input of inputs) {
    addInput(request, input.name, input.value, input.type || null);
  }

  const result = await request.query(sqlText);
  return result.recordset || [];
}
async function getReceiptCapabilities() {
  if (!receiptCapabilitiesPromise) {
    receiptCapabilitiesPromise = (async () => {
      const [tables, inventoryColumns, userColumns] = await Promise.all([
        query(`
          SELECT TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = 'dbo'
            AND TABLE_NAME IN ('inventory_transactions', 'PurchaseReceipts', 'PurchaseReceiptItems', 'users')
        `),
        query(`
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'inventory_transactions'
        `),
        query(`
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'users'
        `),
      ]);
      const tableNames = new Set(tables.map((row) => String(row.TABLE_NAME || row.table_name || '').toLowerCase()));
      return {
        hasUsers: tableNames.has('users'),
        hasInventoryTransactions: tableNames.has('inventory_transactions'),
        inventoryColumns: columnSet(inventoryColumns),
        userColumns: columnSet(userColumns),
      };
    })();
  }
  return receiptCapabilitiesPromise;
}

function createdByJoin(capabilities) {
  return capabilities?.hasUsers ? 'LEFT JOIN dbo.users u ON u.id = pr.CreatedBy' : '';
}

function createdByNameSelect(capabilities) {
  if (!capabilities?.hasUsers) return "N'' AS CreatedByName";

  const candidates = [];
  if (hasColumn(capabilities.userColumns, 'name')) candidates.push("NULLIF(u.name, N'')");
  if (hasColumn(capabilities.userColumns, 'full_name')) candidates.push("NULLIF(u.full_name, N'')");
  if (hasColumn(capabilities.userColumns, 'email')) candidates.push("NULLIF(u.email, N'')");

  return candidates.length
    ? `COALESCE(${candidates.join(', ')}, N'') AS CreatedByName`
    : "N'' AS CreatedByName";
}

function optionalColumn(columns, columnName, expression, alias, fallback = "N''") {
  return `${hasColumn(columns, columnName) ? expression : fallback} AS ${alias}`;
}

async function invalidateChangedProductCaches(productIds) {
  const ids = [...productIds].filter(Boolean);
  if (!ids.length) return;

  try {
    await Promise.all(ids.map((productId) => invalidateProductCache(productId)));
  } catch (error) {
    console.warn('[PURCHASE_RECEIPT_CACHE_INVALIDATION_WARN]', error?.message || error);
  }
}

function buildCreatedReceiptFallback({ purchaseReceiptId, receiptCode, supplier, data, preparedItems, totalAmount, adminId }) {
  return {
    receipt: {
      purchaseReceiptId: Number(purchaseReceiptId || 0),
      receiptCode,
      supplierId: Number(data.supplierId || 0),
      supplierCode: supplier.SupplierCode || '',
      supplierName: supplier.SupplierName || '',
      importDate: data.importDate || null,
      totalQuantity: preparedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
      totalAmount: Number(totalAmount || 0),
      note: data.note || '',
      status: 'COMPLETED',
      createdBy: adminId || null,
      createdByName: '',
      createdAt: new Date().toISOString(),
      updatedAt: null,
    },
    supplier: {
      supplierId: Number(data.supplierId || 0),
      supplierCode: supplier.SupplierCode || '',
      supplierName: supplier.SupplierName || '',
      representativeName: supplier.RepresentativeName || '',
      phone: supplier.Phone || '',
      email: supplier.Email || '',
      address: supplier.Address || '',
    },
    items: preparedItems.map((item) => ({
      purchaseReceiptItemId: 0,
      purchaseReceiptId: Number(purchaseReceiptId || 0),
      productId: Number(item.productId || 0),
      productName: item.productName || '',
      productSku: '',
      variantId: item.variantId || null,
      variantSku: '',
      variantLabel: item.variantLabel || '',
      variantType: '',
      quantity: Number(item.quantity || 0),
      importPrice: Number(item.importPrice || 0),
      totalPrice: Number(item.totalPrice || 0),
      note: item.note || '',
      createdAt: null,
    })),
  };
}

async function getPurchaseReceiptByIdAfterCommit(id, fallbackFactory) {
  try {
    const detail = await getPurchaseReceiptById(id);
    if (detail) return detail;
  } catch (error) {
    console.warn('[PURCHASE_RECEIPT_POST_COMMIT_READ_WARN]', error?.message || error);
  }
  return fallbackFactory();
}

export async function ensurePurchaseReceiptSchema() {
  if (!receiptSchemaReadyPromise) {
    receiptSchemaReadyPromise = query(`
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
      IF COL_LENGTH('dbo.PurchaseReceipts', 'IsDeleted') IS NULL
        ALTER TABLE dbo.PurchaseReceipts ADD IsDeleted BIT NOT NULL CONSTRAINT DF_PurchaseReceipts_IsDeleted_Late DEFAULT 0;

      UPDATE dbo.PurchaseReceipts
      SET ImportDate = COALESCE(ImportDate, ReceiptDate, SYSDATETIME()),
          ReceiptDate = COALESCE(ReceiptDate, ImportDate, SYSDATETIME()),
          CreatedAt = COALESCE(CreatedAt, ReceiptDate, ImportDate, SYSDATETIME()),
          ReceiptCode = COALESCE(NULLIF(ReceiptCode, N''), CONCAT(N'PN', RIGHT(CONCAT(N'0000', PurchaseReceiptId), 4))),
          Status = COALESCE(NULLIF(Status, N''), N'COMPLETED');

      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_PurchaseReceipts_Code' AND object_id = OBJECT_ID(N'dbo.PurchaseReceipts'))
        CREATE UNIQUE INDEX UX_PurchaseReceipts_Code ON dbo.PurchaseReceipts(ReceiptCode);
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PurchaseReceipts_Supplier' AND object_id = OBJECT_ID(N'dbo.PurchaseReceipts'))
        CREATE INDEX IX_PurchaseReceipts_Supplier ON dbo.PurchaseReceipts(SupplierId, IsDeleted, ImportDate);

      IF OBJECT_ID(N'dbo.PurchaseReceiptItems', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.PurchaseReceiptItems (
          PurchaseReceiptItemId INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          PurchaseReceiptId INT NOT NULL,
          ProductId INT NOT NULL,
          VariantId INT NULL,
          Quantity INT NOT NULL,
          ImportPrice DECIMAL(18,2) NOT NULL,
          TotalPrice DECIMAL(18,2) NOT NULL,
          Note NVARCHAR(500) NULL,
          CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_PurchaseReceiptItems_CreatedAt DEFAULT SYSDATETIME()
        );
      END;

      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PurchaseReceiptItems_Receipt' AND object_id = OBJECT_ID(N'dbo.PurchaseReceiptItems'))
        CREATE INDEX IX_PurchaseReceiptItems_Receipt ON dbo.PurchaseReceiptItems(PurchaseReceiptId);
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PurchaseReceiptItems_Product' AND object_id = OBJECT_ID(N'dbo.PurchaseReceiptItems'))
        CREATE INDEX IX_PurchaseReceiptItems_Product ON dbo.PurchaseReceiptItems(ProductId, VariantId);

      IF OBJECT_ID(N'dbo.inventory_transactions', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.inventory_transactions (
          id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          product_id INT NOT NULL,
          variant_id INT NULL,
          product_variant_id INT NULL,
          transaction_type NVARCHAR(40) NULL,
          delta INT NULL,
          quantity INT NULL,
          stock_before INT NULL,
          stock_after INT NULL,
          reason NVARCHAR(500) NULL,
          reference_type NVARCHAR(50) NULL,
          reference_id INT NULL,
          performed_by INT NULL,
          metadata NVARCHAR(MAX) NULL,
          created_at DATETIME2 NOT NULL CONSTRAINT DF_inventory_transactions_created_at DEFAULT SYSUTCDATETIME()
        );
      END;

      IF COL_LENGTH('dbo.inventory_transactions', 'variant_id') IS NULL
        ALTER TABLE dbo.inventory_transactions ADD variant_id INT NULL;
      IF COL_LENGTH('dbo.inventory_transactions', 'product_variant_id') IS NULL
        ALTER TABLE dbo.inventory_transactions ADD product_variant_id INT NULL;
      IF COL_LENGTH('dbo.inventory_transactions', 'delta') IS NULL
        ALTER TABLE dbo.inventory_transactions ADD delta INT NULL;
      IF COL_LENGTH('dbo.inventory_transactions', 'reason') IS NULL
        ALTER TABLE dbo.inventory_transactions ADD reason NVARCHAR(500) NULL;
      IF COL_LENGTH('dbo.inventory_transactions', 'reference_type') IS NULL
        ALTER TABLE dbo.inventory_transactions ADD reference_type NVARCHAR(50) NULL;
      IF COL_LENGTH('dbo.inventory_transactions', 'reference_id') IS NULL
        ALTER TABLE dbo.inventory_transactions ADD reference_id INT NULL;
      IF COL_LENGTH('dbo.inventory_transactions', 'performed_by') IS NULL
        ALTER TABLE dbo.inventory_transactions ADD performed_by INT NULL;

      IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'CK_inventory_transactions_type')
        ALTER TABLE dbo.inventory_transactions DROP CONSTRAINT CK_inventory_transactions_type;
      IF COL_LENGTH('dbo.inventory_transactions', 'transaction_type') IS NOT NULL
        ALTER TABLE dbo.inventory_transactions WITH NOCHECK ADD CONSTRAINT CK_inventory_transactions_type
        CHECK (
          transaction_type IS NULL OR transaction_type IN (
            N'RESERVE', N'COMMIT', N'RELEASE', N'RESTORE', N'ADJUST',
            N'IMPORT', N'IMPORT_CANCEL', N'SALE', N'ORDER_CANCEL', N'ADJUSTMENT'
          )
        );
    `).then((result) => {
      receiptCapabilitiesPromise = null;
      return result;
    });
    receiptSchemaReadyPromise = receiptSchemaReadyPromise.catch((error) => {
      receiptSchemaReadyPromise = null;
      throw error;
    });
  }
  return receiptSchemaReadyPromise;
}

function nextReceiptCode(currentCode) {
  const match = String(currentCode || '').match(/(\d+)$/);
  const nextNumber = match ? Number(match[1]) + 1 : 1;
  return `PN${String(nextNumber).padStart(4, '0')}`;
}

function productStockColumn(capabilities) {
  if (hasColumn(capabilities.productColumns, 'stock')) return 'stock';
  if (hasColumn(capabilities.productColumns, 'quantity')) return 'quantity';
  return null;
}

function activeProductFilter(capabilities, alias = 'p') {
  return hasColumn(capabilities.productColumns, 'deleted_at') ? ` AND ${alias}.deleted_at IS NULL` : '';
}

function activeVariantFilter(capabilities, alias = 'pv') {
  const filters = [];
  if (hasColumn(capabilities.variantColumns, 'deleted_at')) filters.push(`${alias}.deleted_at IS NULL`);
  if (hasColumn(capabilities.variantColumns, 'status')) filters.push(`ISNULL(${alias}.status, 1) = 1`);
  return filters.length ? ` AND ${filters.join(' AND ')}` : '';
}

function importableVariantFilter(capabilities, alias = 'pv') {
  if (!hasColumn(capabilities.variantColumns, 'variant_type')) return '';
  return ` AND UPPER(ISNULL(${alias}.variant_type, N'FULL')) <> N'DECANT'`;
}

async function getSupplierForReceipt(transaction, supplierId) {
  const result = await txQuery(
    transaction,
    `SELECT TOP 1 SupplierId, SupplierName, Status
     FROM dbo.Suppliers WITH (UPDLOCK, HOLDLOCK)
     WHERE SupplierId = @supplierId AND IsDeleted = 0`,
    [{ name: 'supplierId', value: supplierId, type: sql.Int }]
  );
  return result.recordset?.[0] || null;
}

async function getProductForReceipt(transaction, productId, capabilities) {
  const stockColumn = productStockColumn(capabilities);
  const stockSelect = stockColumn ? `p.${stockColumn}` : '0';

  const result = await txQuery(
    transaction,
    `SELECT TOP 1 p.id, p.name, ${stockSelect} AS stock
     FROM dbo.products p WITH (UPDLOCK, HOLDLOCK)
     WHERE p.id = @productId${activeProductFilter(capabilities, 'p')}`,
    [{ name: 'productId', value: productId, type: sql.Int }]
  );
  return result.recordset?.[0] || null;
}

async function getVariantForReceipt(transaction, productId, variantId, capabilities) {
  if (!variantId) return null;
  if (!capabilities.hasVariants || !hasColumn(capabilities.variantColumns, 'stock_quantity')) {
    throw new Error('Schema chưa hỗ trợ tồn kho biến thể.');
  }

  const labelSelect = hasColumn(capabilities.variantColumns, 'volume_label') ? 'pv.volume_label' : 'NULL';
  const typeSelect = hasColumn(capabilities.variantColumns, 'variant_type') ? 'pv.variant_type' : 'NULL';
  const result = await txQuery(
    transaction,
    `SELECT TOP 1 pv.id, pv.product_id, pv.stock_quantity, ${labelSelect} AS volume_label, ${typeSelect} AS variant_type
     FROM dbo.product_variants pv WITH (UPDLOCK, HOLDLOCK)
     WHERE pv.id = @variantId AND pv.product_id = @productId${activeVariantFilter(capabilities, 'pv')}${importableVariantFilter(capabilities, 'pv')}`,
    [
      { name: 'variantId', value: variantId, type: sql.Int },
      { name: 'productId', value: productId, type: sql.Int },
    ]
  );
  return result.recordset?.[0] || null;
}

async function increaseStock(transaction, item, capabilities) {
  if (item.variantId) {
    const updatedAt = hasColumn(capabilities.variantColumns, 'updated_at') ? ', updated_at = SYSDATETIME()' : '';
    const result = await txQuery(
      transaction,
      `UPDATE dbo.product_variants
       SET stock_quantity = stock_quantity + @quantity${updatedAt}
       OUTPUT deleted.stock_quantity AS stock_before, inserted.stock_quantity AS stock_after
       WHERE id = @variantId AND product_id = @productId`,
      [
        { name: 'quantity', value: item.quantity, type: sql.Int },
        { name: 'variantId', value: item.variantId, type: sql.Int },
        { name: 'productId', value: item.productId, type: sql.Int },
      ]
    );
    const variantStock = result.recordset?.[0] || null;
    if (!variantStock) return null;

    const stockColumn = productStockColumn(capabilities);
    if (stockColumn) {
      const updates = [`${stockColumn} = ${stockColumn} + @quantity`];
      if (stockColumn !== 'stock' && hasColumn(capabilities.productColumns, 'stock')) updates.push('stock = stock + @quantity');
      if (stockColumn !== 'quantity' && hasColumn(capabilities.productColumns, 'quantity')) updates.push('quantity = quantity + @quantity');
      if (hasColumn(capabilities.productColumns, 'updated_at')) updates.push('updated_at = SYSDATETIME()');
      await txQuery(
        transaction,
        `UPDATE dbo.products
         SET ${updates.join(', ')}
         WHERE id = @productId`,
        [
          { name: 'quantity', value: item.quantity, type: sql.Int },
          { name: 'productId', value: item.productId, type: sql.Int },
        ]
      );
    }
    return variantStock;
  }

  const stockColumn = productStockColumn(capabilities);
  if (!stockColumn) {
    throw new Error('Schema products chưa có cột tồn kho.');
  }
  const updates = [`${stockColumn} = ${stockColumn} + @quantity`];
  if (stockColumn !== 'stock' && hasColumn(capabilities.productColumns, 'stock')) updates.push('stock = stock + @quantity');
  if (stockColumn !== 'quantity' && hasColumn(capabilities.productColumns, 'quantity')) updates.push('quantity = quantity + @quantity');
  if (hasColumn(capabilities.productColumns, 'updated_at')) updates.push('updated_at = SYSDATETIME()');

  const result = await txQuery(
    transaction,
    `UPDATE dbo.products
     SET ${updates.join(', ')}
     OUTPUT deleted.${stockColumn} AS stock_before, inserted.${stockColumn} AS stock_after
     WHERE id = @productId`,
    [
      { name: 'quantity', value: item.quantity, type: sql.Int },
      { name: 'productId', value: item.productId, type: sql.Int },
    ]
  );
  return result.recordset?.[0] || null;
}

async function decreaseStock(transaction, item, capabilities) {
  if (item.variantId) {
    const updatedAt = hasColumn(capabilities.variantColumns, 'updated_at') ? ', updated_at = SYSDATETIME()' : '';
    const result = await txQuery(
      transaction,
      `UPDATE dbo.product_variants
       SET stock_quantity = stock_quantity - @quantity${updatedAt}
       OUTPUT deleted.stock_quantity AS stock_before, inserted.stock_quantity AS stock_after
       WHERE id = @variantId AND product_id = @productId AND stock_quantity >= @quantity`,
      [
        { name: 'quantity', value: item.quantity, type: sql.Int },
        { name: 'variantId', value: item.variantId, type: sql.Int },
        { name: 'productId', value: item.productId, type: sql.Int },
      ]
    );
    const variantStock = result.recordset?.[0] || null;
    if (!variantStock) return null;

    const stockColumn = productStockColumn(capabilities);
    if (stockColumn) {
      const updates = [`${stockColumn} = ${stockColumn} - @quantity`];
      if (stockColumn !== 'stock' && hasColumn(capabilities.productColumns, 'stock')) updates.push('stock = stock - @quantity');
      if (stockColumn !== 'quantity' && hasColumn(capabilities.productColumns, 'quantity')) updates.push('quantity = quantity - @quantity');
      if (hasColumn(capabilities.productColumns, 'updated_at')) updates.push('updated_at = SYSDATETIME()');
      await txQuery(
        transaction,
        `UPDATE dbo.products
         SET ${updates.join(', ')}
         WHERE id = @productId AND ${stockColumn} >= @quantity`,
        [
          { name: 'quantity', value: item.quantity, type: sql.Int },
          { name: 'productId', value: item.productId, type: sql.Int },
        ]
      );
    }
    return variantStock;
  }

  const stockColumn = productStockColumn(capabilities);
  if (!stockColumn) {
    throw new Error('Schema products chưa có cột tồn kho.');
  }
  const updates = [`${stockColumn} = ${stockColumn} - @quantity`];
  if (stockColumn !== 'stock' && hasColumn(capabilities.productColumns, 'stock')) updates.push('stock = stock - @quantity');
  if (stockColumn !== 'quantity' && hasColumn(capabilities.productColumns, 'quantity')) updates.push('quantity = quantity - @quantity');
  if (hasColumn(capabilities.productColumns, 'updated_at')) updates.push('updated_at = SYSDATETIME()');

  const result = await txQuery(
    transaction,
    `UPDATE dbo.products
     SET ${updates.join(', ')}
     OUTPUT deleted.${stockColumn} AS stock_before, inserted.${stockColumn} AS stock_after
     WHERE id = @productId AND ${stockColumn} >= @quantity`,
    [
      { name: 'quantity', value: item.quantity, type: sql.Int },
      { name: 'productId', value: item.productId, type: sql.Int },
    ]
  );
  return result.recordset?.[0] || null;
}

async function recordInventoryMovement(transaction, entry) {
  const capabilities = await getReceiptCapabilities();
  if (!capabilities.hasInventoryTransactions) return;

  const columns = [];
  const values = [];
  const inputs = [];
  const add = (column, name, value, type = null) => {
    if (!hasColumn(capabilities.inventoryColumns, column)) return;
    columns.push(column);
    values.push(`@${name}`);
    inputs.push({ name, value, type });
  };

  add('product_id', 'productId', entry.productId, sql.Int);
  add('variant_id', 'variantId', entry.variantId || null, sql.Int);
  add('product_variant_id', 'productVariantId', entry.variantId || null, sql.Int);
  add('transaction_type', 'transactionType', entry.transactionType, sql.NVarChar(40));
  add('delta', 'delta', entry.delta, sql.Int);
  add('quantity', 'quantity', Math.abs(entry.delta), sql.Int);
  add('stock_before', 'stockBefore', entry.stockBefore ?? null, sql.Int);
  add('stock_after', 'stockAfter', entry.stockAfter ?? null, sql.Int);
  add('reason', 'reason', entry.reason || null, sql.NVarChar(500));
  add('reference_type', 'referenceType', entry.referenceType || null, sql.NVarChar(50));
  add('reference_id', 'referenceId', entry.referenceId || null, sql.Int);
  add('performed_by', 'performedBy', entry.performedBy || null, sql.Int);
  add('metadata', 'metadata', safeJson(entry.metadata || {}), sql.NVarChar(4000));

  if (!columns.length) return;
  await txQuery(transaction, `INSERT INTO dbo.inventory_transactions (${columns.join(', ')}) VALUES (${values.join(', ')})`, inputs);
}
export async function listPurchaseReceipts({
  search = '',
  supplierId = null,
  status = '',
  dateFrom = null,
  dateTo = null,
  sortBy = 'ImportDate',
  sortOrder = 'desc',
  page = 1,
  pageSize = 10,
} = {}) {
  await ensurePurchaseReceiptSchema();
  const receiptCapabilities = await getReceiptCapabilities();

  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const offset = (safePage - 1) * safePageSize;

  const conditions = ['pr.IsDeleted = 0'];
  const inputs = [
    { name: 'offset', value: offset, type: sql.Int },
    { name: 'pageSize', value: safePageSize, type: sql.Int },
  ];

  if (search) {
    conditions.push('(pr.ReceiptCode LIKE @search OR s.SupplierName LIKE @search OR s.SupplierCode LIKE @search)');
    inputs.push({
      name: 'search',
      value: `%${search}%`,
      type: sql.NVarChar(255),
    });
  }

  if (supplierId) {
    conditions.push('pr.SupplierId = @supplierId');
    inputs.push({
      name: 'supplierId',
      value: Number(supplierId),
      type: sql.Int,
    });
  }

  if (status) {
    conditions.push('pr.Status = @status');
    inputs.push({
      name: 'status',
      value: status,
      type: sql.NVarChar(30),
    });
  }

  if (dateFrom) {
    conditions.push('pr.ImportDate >= CONVERT(DATETIME2, @dateFrom, 120)');
    inputs.push({
      name: 'dateFrom',
      value: toSqlDateTimeText(dateFrom),
      type: sql.NVarChar(19),
    });
  }

  if (dateTo) {
    conditions.push('pr.ImportDate < DATEADD(day, 1, CONVERT(DATETIME2, @dateTo, 120))');
    inputs.push({
      name: 'dateTo',
      value: toSqlDateTimeText(dateTo),
      type: sql.NVarChar(19),
    });
  }

  const whereSql = `WHERE ${conditions.join(' AND ')}`;

  const totalInputs = inputs.filter((input) => !['offset', 'pageSize'].includes(input.name));

  const totalRows = await namedQuery(
    `SELECT COUNT(*) AS total
     FROM dbo.PurchaseReceipts pr
     JOIN dbo.Suppliers s ON s.SupplierId = pr.SupplierId
     ${whereSql}`,
    totalInputs
  );

  const rows = await namedQuery(
    `SELECT pr.PurchaseReceiptId, pr.ReceiptCode, pr.SupplierId, pr.ImportDate, pr.ReceiptDate,
            pr.TotalAmount, pr.Note, pr.Status, pr.CreatedBy, pr.CreatedAt, pr.UpdatedAt,
            s.SupplierCode, s.SupplierName,
            COALESCE(itemStats.TotalQuantity, 0) AS TotalQuantity,
            ${createdByNameSelect(receiptCapabilities)}
     FROM dbo.PurchaseReceipts pr
     JOIN dbo.Suppliers s ON s.SupplierId = pr.SupplierId
     ${createdByJoin(receiptCapabilities)}
     OUTER APPLY (
       SELECT SUM(Quantity) AS TotalQuantity
       FROM dbo.PurchaseReceiptItems pri
       WHERE pri.PurchaseReceiptId = pr.PurchaseReceiptId
     ) itemStats
     ${whereSql}
     ORDER BY ${sortExpression(sortBy, sortOrder)}
     OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
    inputs
  );

  const totalItems = Number(totalRows[0]?.total || 0);

  return {
    items: rows.map(mapReceiptRow),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / safePageSize)),
    },
  };
}
export async function getPurchaseReceiptById(id) {
  await ensurePurchaseReceiptSchema();
  const [receiptCapabilities, productCapabilities] = await Promise.all([
    getReceiptCapabilities(),
    getProductStorageCapabilities(),
  ]);
  const rows = await query(
    `SELECT pr.PurchaseReceiptId, pr.ReceiptCode, pr.SupplierId, pr.ImportDate, pr.ReceiptDate,
            pr.TotalAmount, pr.Note, pr.Status, pr.CreatedBy, pr.CreatedAt, pr.UpdatedAt,
            s.SupplierCode, s.SupplierName, s.RepresentativeName, s.Phone, s.Email, s.Address,
            COALESCE(itemStats.TotalQuantity, 0) AS TotalQuantity,
            ${createdByNameSelect(receiptCapabilities)}
     FROM dbo.PurchaseReceipts pr
     JOIN dbo.Suppliers s ON s.SupplierId = pr.SupplierId
     ${createdByJoin(receiptCapabilities)}
     OUTER APPLY (
       SELECT SUM(Quantity) AS TotalQuantity
       FROM dbo.PurchaseReceiptItems pri
       WHERE pri.PurchaseReceiptId = pr.PurchaseReceiptId
     ) itemStats
     WHERE pr.PurchaseReceiptId = ? AND pr.IsDeleted = 0`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;

  const productSkuSelect = optionalColumn(productCapabilities.productColumns, 'sku', 'p.sku', 'ProductSku');
  const hasVariants = productCapabilities.hasVariants;
  const variantJoin = hasVariants ? 'LEFT JOIN dbo.product_variants pv ON pv.id = pri.VariantId' : '';
  const variantSkuSelect = hasVariants
    ? optionalColumn(productCapabilities.variantColumns, 'sku', 'pv.sku', 'VariantSku')
    : "N'' AS VariantSku";
  const variantLabelSelect = hasVariants
    ? optionalColumn(productCapabilities.variantColumns, 'volume_label', 'pv.volume_label', 'VariantLabel')
    : "N'' AS VariantLabel";
  const variantTypeSelect = hasVariants
    ? optionalColumn(productCapabilities.variantColumns, 'variant_type', 'pv.variant_type', 'VariantType')
    : "N'' AS VariantType";

  const items = await query(
    `SELECT pri.PurchaseReceiptItemId, pri.PurchaseReceiptId, pri.ProductId, pri.VariantId,
            pri.Quantity, pri.ImportPrice, pri.TotalPrice, pri.Note, pri.CreatedAt,
            p.name AS ProductName, ${productSkuSelect},
            ${variantSkuSelect}, ${variantLabelSelect}, ${variantTypeSelect}
     FROM dbo.PurchaseReceiptItems pri
     JOIN dbo.products p ON p.id = pri.ProductId
     ${variantJoin}
     WHERE pri.PurchaseReceiptId = ?
     ORDER BY pri.PurchaseReceiptItemId ASC`,
    [id]
  );

  return {
    receipt: mapReceiptRow(row),
    supplier: {
      supplierId: Number(row.SupplierId || 0),
      supplierCode: row.SupplierCode || '',
      supplierName: row.SupplierName || '',
      representativeName: row.RepresentativeName || '',
      phone: row.Phone || '',
      email: row.Email || '',
      address: row.Address || '',
    },
    items: items.map(mapReceiptItem),
  };
}

export async function createPurchaseReceipt(data, adminId = null) {
  await ensurePurchaseReceiptSchema();
  const productCapabilities = await getProductStorageCapabilities();
  const pool = await getDbPool();
  const transaction = new sql.Transaction(pool);
  const changedProductIds = new Set();

  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const supplier = await getSupplierForReceipt(transaction, data.supplierId);
    if (!supplier) {
      const error = new Error('Không tìm thấy nhà cung cấp.');
      error.status = 404;
      throw error;
    }
    if (String(supplier.Status || '').toUpperCase() !== 'ACTIVE') {
      const error = new Error('Nhà cung cấp đang ngừng hợp tác, không thể tạo phiếu nhập.');
      error.status = 400;
      throw error;
    }

    const preparedItems = [];
    for (const item of data.items) {
      const product = await getProductForReceipt(transaction, item.productId, productCapabilities);
      if (!product) {
        const error = new Error(`Sản phẩm #${item.productId} không tồn tại.`);
        error.status = 400;
        throw error;
      }

      const variant = await getVariantForReceipt(transaction, item.productId, item.variantId, productCapabilities);
      if (item.variantId && !variant) {
        const error = new Error(`Biến thể #${item.variantId} không thuộc sản phẩm đã chọn.`);
        error.status = 400;
        throw error;
      }

      preparedItems.push({
        ...item,
        totalPrice: Math.round(item.quantity * item.importPrice * 100) / 100,
        productName: product.name,
        variantLabel: variant?.volume_label || variant?.variant_type || '',
      });
    }

    const codeResult = await txQuery(
      transaction,
      `SELECT TOP 1 ReceiptCode
       FROM dbo.PurchaseReceipts WITH (UPDLOCK, HOLDLOCK)
       WHERE ReceiptCode LIKE N'PN%'
       ORDER BY TRY_CONVERT(INT, SUBSTRING(ReceiptCode, 3, 20)) DESC, PurchaseReceiptId DESC`
    );
    const receiptCode = nextReceiptCode(codeResult.recordset?.[0]?.ReceiptCode);
    const totalAmount = preparedItems.reduce((sum, item) => sum + item.totalPrice, 0);

    const insertReceipt = await txQuery(
      transaction,
      `INSERT INTO dbo.PurchaseReceipts
       (ReceiptCode, SupplierId, ImportDate, ReceiptDate, TotalAmount, Note, Status, CreatedBy, CreatedAt, IsDeleted)
       OUTPUT inserted.PurchaseReceiptId AS PurchaseReceiptId
       VALUES
       (@receiptCode, @supplierId, CONVERT(DATETIME2, @importDate, 120), CONVERT(DATETIME2, @importDate, 120), @totalAmount, @note, N'COMPLETED', @createdBy, SYSDATETIME(), 0)`,
      [
        { name: 'receiptCode', value: receiptCode, type: sql.NVarChar(30) },
        { name: 'supplierId', value: data.supplierId, type: sql.Int },
        { name: 'importDate', value: toSqlDateTimeText(data.importDate), type: sql.NVarChar(19) },
        { name: 'totalAmount', value: totalAmount, type: sql.Decimal(18, 2) },
        { name: 'note', value: data.note || null, type: sql.NVarChar(4000) },
        { name: 'createdBy', value: adminId || null, type: sql.Int },
      ]
    );
    const purchaseReceiptId = insertReceipt.recordset?.[0]?.PurchaseReceiptId;

    for (const item of preparedItems) {
      await txQuery(
        transaction,
        `INSERT INTO dbo.PurchaseReceiptItems
         (PurchaseReceiptId, ProductId, VariantId, Quantity, ImportPrice, TotalPrice, Note)
         VALUES
         (@purchaseReceiptId, @productId, @variantId, @quantity, @importPrice, @totalPrice, @note)`,
        [
          { name: 'purchaseReceiptId', value: purchaseReceiptId, type: sql.Int },
          { name: 'productId', value: item.productId, type: sql.Int },
          { name: 'variantId', value: item.variantId || null, type: sql.Int },
          { name: 'quantity', value: item.quantity, type: sql.Int },
          { name: 'importPrice', value: item.importPrice, type: sql.Decimal(18, 2) },
          { name: 'totalPrice', value: item.totalPrice, type: sql.Decimal(18, 2) },
          { name: 'note', value: item.note || null, type: sql.NVarChar(500) },
        ]
      );

      const stock = await increaseStock(transaction, item, productCapabilities);
      if (!stock) {
        const error = new Error(`Không thể cộng tồn kho cho sản phẩm #${item.productId}.`);
        error.status = 500;
        throw error;
      }

      await recordInventoryMovement(transaction, {
        productId: item.productId,
        variantId: item.variantId,
        delta: item.quantity,
        transactionType: 'IMPORT',
        reason: `Nhập hàng ${receiptCode}`,
        referenceType: 'PURCHASE_RECEIPT',
        referenceId: purchaseReceiptId,
        performedBy: adminId,
        stockBefore: Number(stock.stock_before ?? 0),
        stockAfter: Number(stock.stock_after ?? 0),
        metadata: {
          receiptCode,
          purchaseReceiptId,
          supplierId: data.supplierId,
          supplierName: supplier.SupplierName,
          importPrice: item.importPrice,
          totalPrice: item.totalPrice,
        },
      });
      changedProductIds.add(item.productId);
    }

    await transaction.commit();
    await invalidateChangedProductCaches(changedProductIds);
    return getPurchaseReceiptByIdAfterCommit(purchaseReceiptId, () => buildCreatedReceiptFallback({
      purchaseReceiptId,
      receiptCode,
      supplier,
      data,
      preparedItems,
      totalAmount,
      adminId,
    }));
  } catch (error) {
    try { await transaction.rollback(); } catch { }
    throw error;
  }
}

export async function updatePurchaseReceipt(id, data) {
  await ensurePurchaseReceiptSchema();
  const existing = await getPurchaseReceiptById(id);
  if (!existing) return null;
  if (existing.receipt.status === 'CANCELLED') {
    const error = new Error('Không thể cập nhật phiếu nhập đã hủy.');
    error.status = 400;
    throw error;
  }

  const fields = ['Note = ?', 'UpdatedAt = SYSDATETIME()'];
  const params = [data.note || null];
  if (data.importDate) {
    fields.unshift('ReceiptDate = ?');
    fields.unshift('ImportDate = ?');
    params.unshift(data.importDate, data.importDate);
  }
  await query(
    `UPDATE dbo.PurchaseReceipts
     SET ${fields.join(', ')}
     WHERE PurchaseReceiptId = ? AND IsDeleted = 0`,
    [...params, id]
  );
  return getPurchaseReceiptById(id);
}

export async function cancelPurchaseReceipt(id, adminId = null) {
  await ensurePurchaseReceiptSchema();
  const productCapabilities = await getProductStorageCapabilities();
  const pool = await getDbPool();
  const transaction = new sql.Transaction(pool);
  const changedProductIds = new Set();

  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const receiptResult = await txQuery(
      transaction,
      `SELECT TOP 1 PurchaseReceiptId, ReceiptCode, SupplierId, Status
       FROM dbo.PurchaseReceipts WITH (UPDLOCK, HOLDLOCK)
       WHERE PurchaseReceiptId = @id AND IsDeleted = 0`,
      [{ name: 'id', value: id, type: sql.Int }]
    );
    const receipt = receiptResult.recordset?.[0];
    if (!receipt) {
      const error = new Error('Không tìm thấy phiếu nhập.');
      error.status = 404;
      throw error;
    }
    if (receipt.Status !== 'COMPLETED') {
      const error = new Error('Chỉ có thể hủy phiếu nhập đã nhập kho.');
      error.status = 400;
      throw error;
    }

    const itemResult = await txQuery(
      transaction,
      `SELECT PurchaseReceiptItemId, ProductId, VariantId, Quantity, ImportPrice, TotalPrice
       FROM dbo.PurchaseReceiptItems
       WHERE PurchaseReceiptId = @id
       ORDER BY PurchaseReceiptItemId ASC`,
      [{ name: 'id', value: id, type: sql.Int }]
    );

    for (const row of itemResult.recordset || []) {
      const item = {
        productId: Number(row.ProductId),
        variantId: row.VariantId === null || row.VariantId === undefined ? null : Number(row.VariantId),
        quantity: Number(row.Quantity),
      };
      const stock = await decreaseStock(transaction, item, productCapabilities);
      if (!stock) {
        const error = new Error('Không thể hủy phiếu nhập vì tồn kho hiện tại không đủ để hoàn tác.');
        error.status = 409;
        throw error;
      }

      await recordInventoryMovement(transaction, {
        productId: item.productId,
        variantId: item.variantId,
        delta: -item.quantity,
        transactionType: 'IMPORT_CANCEL',
        reason: `Hủy phiếu nhập ${receipt.ReceiptCode}`,
        referenceType: 'PURCHASE_RECEIPT',
        referenceId: id,
        performedBy: adminId,
        stockBefore: Number(stock.stock_before ?? 0),
        stockAfter: Number(stock.stock_after ?? 0),
        metadata: {
          receiptCode: receipt.ReceiptCode,
          purchaseReceiptId: id,
          action: 'cancel',
        },
      });
      changedProductIds.add(item.productId);
    }

    await txQuery(
      transaction,
      `UPDATE dbo.PurchaseReceipts
       SET Status = N'CANCELLED', UpdatedAt = SYSDATETIME()
       WHERE PurchaseReceiptId = @id AND Status = N'COMPLETED'`,
      [{ name: 'id', value: id, type: sql.Int }]
    );

    await transaction.commit();
    await invalidateChangedProductCaches(changedProductIds);
    return getPurchaseReceiptByIdAfterCommit(id, () => ({
      receipt: {
        purchaseReceiptId: Number(id || 0),
        receiptCode: receipt.ReceiptCode || '',
        supplierId: Number(receipt.SupplierId || 0),
        supplierCode: '',
        supplierName: '',
        importDate: null,
        totalQuantity: 0,
        totalAmount: 0,
        note: '',
        status: 'CANCELLED',
        createdBy: null,
        createdByName: '',
        createdAt: null,
        updatedAt: new Date().toISOString(),
      },
      supplier: {
        supplierId: Number(receipt.SupplierId || 0),
        supplierCode: '',
        supplierName: '',
        representativeName: '',
        phone: '',
        email: '',
        address: '',
      },
      items: [],
    }));
  } catch (error) {
    try { await transaction.rollback(); } catch { }
    throw error;
  }
}

export async function softDeletePurchaseReceipt(id) {
  await ensurePurchaseReceiptSchema();
  const existing = await getPurchaseReceiptById(id);
  if (!existing) return null;
  if (existing.receipt.status === 'COMPLETED') {
    const error = new Error('Nếu muốn xóa phiếu đã nhập kho thì phải hủy phiếu trước.');
    error.status = 409;
    throw error;
  }

  await query(
    `UPDATE dbo.PurchaseReceipts
     SET IsDeleted = 1, UpdatedAt = SYSDATETIME()
     WHERE PurchaseReceiptId = ? AND IsDeleted = 0`,
    [id]
  );
  return existing;
}

export async function getPurchaseReceiptStatistics() {
  await ensurePurchaseReceiptSchema();
  const [summaryRows, topProductRows, topSupplierRows, monthRows] = await Promise.all([
    query(
      `SELECT COUNT(*) AS totalReceipts,
              COALESCE(SUM(CASE WHEN Status = N'COMPLETED' THEN TotalAmount ELSE 0 END), 0) AS totalImportValue,
              SUM(CASE WHEN Status = N'COMPLETED'
                        AND ImportDate >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)
                       THEN 1 ELSE 0 END) AS currentMonthReceipts
       FROM dbo.PurchaseReceipts
       WHERE IsDeleted = 0`
    ),
    query(
      `SELECT TOP 5 p.id AS ProductId, p.name AS ProductName,
              SUM(pri.Quantity) AS totalQuantity,
              SUM(pri.TotalPrice) AS totalValue
       FROM dbo.PurchaseReceiptItems pri
       JOIN dbo.PurchaseReceipts pr ON pr.PurchaseReceiptId = pri.PurchaseReceiptId
       JOIN dbo.products p ON p.id = pri.ProductId
       WHERE pr.IsDeleted = 0 AND pr.Status = N'COMPLETED'
       GROUP BY p.id, p.name
       ORDER BY totalQuantity DESC, totalValue DESC`
    ),
    query(
      `SELECT TOP 5 s.SupplierId, s.SupplierName,
              COUNT(pr.PurchaseReceiptId) AS totalReceipts,
              COALESCE(SUM(pr.TotalAmount), 0) AS totalValue
       FROM dbo.PurchaseReceipts pr
       JOIN dbo.Suppliers s ON s.SupplierId = pr.SupplierId
       WHERE pr.IsDeleted = 0 AND pr.Status = N'COMPLETED'
       GROUP BY s.SupplierId, s.SupplierName
       ORDER BY totalValue DESC, totalReceipts DESC`
    ),
    query(
      `SELECT CONVERT(CHAR(7), ImportDate, 120) AS month,
              COALESCE(SUM(TotalAmount), 0) AS totalValue,
              COUNT(*) AS totalReceipts
       FROM dbo.PurchaseReceipts
       WHERE IsDeleted = 0 AND Status = N'COMPLETED'
         AND ImportDate >= DATEADD(month, -11, DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1))
       GROUP BY CONVERT(CHAR(7), ImportDate, 120)
       ORDER BY month ASC`
    ),
  ]);

  const totalItemsRows = await query(
    `SELECT COALESCE(SUM(pri.Quantity), 0) AS totalImportedQuantity
     FROM dbo.PurchaseReceiptItems pri
     JOIN dbo.PurchaseReceipts pr ON pr.PurchaseReceiptId = pri.PurchaseReceiptId
     WHERE pr.IsDeleted = 0 AND pr.Status = N'COMPLETED'`
  );

  const summary = summaryRows[0] || {};
  return {
    totalReceipts: Number(summary.totalReceipts || 0),
    totalImportValue: Number(summary.totalImportValue || 0),
    totalImportedQuantity: Number(totalItemsRows[0]?.totalImportedQuantity || 0),
    currentMonthReceipts: Number(summary.currentMonthReceipts || 0),
    topImportedProducts: topProductRows.map((row) => ({
      productId: Number(row.ProductId || 0),
      productName: row.ProductName || '',
      totalQuantity: Number(row.totalQuantity || 0),
      totalValue: Number(row.totalValue || 0),
    })),
    topSuppliers: topSupplierRows.map((row) => ({
      supplierId: Number(row.SupplierId || 0),
      supplierName: row.SupplierName || '',
      totalReceipts: Number(row.totalReceipts || 0),
      totalValue: Number(row.totalValue || 0),
    })),
    monthlyImportValues: monthRows.map((row) => ({
      month: row.month,
      totalValue: Number(row.totalValue || 0),
      totalReceipts: Number(row.totalReceipts || 0),
    })),
  };
}

export async function listReceiptProductOptions({ search = '', limit = 100 } = {}) {
  await ensurePurchaseReceiptSchema();
  const capabilities = await getProductStorageCapabilities();
  const stockColumn = productStockColumn(capabilities);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  const conditions = ['1 = 1'];
  const params = [];

  if (hasColumn(capabilities.productColumns, 'deleted_at')) conditions.push('p.deleted_at IS NULL');
  if (hasColumn(capabilities.productColumns, 'status')) conditions.push('ISNULL(p.status, 1) = 1');
  if (search) {
    const searchColumns = ['p.name LIKE ?'];
    params.push(`%${search}%`);
    if (hasColumn(capabilities.productColumns, 'sku')) {
      searchColumns.push('p.sku LIKE ?');
      params.push(`%${search}%`);
    }
    conditions.push(`(${searchColumns.join(' OR ')})`);
  }

  const productSkuSelect = optionalColumn(capabilities.productColumns, 'sku', 'p.sku', 'sku');
  const imageSelect = hasColumn(capabilities.productColumns, 'image') ? 'p.image' : 'NULL';
  const priceSelect = hasColumn(capabilities.productColumns, 'price') ? 'p.price' : '0';
  const rows = await query(
    `SELECT TOP ${safeLimit} p.id, p.name, ${productSkuSelect}, ${imageSelect} AS image,
            ${priceSelect} AS price, ${stockColumn || '0'} AS stock
     FROM dbo.products p
     WHERE ${conditions.join(' AND ')}
     ORDER BY p.name ASC`,
    params
  );

  if (!rows.length) return [];
  const productIds = rows.map((row) => Number(row.id)).filter(Boolean);
  let variants = [];
  if (capabilities.hasVariants && hasColumn(capabilities.variantColumns, 'stock_quantity') && productIds.length) {
    const placeholders = productIds.map(() => '?').join(', ');
    const variantFilters = ['product_id IN (' + placeholders + ')'];
    if (hasColumn(capabilities.variantColumns, 'deleted_at')) variantFilters.push('deleted_at IS NULL');
    if (hasColumn(capabilities.variantColumns, 'status')) variantFilters.push('ISNULL(status, 1) = 1');
    if (hasColumn(capabilities.variantColumns, 'variant_type')) variantFilters.push("UPPER(ISNULL(variant_type, N'FULL')) <> N'DECANT'");
    const variantSkuSelect = hasColumn(capabilities.variantColumns, 'sku') ? 'sku' : "N'' AS sku";
    const volumeLabelSelect = hasColumn(capabilities.variantColumns, 'volume_label') ? 'volume_label' : 'NULL AS volume_label';
    const variantTypeSelect = hasColumn(capabilities.variantColumns, 'variant_type') ? 'variant_type' : 'NULL AS variant_type';
    const sortSelect = hasColumn(capabilities.variantColumns, 'sort_order') ? 'sort_order' : '0 AS sort_order';
    variants = await query(
      `SELECT id, product_id, ${variantSkuSelect}, ${volumeLabelSelect}, ${variantTypeSelect}, stock_quantity, ${sortSelect}
       FROM dbo.product_variants
       WHERE ${variantFilters.join(' AND ')}
       ORDER BY product_id, sort_order, id`,
      productIds
    );
  }

  const variantsByProduct = new Map();
  variants.forEach((variant) => {
    const key = Number(variant.product_id);
    const bucket = variantsByProduct.get(key) || [];
    bucket.push({
      variantId: Number(variant.id),
      sku: variant.sku || '',
      volumeLabel: variant.volume_label || '',
      variantType: variant.variant_type || '',
      stockQuantity: Number(variant.stock_quantity || 0),
    });
    variantsByProduct.set(key, bucket);
  });

  return rows.map((row) => ({
    productId: Number(row.id),
    name: row.name || '',
    sku: row.sku || '',
    image: row.image || '',
    price: Number(row.price || 0),
    stock: Number(row.stock || 0),
    variants: variantsByProduct.get(Number(row.id)) || [],
  }));
}
