import { getDbPool, query, sql } from '../../config/database.js';

let paymentAttemptStoragePromise = null;

export async function ensurePaymentAttemptStorage() {
  if (!paymentAttemptStoragePromise) {
    paymentAttemptStoragePromise = query(`
      IF OBJECT_ID(N'dbo.orders', N'U') IS NOT NULL
      BEGIN
        IF COL_LENGTH(N'dbo.orders', N'order_code') IS NULL
          ALTER TABLE dbo.orders ADD order_code NVARCHAR(50) NULL;

        IF COL_LENGTH(N'dbo.orders', N'payment_status') IS NULL
          ALTER TABLE dbo.orders ADD payment_status NVARCHAR(30) NULL;

        IF COL_LENGTH(N'dbo.orders', N'failure_reason') IS NULL
          ALTER TABLE dbo.orders ADD failure_reason NVARCHAR(500) NULL;

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
      END;

      IF OBJECT_ID(N'dbo.payment_attempts', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.payment_attempts (
          id INT IDENTITY(1,1) PRIMARY KEY,
          order_id INT NOT NULL,
          provider NVARCHAR(20) NOT NULL,
          attempt_number INT NOT NULL,
          request_id NVARCHAR(120) NOT NULL,
          external_order_id NVARCHAR(160) NULL,
          amount FLOAT NOT NULL,
          status NVARCHAR(30) NOT NULL CONSTRAINT DF_payment_attempts_status DEFAULT N'CREATED',
          result_code NVARCHAR(50) NULL,
          message NVARCHAR(500) NULL,
          transaction_id NVARCHAR(160) NULL,
          pay_url NVARCHAR(MAX) NULL,
          raw_response NVARCHAR(MAX) NULL,
          created_at DATETIME2 NOT NULL CONSTRAINT DF_payment_attempts_created_at DEFAULT SYSUTCDATETIME(),
          updated_at DATETIME2 NULL,
          CONSTRAINT FK_payment_attempts_orders FOREIGN KEY (order_id) REFERENCES dbo.orders(id)
        );
      END;

      IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.payment_attempts')
          AND name = N'UX_payment_attempts_request_id'
      )
        CREATE UNIQUE INDEX UX_payment_attempts_request_id ON dbo.payment_attempts(request_id);

      IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.payment_attempts')
          AND name = N'IX_payment_attempts_external_order_id'
      )
        CREATE INDEX IX_payment_attempts_external_order_id ON dbo.payment_attempts(provider, external_order_id)
        WHERE external_order_id IS NOT NULL;
    `);
    paymentAttemptStoragePromise = paymentAttemptStoragePromise.catch((error) => {
      paymentAttemptStoragePromise = null;
      throw error;
    });
  }
  return paymentAttemptStoragePromise;
}

function toAttempt(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    orderId: Number(row.order_id),
    provider: row.provider,
    attemptNumber: Number(row.attempt_number || 0),
    requestId: row.request_id,
    externalOrderId: row.external_order_id || '',
    amount: Number(row.amount || 0),
    status: row.status,
    resultCode: row.result_code || '',
    message: row.message || '',
    transactionId: row.transaction_id || '',
    payUrl: row.pay_url || '',
    rawResponse: row.raw_response || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createPaymentAttempt({ orderId, provider, amount }) {
  await ensurePaymentAttemptStorage();

  const pool = await getDbPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const selectRequest = new sql.Request(transaction);
    selectRequest.input('orderId', sql.Int, Number(orderId));
    const maxResult = await selectRequest.query(
      `SELECT ISNULL(MAX(attempt_number), 0) AS max_attempt
       FROM dbo.payment_attempts WITH (UPDLOCK, HOLDLOCK)
       WHERE order_id = @orderId`
    );
    const attemptNumber = Number(maxResult.recordset?.[0]?.max_attempt || 0) + 1;
    const requestId = `HPF_${orderId}_ATTEMPT_${attemptNumber}`;

    const insertRequest = new sql.Request(transaction);
    insertRequest.input('orderId', sql.Int, Number(orderId));
    insertRequest.input('provider', sql.NVarChar, String(provider || '').toUpperCase());
    insertRequest.input('attemptNumber', sql.Int, attemptNumber);
    insertRequest.input('requestId', sql.NVarChar, requestId);
    insertRequest.input('amount', sql.Float, Number(amount || 0));
    const result = await insertRequest.query(
      `INSERT INTO dbo.payment_attempts
        (order_id, provider, attempt_number, request_id, amount, status)
       OUTPUT inserted.*
       VALUES (@orderId, @provider, @attemptNumber, @requestId, @amount, N'CREATED')`
    );

    await transaction.commit();
    return toAttempt(result.recordset?.[0]);
  } catch (error) {
    try { await transaction.rollback(); } catch {}
    throw error;
  }
}

export async function updatePaymentAttempt(attemptId, patch = {}) {
  await ensurePaymentAttemptStorage();

  const assignments = ['updated_at = SYSUTCDATETIME()'];
  const params = [];
  const map = [
    ['externalOrderId', 'external_order_id'],
    ['status', 'status'],
    ['resultCode', 'result_code'],
    ['message', 'message'],
    ['transactionId', 'transaction_id'],
    ['payUrl', 'pay_url'],
    ['rawResponse', 'raw_response'],
  ];

  for (const [key, column] of map) {
    if (patch[key] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(patch[key] === null ? null : String(patch[key]));
    }
  }

  if (assignments.length === 1) return null;
  params.push(Number(attemptId));
  const rows = await query(
    `UPDATE dbo.payment_attempts
     SET ${assignments.join(', ')}
     OUTPUT inserted.*
     WHERE id = ?`,
    params
  );
  return toAttempt(rows[0]);
}

export async function findPaymentAttemptByExternalOrderId(provider, externalOrderId) {
  await ensurePaymentAttemptStorage();
  const rows = await query(
    `SELECT TOP 1 *
     FROM dbo.payment_attempts
     WHERE provider = ? AND external_order_id = ?
     ORDER BY id DESC`,
    [String(provider || '').toUpperCase(), String(externalOrderId || '')]
  );
  return toAttempt(rows[0]);
}

export async function listPaymentAttemptsForOrder(orderId) {
  await ensurePaymentAttemptStorage();
  const rows = await query(
    `SELECT *
     FROM dbo.payment_attempts
     WHERE order_id = ?
     ORDER BY attempt_number DESC, id DESC`,
    [Number(orderId)]
  );
  return rows.map(toAttempt);
}
