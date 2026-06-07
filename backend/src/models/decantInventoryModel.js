import { getDbPool, query, sql } from '../config/database.js';
import { getProductStorageCapabilities } from '../modules/products/product.repository.js';

// ── helpers ──────────────────────────────────────────────
function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function hasColumn(columns, name) {
  return columns.has(String(name).toLowerCase());
}

function inventoryShortage(message) {
  return Object.assign(new Error(message), { code: 409, inventoryShortage: true });
}

let decantInventoryReadyPromise = null;

export async function ensureDecantInventoryTables() {
  if (!decantInventoryReadyPromise) {
    decantInventoryReadyPromise = query(`
      IF OBJECT_ID(N'dbo.product_inventory', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.product_inventory (
          id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          product_id INT NOT NULL,
          sealed_bottles INT NOT NULL CONSTRAINT DF_product_inventory_sealed DEFAULT 0,
          opened_ml INT NOT NULL CONSTRAINT DF_product_inventory_opened_ml DEFAULT 0,
          bottle_volume_ml INT NOT NULL CONSTRAINT DF_product_inventory_bottle_volume DEFAULT 100,
          created_at DATETIME2 NOT NULL CONSTRAINT DF_product_inventory_created_at DEFAULT SYSUTCDATETIME(),
          updated_at DATETIME2 NULL
        );
      END

      IF COL_LENGTH(N'dbo.product_inventory', N'sealed_bottles') IS NULL
        ALTER TABLE dbo.product_inventory ADD sealed_bottles INT NOT NULL CONSTRAINT DF_product_inventory_sealed_late DEFAULT 0;
      IF COL_LENGTH(N'dbo.product_inventory', N'opened_ml') IS NULL
        ALTER TABLE dbo.product_inventory ADD opened_ml INT NOT NULL CONSTRAINT DF_product_inventory_opened_ml_late DEFAULT 0;
      IF COL_LENGTH(N'dbo.product_inventory', N'bottle_volume_ml') IS NULL
        ALTER TABLE dbo.product_inventory ADD bottle_volume_ml INT NOT NULL CONSTRAINT DF_product_inventory_bottle_volume_late DEFAULT 100;
      IF COL_LENGTH(N'dbo.product_inventory', N'updated_at') IS NULL
        ALTER TABLE dbo.product_inventory ADD updated_at DATETIME2 NULL;

      IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE name = N'UX_product_inventory_product'
          AND object_id = OBJECT_ID(N'dbo.product_inventory')
      )
      BEGIN
        CREATE UNIQUE INDEX UX_product_inventory_product ON dbo.product_inventory(product_id);
      END

      IF OBJECT_ID(N'dbo.inventory_movements', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.inventory_movements (
          id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
          product_id INT NOT NULL,
          batch_id INT NULL,
          order_id INT NULL,
          order_item_id INT NULL,
          admin_id INT NULL,
          movement_type NVARCHAR(40) NOT NULL,
          sealed_bottles_before INT NOT NULL,
          sealed_bottles_after INT NOT NULL,
          opened_ml_before INT NOT NULL,
          opened_ml_after INT NOT NULL,
          quantity_ml INT NULL,
          quantity_bottles INT NULL,
          reference NVARCHAR(160) NULL,
          created_at DATETIME2 NOT NULL CONSTRAINT DF_inventory_movements_created_at DEFAULT SYSUTCDATETIME()
        );
      END

      IF COL_LENGTH(N'dbo.inventory_movements', N'batch_id') IS NULL
        ALTER TABLE dbo.inventory_movements ADD batch_id INT NULL;
      IF COL_LENGTH(N'dbo.inventory_movements', N'admin_id') IS NULL
        ALTER TABLE dbo.inventory_movements ADD admin_id INT NULL;

      IF NOT EXISTS (
        SELECT 1 FROM sys.check_constraints
        WHERE name = N'CK_inventory_movements_type'
          AND parent_object_id = OBJECT_ID(N'dbo.inventory_movements')
      )
      BEGIN
        ALTER TABLE dbo.inventory_movements WITH NOCHECK ADD CONSTRAINT CK_inventory_movements_type
        CHECK (movement_type IN (
          N'BOTTLE_OPEN', N'DECANT_SALE', N'DECANT_SOLD', N'BOTTLE_SALE',
          N'BOTTLE_RESTOCK', N'DECANT_RESTOCK', N'RETURN_RESTOCK',
          N'ADJUSTMENT', N'MANUAL_ADJUST', N'CANCEL'
        ));
      END
    `);
  }
  return decantInventoryReadyPromise;
}

