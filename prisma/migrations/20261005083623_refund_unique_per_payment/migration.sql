-- DropIndex
DROP INDEX "Refund_paymentId_status_key";

-- CreateIndex
CREATE UNIQUE INDEX "Refund_paymentId_key" ON "Refund"("paymentId");

