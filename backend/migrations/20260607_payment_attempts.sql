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
GO

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
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.payment_attempts')
      AND name = N'UX_payment_attempts_request_id'
)
    CREATE UNIQUE INDEX UX_payment_attempts_request_id ON dbo.payment_attempts(request_id);
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID(N'dbo.payment_attempts')
      AND name = N'IX_payment_attempts_external_order_id'
)
    CREATE INDEX IX_payment_attempts_external_order_id
    ON dbo.payment_attempts(provider, external_order_id)
    WHERE external_order_id IS NOT NULL;
GO