async function readProductInventorySeed(transaction, productId, fallbackBottleVolumeMl = 100) {
  const capabilities = await getProductStorageCapabilities();
  const stockSelect = hasColumn(capabilities.productColumns, 'stock')
    ? 'stock'
    : hasColumn(capabilities.productColumns, 'quantity')
      ? 'quantity AS stock'
      : '0 AS stock';
  const volumeSelect = hasColumn(capabilities.productColumns, 'volume_ml') ? 'volume_ml' : 'NULL AS volume_ml';

  if (transaction) {
    const req = new sql.Request(transaction);
    req.input('productId', sql.Int, Number(productId));
    const result = await req.query(
      `SELECT TOP 1 ${stockSelect}, ${volumeSelect}
       FROM products
       WHERE id = @productId`
    );
    const row = result.recordset?.[0];
    if (!row) return null;
    return {
      sealedBottles: Math.max(0, toInt(row.stock)),
      bottleVolumeMl: Math.max(1, toInt(row.volume_ml, fallbackBottleVolumeMl) || fallbackBottleVolumeMl),
    };
  }

  const rows = await query(
    `SELECT TOP 1 ${stockSelect}, ${volumeSelect}
     FROM products
     WHERE id = ?`,
    [Number(productId)]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    sealedBottles: Math.max(0, toInt(row.stock)),
    bottleVolumeMl: Math.max(1, toInt(row.volume_ml, fallbackBottleVolumeMl) || fallbackBottleVolumeMl),
  };
}

// ── read current inventory ───────────────────────────────
export async function getProductInventory(productId) {
  await ensureDecantInventoryTables();
  const rows = await query(
    `SELECT sealed_bottles, opened_ml, bottle_volume_ml
     FROM product_inventory WHERE product_id = ?`,
    [productId]
  );
  if (rows.length === 0) {
    const seed = await readProductInventorySeed(null, productId);
    if (!seed) return { sealedBottles: 0, openedMl: 0, bottleVolumeMl: 100 };
    try {
      await query(
        `IF NOT EXISTS (SELECT 1 FROM product_inventory WHERE product_id = ?)
         BEGIN
           INSERT INTO product_inventory (product_id, sealed_bottles, opened_ml, bottle_volume_ml)
           VALUES (?, ?, 0, ?)
         END`,
        [productId, productId, seed.sealedBottles, seed.bottleVolumeMl]
      );
    } catch (error) {
      if (!/duplicate|unique/i.test(String(error?.message || error?.originalError?.message || ''))) {
        throw error;
      }
    }
    const seededRows = await query(
      `SELECT sealed_bottles, opened_ml, bottle_volume_ml
       FROM product_inventory WHERE product_id = ?`,
      [productId]
    );
    if (seededRows.length === 0) return { ...seed, openedMl: 0 };
    return {
      sealedBottles: toInt(seededRows[0].sealed_bottles),
      openedMl: toInt(seededRows[0].opened_ml),
      bottleVolumeMl: toInt(seededRows[0].bottle_volume_ml) || 100,
    };
  }
  const inventory = {
    sealedBottles: toInt(rows[0].sealed_bottles),
    openedMl: toInt(rows[0].opened_ml),
    bottleVolumeMl: toInt(rows[0].bottle_volume_ml) || 100,
  };

  if (inventory.sealedBottles === 0 && inventory.openedMl === 0) {
    const movementRows = await query('SELECT TOP 1 id FROM inventory_movements WHERE product_id = ?', [productId]);
    if (movementRows.length === 0) {
      const seed = await readProductInventorySeed(null, productId, inventory.bottleVolumeMl);
      if (seed?.sealedBottles > 0) {
        await query(
          `UPDATE product_inventory
           SET sealed_bottles = ?, bottle_volume_ml = ?, updated_at = SYSUTCDATETIME()
           WHERE product_id = ?`,
          [seed.sealedBottles, seed.bottleVolumeMl, productId]
        );
        return { sealedBottles: seed.sealedBottles, openedMl: 0, bottleVolumeMl: seed.bottleVolumeMl };
      }
    }
  }

  return inventory;
}

