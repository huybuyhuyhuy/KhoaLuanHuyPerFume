import { query } from '../../config/database.js';

let checkoutCapabilitiesPromise = null;
let orderVoucherColumnsPromise = null;
let orderPaymentFailureColumnsPromise = null;

function toColumnSet(rows) {
  return new Set(rows.map((row) => String(row.COLUMN_NAME || row.column_name || '').toLowerCase()));
}

function toTableSet(rows) {
  return new Set(rows.map((row) => String(row.TABLE_NAME || row.table_name || '').toLowerCase()));
}

async function tableColumns(tableName) {
  return query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = ?`,
    [tableName]
  );
}

async function ensureOrderVoucherColumns() {
  if (!orderVoucherColumnsPromise) {
    orderVoucherColumnsPromise = query(`
      IF OBJECT_ID(N'dbo.orders', N'U') IS NOT NULL
      BEGIN
        IF COL_LENGTH(N'dbo.orders', N'order_subtotal') IS NULL
          ALTER TABLE dbo.orders ADD order_subtotal FLOAT NULL;
        IF COL_LENGTH(N'dbo.orders', N'voucher_id') IS NULL
          ALTER TABLE dbo.orders ADD voucher_id INT NULL;
        IF COL_LENGTH(N'dbo.orders', N'voucher_code') IS NULL
          ALTER TABLE dbo.orders ADD voucher_code NVARCHAR(50) NULL;
        IF COL_LENGTH(N'dbo.orders', N'voucher_discount_type') IS NULL
          ALTER TABLE dbo.orders ADD voucher_discount_type NVARCHAR(20) NULL;
        IF COL_LENGTH(N'dbo.orders', N'voucher_discount_value') IS NULL
          ALTER TABLE dbo.orders ADD voucher_discount_value FLOAT NULL;
        IF COL_LENGTH(N'dbo.orders', N'voucher_discount_amount') IS NULL
          ALTER TABLE dbo.orders ADD voucher_discount_amount FLOAT NULL;
      END
    `);
    orderVoucherColumnsPromise = orderVoucherColumnsPromise.catch((error) => {
      orderVoucherColumnsPromise = null;
      throw error;
    });
  }
  return orderVoucherColumnsPromise;
}

async function ensureOrderPaymentFailureColumns() {
  if (!orderPaymentFailureColumnsPromise) {
    orderPaymentFailureColumnsPromise = query(`
      IF OBJECT_ID(N'dbo.orders', N'U') IS NOT NULL
      BEGIN
        IF COL_LENGTH(N'dbo.orders', N'failure_reason') IS NULL
          ALTER TABLE dbo.orders ADD failure_reason NVARCHAR(500) NULL;
        IF COL_LENGTH(N'dbo.orders', N'order_code') IS NULL
          ALTER TABLE dbo.orders ADD order_code NVARCHAR(50) NULL;
        IF COL_LENGTH(N'dbo.orders', N'payment_status') IS NULL
          ALTER TABLE dbo.orders ADD payment_status NVARCHAR(30) NULL;

        EXEC(N'
          UPDATE dbo.orders
          SET order_code = CONCAT(N''#'', id)
          WHERE order_code IS NULL OR LTRIM(RTRIM(order_code)) = N''''
        ');

        EXEC(N'
          UPDATE dbo.orders
          SET payment_status = CASE
            WHEN UPPER(ISNULL(status, N'''')) IN (N''CONFIRMED'', N''PACKING'', N''SHIPPING'', N''DELIVERED'', N''COMPLETED'') THEN N''PAID''
            WHEN UPPER(ISNULL(status, N'''')) = N''PAYMENT_REJECTED'' THEN N''PAYMENT_REJECTED''
            WHEN UPPER(ISNULL(status, N'''')) = N''PAYMENT_FAILED'' THEN N''PAYMENT_FAILED''
            WHEN UPPER(ISNULL(status, N'''')) IN (N''CANCELLED_PAYMENT'', N''CANCELLED'', N''REFUNDED'') THEN N''CANCELLED''
            ELSE N''PENDING''
          END
          WHERE payment_status IS NULL OR LTRIM(RTRIM(payment_status)) = N''''
        ');

        IF EXISTS (
          SELECT 1 FROM sys.check_constraints
          WHERE parent_object_id = OBJECT_ID(N'dbo.orders')
            AND name = N'CK_orders_status_canonical'
            AND definition NOT LIKE N'%PAYMENT_REJECTED%'
        )
        BEGIN
          ALTER TABLE dbo.orders DROP CONSTRAINT CK_orders_status_canonical;
        END;

        IF NOT EXISTS (
          SELECT 1 FROM sys.check_constraints
          WHERE parent_object_id = OBJECT_ID(N'dbo.orders')
            AND name = N'CK_orders_status_canonical'
        )
        BEGIN
          ALTER TABLE dbo.orders WITH CHECK ADD CONSTRAINT CK_orders_status_canonical
          CHECK (status IN (
            N'PENDING_PAYMENT', N'PENDING', N'CONFIRMED', N'PACKING', N'SHIPPING',
            N'DELIVERED', N'COMPLETED', N'PAYMENT_REJECTED', N'PAYMENT_FAILED',
            N'CANCELLED_PAYMENT', N'CANCELLED', N'REFUNDED'
          ));
        END;
      END
    `);
    orderPaymentFailureColumnsPromise = orderPaymentFailureColumnsPromise.catch((error) => {
      orderPaymentFailureColumnsPromise = null;
      throw error;
    });
  }
  return orderPaymentFailureColumnsPromise;
}

export async function getCheckoutStorageCapabilities() {
  if (!checkoutCapabilitiesPromise) {
    checkoutCapabilitiesPromise = (async () => {
      await ensureOrderVoucherColumns();
      await ensureOrderPaymentFailureColumns();
      const [tables, cartColumns, cartItemColumns, orderColumns, orderItemColumns, variantColumns] = await Promise.all([
        query(`
          SELECT TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = 'dbo'
            AND TABLE_NAME IN ('carts', 'cart_items', 'inventory_reservations', 'inventory_transactions', 'product_variants', 'product_batches')
        `),
        tableColumns('carts'),
        tableColumns('cart_items'),
        tableColumns('orders'),
        tableColumns('order_items'),
        tableColumns('product_variants'),
      ]);

      const tableSet = toTableSet(tables);
      const cartColumnSet = toColumnSet(cartColumns);
      const cartItemColumnSet = toColumnSet(cartItemColumns);
      const hasCartCoreColumns = cartColumnSet.has('id') && cartColumnSet.has('user_id');
      const hasCartItemCoreColumns = cartItemColumnSet.has('cart_id') &&
        cartItemColumnSet.has('product_id') &&
        cartItemColumnSet.has('quantity');

      return {
        hasDurableCart: tableSet.has('carts') && tableSet.has('cart_items') && hasCartCoreColumns && hasCartItemCoreColumns,
        hasInventoryReservations: tableSet.has('inventory_reservations'),
        hasInventoryTransactions: tableSet.has('inventory_transactions'),
        hasVariants: tableSet.has('product_variants'),
        hasProductBatches: tableSet.has('product_batches'),
        cartColumns: cartColumnSet,
        cartItemColumns: cartItemColumnSet,
        orderColumns: toColumnSet(orderColumns),
        orderItemColumns: toColumnSet(orderItemColumns),
        variantColumns: toColumnSet(variantColumns),
      };
    })().catch((error) => {
      checkoutCapabilitiesPromise = null;
      throw error;
    });
  }

  return checkoutCapabilitiesPromise;
}

export function hasColumn(columns, name) {
  return columns.has(String(name).toLowerCase());
}

export function resetCheckoutStorageCapabilitiesForTests() {
  checkoutCapabilitiesPromise = null;
  orderVoucherColumnsPromise = null;
  orderPaymentFailureColumnsPromise = null;
}
