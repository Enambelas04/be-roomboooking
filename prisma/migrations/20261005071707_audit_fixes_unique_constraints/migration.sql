-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_paymentId_type_key" ON "LedgerEntry"("paymentId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_paymentId_status_key" ON "Refund"("paymentId", "status");