// ── ensure a product_inventory row exists ────────────────
export async function ensureProductInventory(transaction, productId, bottleVolumeMl = 100) {
  await ensureDecantInventoryTables();
  const req = new sql.Request(transaction);
  req.input('productId', sql.Int, productId);
  req.input('bottleVolumeMl', sql.Int, bottleVolumeMl);

  const existing = await req.query(
    `SELECT id FROM product_inventory WITH (UPDLOCK, HOLDLOCK, ROWLOCK) WHERE product_id = @productId`
  );
  if (existing.recordset?.length > 0) return existing.recordset[0].id;

  const seed = await readProductInventorySeed(transaction, productId, bottleVolumeMl);
  if (!seed) throw Object.assign(new Error('Khong tim thay san pham'), { code: 400 });
  req.input('sealedBottles', sql.Int, seed.sealedBottles);
  req.input('seedBottleVolumeMl', sql.Int, seed.bottleVolumeMl);

  const insert = await req.query(
    `INSERT INTO product_inventory (product_id, sealed_bottles, opened_ml, bottle_volume_ml)
     VALUES (@productId, @sealedBottles, 0, @seedBottleVolumeMl);
     SELECT SCOPE_IDENTITY() AS id`
  );
  return insert.recordset?.[0]?.id;
}

// ── compute available decant units ───────────────────────
export async function computeDecantStock(transaction, productId, decantVolumeMl) {
  await ensureProductInventory(transaction, productId);

  const req = new sql.Request(transaction);
  req.input('productId', sql.Int, productId);

  const result = await req.query(
    `SELECT sealed_bottles, opened_ml, bottle_volume_ml
     FROM product_inventory WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
     WHERE product_id = @productId`
  );
  const row = result.recordset?.[0];
  if (!row) return { units: 0, totalAvailableMl: 0, sealedBottles: 0, openedMl: 0 };

  const sealedBottles = toInt(row.sealed_bottles);
  const openedMl = toInt(row.opened_ml);
  const bottleVolumeMl = toInt(row.bottle_volume_ml) || 100;
  const totalAvailableMl = openedMl + sealedBottles * bottleVolumeMl;
  const units = decantVolumeMl > 0 ? Math.floor(totalAvailableMl / decantVolumeMl) : 0;

  return { units, totalAvailableMl, sealedBottles, openedMl, bottleVolumeMl };
}

// ── insert a movement record ─────────────────────────────
async function insertMovement(transaction, entry) {
  const req = transaction ? new sql.Request(transaction) : (await getDbPool()).request();
  req.input('productId', sql.Int, entry.productId);
  req.input('batchId', sql.Int, entry.batchId || null);
  req.input('orderId', sql.Int, entry.orderId || null);
  req.input('orderItemId', sql.Int, entry.orderItemId || null);
  req.input('adminId', sql.Int, entry.adminId || null);
  req.input('movementType', sql.NVarChar, entry.movementType);
  req.input('sealedBefore', sql.Int, entry.sealedBefore);
  req.input('sealedAfter', sql.Int, entry.sealedAfter);
  req.input('openedBefore', sql.Int, entry.openedBefore);
  req.input('openedAfter', sql.Int, entry.openedAfter);
  req.input('quantityMl', sql.Int, entry.quantityMl || null);
  req.input('quantityBottles', sql.Int, entry.quantityBottles || null);
  req.input('reference', sql.NVarChar, entry.reference || null);

  await req.query(
    `INSERT INTO inventory_movements
       (product_id, batch_id, order_id, order_item_id, admin_id, movement_type,
        sealed_bottles_before, sealed_bottles_after,
        opened_ml_before, opened_ml_after,
        quantity_ml, quantity_bottles, reference)
     VALUES (@productId, @batchId, @orderId, @orderItemId, @adminId, @movementType,
             @sealedBefore, @sealedAfter, @openedBefore, @openedAfter,
             @quantityMl, @quantityBottles, @reference)`
  );
}

export async function recordDecantMovement(transaction, entry) {
  if (!transaction) await ensureDecantInventoryTables();
  return insertMovement(transaction, entry);
}

