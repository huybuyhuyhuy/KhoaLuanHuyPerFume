IF OBJECT_ID(N'dbo.orders', N'U') IS NOT NULL
BEGIN
    IF COL_LENGTH(N'dbo.orders', N'failure_reason') IS NULL
        ALTER TABLE dbo.orders ADD failure_reason NVARCHAR(500) NULL;

    DECLARE @ordersStatusCheck SYSNAME;
    SELECT @ordersStatusCheck = cc.name
    FROM sys.check_constraints cc
    WHERE cc.parent_object_id = OBJECT_ID(N'dbo.orders')
      AND cc.name = N'CK_orders_status_canonical';

    IF @ordersStatusCheck IS NOT NULL
    BEGIN
        EXEC(N'ALTER TABLE dbo.orders DROP CONSTRAINT [' + @ordersStatusCheck + N']');
    END;

    ALTER TABLE dbo.orders WITH CHECK ADD CONSTRAINT CK_orders_status_canonical
        CHECK (status IN (
            N'PENDING_PAYMENT', N'PENDING', N'CONFIRMED', N'PACKING', N'SHIPPING',
            N'DELIVERED', N'COMPLETED', N'PAYMENT_REJECTED', N'PAYMENT_FAILED',
            N'CANCELLED_PAYMENT', N'CANCELLED', N'REFUNDED'
        ));
END;
GO