// ── CORE: decrement for decant sale ──────────────────────
// Auto-opens sealed bottles when opened_ml is insufficient.
export async function decrementDecantInventory(transaction, {
  productId, neededMl, orderId = null, orderItemId = null,
}) {
  await ensureProductInventory(transaction, productId);

  const req = new sql.Request(transaction);
  req.input('productId', sql.Int, productId);
  req.input('neededMl', sql.Int, neededMl);

  // Lock and read current state
  const current = await req.query(
    `SELECT sealed_bottles, opened_ml, bottle_volume_ml
     FROM product_inventory WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
     WHERE product_id = @productId`
  );
  const row = current.recordset?.[0];
  if (!row) throw Object.assign(new Error('Không tìm thấy tồn kho sản phẩm'), { code: 400 });

  let sealed = toInt(row.sealed_bottles);
  let opened = toInt(row.opened_ml);
  const bottleVol = toInt(row.bottle_volume_ml) || 100;
  const totalAvailable = opened + sealed * bottleVol;

  if (totalAvailable < neededMl) {
    throw inventoryShortage('Không đủ dung tích để chiết');
  }

  let bottlesOpened = 0;
  const sealedBefore = sealed;
  const openedBefore = opened;

  // Open bottles if needed
  if (opened < neededMl) {
    const deficit = neededMl - opened;
    bottlesOpened = Math.ceil(deficit / bottleVol);
    if (sealed < bottlesOpened) {
      throw inventoryShortage('Không đủ chai nguyên seal để mở');
    }
    sealed -= bottlesOpened;
    opened += bottlesOpened * bottleVol;

    // Record BOTTLE_OPEN movement
    await insertMovement(transaction, {
      productId, orderId, orderItemId,
      movementType: 'BOTTLE_OPEN',
      sealedBefore: sealedBefore,
      sealedAfter: sealed,
      openedBefore: openedBefore,
      openedAfter: opened,
      quantityBottles: bottlesOpened,
      reference: `Mở ${bottlesOpened} chai để chiết`,
    });
  }

  // Subtract the decant amount
  const openedBeforeSale = opened;
  opened -= neededMl;

  // Record DECANT_SALE movement
  await insertMovement(transaction, {
    productId, orderId, orderItemId,
    movementType: 'DECANT_SALE',
    sealedBefore: sealed,
    sealedAfter: sealed,
    openedBefore: openedBeforeSale,
    openedAfter: opened,
    quantityMl: neededMl,
    reference: `Bán ${neededMl}ml chiết`,
  });

  // Persist
  const update = new sql.Request(transaction);
  update.input('productId', sql.Int, productId);
  update.input('sealed', sql.Int, sealed);
  update.input('opened', sql.Int, opened);
  await update.query(
    `UPDATE product_inventory
     SET sealed_bottles = @sealed, opened_ml = @opened, updated_at = SYSUTCDATETIME()
     WHERE product_id = @productId`
  );

  return { sealedBottlesAfter: sealed, openedMlAfter: opened, bottlesOpened };
}

// ── decrement for full bottle sale ───────────────────────
export async function decrementFullBottleInventory(transaction, {
  productId, quantity = 1, orderId = null,
}) {
  await ensureProductInventory(transaction, productId);

  const req = new sql.Request(transaction);
  req.input('productId', sql.Int, productId);
  req.input('quantity', sql.Int, quantity);

  const current = await req.query(
    `SELECT sealed_bottles, opened_ml, bottle_volume_ml
     FROM product_inventory WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
     WHERE product_id = @productId`
  );
  const row = current.recordset?.[0];
  if (!row) throw Object.assign(new Error('Không tìm thấy tồn kho sản phẩm'), { code: 400 });

  const sealed = toInt(row.sealed_bottles);
  if (sealed < quantity) {
    throw inventoryShortage('Không đủ chai nguyên seal');
  }

  const sealedBefore = sealed;
  const sealedAfter = sealed - quantity;
  const openedMl = toInt(row.opened_ml);

  await insertMovement(transaction, {
    productId, orderId,
    movementType: 'BOTTLE_SALE',
    sealedBefore,
    sealedAfter,
    openedBefore: openedMl,
    openedAfter: openedMl,
    quantityBottles: quantity,
    reference: `Bán ${quantity} chai full`,
  });

  const update = new sql.Request(transaction);
  update.input('productId', sql.Int, productId);
  update.input('sealed', sql.Int, sealedAfter);
  await update.query(
    `UPDATE product_inventory
     SET sealed_bottles = @sealed, updated_at = SYSUTCDATETIME()
     WHERE product_id = @productId`
  );

  return { sealedBottlesAfter: sealedAfter, openedMlAfter: openedMl };
}

// ── restore inventory on order cancel ────────────────────
export async function restoreDecantInventory(transaction, {
  productId, neededMl = 0, isFullBottle = false, quantity = 1, orderId = null,
}) {
  await ensureProductInventory(transaction, productId);

  const req = new sql.Request(transaction);
  req.input('productId', sql.Int, productId);
  const current = await req.query(
    `SELECT sealed_bottles, opened_ml, bottle_volume_ml
     FROM product_inventory WITH (UPDLOCK, HOLDLOCK, ROWLOCK)
     WHERE product_id = @productId`
  );
  const row = current.recordset?.[0];
  if (!row) return { sealedBottles: 0, openedMl: 0 };

  let sealed = toInt(row.sealed_bottles);
  let opened = toInt(row.opened_ml);
  const sealedBefore = sealed;
  const openedBefore = opened;

  if (isFullBottle) {
    const bottleQuantity = Math.max(1, toInt(quantity, 1));
    sealed += bottleQuantity;
    await insertMovement(transaction, {
      productId, orderId,
      movementType: 'CANCEL',
      sealedBefore, sealedAfter: sealed,
      openedBefore: opened, openedAfter: opened,
      quantityBottles: bottleQuantity,
      reference: 'Hoàn chai full khi hủy đơn',
    });
  } else if (neededMl > 0) {
    opened += neededMl;
    await insertMovement(transaction, {
      productId, orderId,
      movementType: 'CANCEL',
      sealedBefore, sealedAfter: sealed,
      openedBefore, openedAfter: opened,
      quantityMl: neededMl,
      reference: 'Hoàn ml chiết khi hủy đơn',
    });
  }

  const update = new sql.Request(transaction);
  update.input('productId', sql.Int, productId);
  update.input('sealed', sql.Int, sealed);
  update.input('opened', sql.Int, opened);
  await update.query(
    `UPDATE product_inventory
     SET sealed_bottles = @sealed, opened_ml = @opened, updated_at = SYSUTCDATETIME()
     WHERE product_id = @productId`
  );

  return { sealedBottles: sealed, openedMl: opened };
}

// ── sync variant stock_quantity from product_inventory ───
// FULL variants -> stock_quantity = sealed_bottles
// DECANT variants -> stock_quantity = floor(total_ml / variant.volume_ml)
export async function syncVariantStock(productId) {
  const capabilities = await getProductStorageCapabilities();
  if (!capabilities.hasVariants || !hasColumn(capabilities.variantColumns, 'stock_quantity')) return;

  const inventory = await getProductInventory(productId);
  const activeConditions = ['product_id = ?'];
  if (hasColumn(capabilities.variantColumns, 'status')) activeConditions.push('ISNULL(status, 1) = 1');
  if (hasColumn(capabilities.variantColumns, 'deleted_at')) activeConditions.push('deleted_at IS NULL');
  const typeSelect = hasColumn(capabilities.variantColumns, 'variant_type') ? 'variant_type' : "'' AS variant_type";
  const volumeSelect = hasColumn(capabilities.variantColumns, 'volume_ml') ? 'volume_ml' : 'NULL AS volume_ml';
  const updatedAt = hasColumn(capabilities.variantColumns, 'updated_at') ? ', updated_at = GETDATE()' : '';
  const variants = await query(
    `SELECT id, ${typeSelect}, ${volumeSelect} FROM product_variants
     WHERE ${activeConditions.join(' AND ')}`,
    [productId]
  );

  for (const variant of variants) {
    const type = String(variant.variant_type || '').toUpperCase();
    let newStock = 0;

    if (type === 'DECANT') {
      const decantVolume = toInt(variant.volume_ml) || 1;
      const totalMl = inventory.openedMl + inventory.sealedBottles * inventory.bottleVolumeMl;
      newStock = Math.floor(totalMl / decantVolume);
    } else {
      newStock = inventory.sealedBottles;
    }

    await query(
      `UPDATE product_variants SET stock_quantity = ?${updatedAt} WHERE id = ?`,
      [newStock, variant.id]
    );
  }
}

// ── admin: open sealed bottles ───────────────────────────
export async function adminOpenBottles({ productId, quantity, reason = '', userId = null }) {
  const inv = await getProductInventory(productId);
  if (inv.sealedBottles < quantity) {
    return { error: { status: 400, message: 'Không đủ chai nguyên seal để mở' } };
  }

  const sealedAfter = inv.sealedBottles - quantity;
  const openedAfter = inv.openedMl + quantity * inv.bottleVolumeMl;

  await query(
    `UPDATE product_inventory SET sealed_bottles = ?, opened_ml = ?, updated_at = GETDATE()
     WHERE product_id = ?`,
    [sealedAfter, openedAfter, productId]
  );

  await query(
    `INSERT INTO inventory_movements
       (product_id, movement_type, sealed_bottles_before, sealed_bottles_after,
        opened_ml_before, opened_ml_after, quantity_bottles, reference)
     VALUES (?, N'BOTTLE_OPEN', ?, ?, ?, ?, ?, ?)`,
    [productId, inv.sealedBottles, sealedAfter, inv.openedMl, openedAfter, quantity, reason || 'Admin mở chai']
  );

  await syncVariantStock(productId);
  return { sealedBottles: sealedAfter, openedMl: openedAfter, bottleVolumeMl: inv.bottleVolumeMl };
}

// ── admin: restock sealed bottles ────────────────────────
export async function adminRestockBottles({ productId, quantity, reason = '', userId = null }) {
  const inv = await getProductInventory(productId);

  const sealedAfter = inv.sealedBottles + quantity;

  await query(
    `UPDATE product_inventory SET sealed_bottles = ?, updated_at = GETDATE()
     WHERE product_id = ?`,
    [sealedAfter, productId]
  );

  await query(
    `INSERT INTO inventory_movements
       (product_id, movement_type, sealed_bottles_before, sealed_bottles_after,
        opened_ml_before, opened_ml_after, quantity_bottles, reference)
     VALUES (?, N'BOTTLE_RESTOCK', ?, ?, ?, ?, ?, ?)`,
    [productId, inv.sealedBottles, sealedAfter, inv.openedMl, inv.openedMl, quantity, reason || 'Admin nhập chai']
  );

  await syncVariantStock(productId);
  return { sealedBottles: sealedAfter, openedMl: inv.openedMl, bottleVolumeMl: inv.bottleVolumeMl };
}

// ── admin: direct inventory adjustment ───────────────────
export async function adminAdjustDecant({ productId, sealedBottlesDelta = 0, openedMlDelta = 0, reason = '', userId = null }) {
  const inv = await getProductInventory(productId);

  const sealedAfter = inv.sealedBottles + sealedBottlesDelta;
  const openedAfter = inv.openedMl + openedMlDelta;

  if (sealedAfter < 0 || openedAfter < 0) {
    return { error: { status: 400, message: 'Số tồn kho không thể âm' } };
  }

  await query(
    `UPDATE product_inventory SET sealed_bottles = ?, opened_ml = ?, updated_at = GETDATE()
     WHERE product_id = ?`,
    [sealedAfter, openedAfter, productId]
  );

  await query(
    `INSERT INTO inventory_movements
       (product_id, movement_type, sealed_bottles_before, sealed_bottles_after,
        opened_ml_before, opened_ml_after, quantity_bottles, quantity_ml, reference)
     VALUES (?, N'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?)`,
    [productId, inv.sealedBottles, sealedAfter, inv.openedMl, openedAfter, sealedBottlesDelta, openedMlDelta, reason || 'Admin điều chỉnh']
  );

  await syncVariantStock(productId);
  return { sealedBottles: sealedAfter, openedMl: openedAfter, bottleVolumeMl: inv.bottleVolumeMl };
}

// ── admin: movement history ──────────────────────────────
export async function getDecantMovements({ productId = null, page = 1, pageSize = 20 }) {
  await ensureDecantInventoryTables();
  const params = [];
  let where = '';

  if (productId) {
    where = 'WHERE m.product_id = ?';
    params.push(productId);
  }

  const countRows = await query(
    `SELECT COUNT(*) AS total FROM inventory_movements m ${where}`,
    params
  );
  const total = countRows[0]?.total || 0;

  const rows = await query(
    `SELECT m.*, p.name AS product_name, pb.batch_code, u.name AS admin_name
     FROM inventory_movements m
     LEFT JOIN products p ON p.id = m.product_id
     LEFT JOIN product_batches pb ON pb.id = m.batch_id
     LEFT JOIN users u ON u.id = m.admin_id
     ${where}
     ORDER BY m.created_at DESC
     OFFSET ? ROWS FETCH NEXT ? ROWS ONLY`,
    [...params, (page - 1) * pageSize, pageSize]
  );

  return {
    content: rows,
    page: Number(page),
    size: Number(pageSize),
    totalElements: total,
    totalPages: Math.ceil(total / pageSize),
    first: page == 1,
    last: page * pageSize >= total,
  };
}
