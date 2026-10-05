/**
 * Refunds and concurrency protection.
 *
 * The refund flow moves real money, so the double-refund race is tested
 * directly: exactly one refund may succeed per payment, and it must produce
 * exactly one REFUND ledger entry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/api/app";
import { prisma } from "../src/database/prisma";
import { paymentService } from "../src/services/PaymentService";
import { MockPaymentGateway } from "../src/payment/MockPaymentGateway";
import {
  createAdmin,
  createBooking,
  createHost,
  createPayment,
  createRoom,
  getBooking,
  getPayment,
  ledgerCount,
  login,
  resetDb,
  sendWebhook,
} from "./helpers/fixtures";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

async function paidPayment(pricePerNight = 100_000) {
  const host = await createHost();
  const room = await createRoom(host.id, pricePerNight);
  const booking = (await createBooking(app, { roomId: room.id })).body.booking;
  const created = await createPayment(app, booking.id, booking.trackingToken);
  const payment = await prisma.payment.findUnique({ where: { id: created.body.payment.id } });
  await sendWebhook(app, payment!, "PAID", `evt-refund-setup-${payment!.id}`);
  return { host, room, booking, payment: payment! };
}

describe("refund behavior", () => {
  it("refunds a PAID payment and updates payment, booking and ledger", async () => {
    const { payment, booking } = await paidPayment(500_000);

    const result = await paymentService.refund(payment.id, "guest requested");

    expect(result.status).toBe("REFUNDED");
    expect((await getPayment(payment.id))?.status).toBe("REFUNDED");
    expect((await getBooking(booking.id))?.status).toBe("REFUNDED");

    const refunds = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.status).toBe("SUCCEEDED");
    expect(refunds[0]?.amount).toBe(payment.amount);

    const refundLedger = await prisma.ledgerEntry.findMany({
      where: { paymentId: payment.id, type: "REFUND" },
    });
    expect(refundLedger).toHaveLength(1);
    expect(refundLedger[0]?.amount).toBe(-payment.amount);
  });

  it("keeps the ledger balanced after a refund", async () => {
    const { payment } = await paidPayment(825_000);
    await paymentService.refund(payment.id);

    const entries = await prisma.ledgerEntry.findMany({ where: { paymentId: payment.id } });
    const byType: Record<string, number> = {};
    for (const e of entries) byType[e.type] = (byType[e.type] ?? 0) + e.amount;

    const splitTotal =
      (byType.HOST_REVENUE ?? 0) + (byType.PLATFORM_REVENUE ?? 0) + (byType.GATEWAY_FEE ?? 0);
    expect(splitTotal).toBe(byType.FULL_PAYMENT);
    expect(byType.REFUND).toBe(-byType.FULL_PAYMENT);
  });

  it("records a REFUNDED payment event", async () => {
    const { payment } = await paidPayment();
    await paymentService.refund(payment.id, "test");

    const events = await prisma.paymentEvent.findMany({
      where: { paymentId: payment.id, toState: "REFUNDED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.fromState).toBe("PAID");
  });

  it("refuses to refund a payment that is not PAID", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);
    const booking = (await createBooking(app, { roomId: room.id })).body.booking;
    const created = await createPayment(app, booking.id, booking.trackingToken);

    await expect(paymentService.refund(created.body.payment.id)).rejects.toThrow(/PAID/i);
  });

  it("refuses a second sequential refund", async () => {
    const { payment } = await paidPayment();
    await paymentService.refund(payment.id, "first");

    await expect(paymentService.refund(payment.id, "second")).rejects.toThrow();

    expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(await ledgerCount(payment.id, "REFUND")).toBe(1);
  });

  it("ignores a PAID webhook arriving after a refund", async () => {
    const { payment } = await paidPayment();
    await paymentService.refund(payment.id);

    const late = await sendWebhook(app, payment, "PAID", "evt-paid-after-refund");

    expect(late.status).toBe(200);
    expect((await getPayment(payment.id))?.status).toBe("REFUNDED");
    expect(await ledgerCount(payment.id, "FULL_PAYMENT")).toBe(1);
  });
});

describe("concurrent / double refund protection", () => {
  it("calls the payment provider exactly once under a concurrent race", async () => {
    const { payment } = await paidPayment(300_000);

    // Count real provider invocations at the prototype level, so the assertion
    // covers the actual gateway call rather than a service-level guess.
    const spy = vi.spyOn(MockPaymentGateway.prototype, "refund");

    const results = await Promise.allSettled([
      paymentService.refund(payment.id, "race A"),
      paymentService.refund(payment.id, "race B"),
      paymentService.refund(payment.id, "race C"),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);

    const calls = spy.mock.calls;
    expect(calls[0]?.[0]?.providerRef).toBe(payment.providerRef);

    // Every caller converges on the same successful outcome.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const rows = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("SUCCEEDED");
    expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(0);
    expect(await ledgerCount(payment.id, "REFUND")).toBe(1);
    expect((await getPayment(payment.id))?.status).toBe("REFUNDED");

    spy.mockRestore();
  });

  it("calls the provider exactly once even under higher concurrency", async () => {
    const { payment } = await paidPayment(400_000);
    const spy = vi.spyOn(MockPaymentGateway.prototype, "refund");

    await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => paymentService.refund(payment.id, `r${i}`)),
    );

    expect(spy).toHaveBeenCalledTimes(1);

    const rows = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("SUCCEEDED");
    expect(await ledgerCount(payment.id, "REFUND")).toBe(1);

    spy.mockRestore();
  });

  it("processes exactly one refund when two run simultaneously", async () => {
    const { payment } = await paidPayment(300_000);

    const results = await Promise.allSettled([
      paymentService.refund(payment.id, "race A"),
      paymentService.refund(payment.id, "race B"),
    ]);

    // Both callers succeed: the loser converges on the winner's result rather
    // than erroring, which is what "one refund intent" means. What must be
    // singular is the refund itself, not the number of successful callers.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    expect(await prisma.refund.count({ where: { paymentId: payment.id, status: "SUCCEEDED" } })).toBe(1);
    expect(await ledgerCount(payment.id, "REFUND")).toBe(1);
    expect((await getPayment(payment.id))?.status).toBe("REFUNDED");

    // The converged callers must report the same outcome.
    const values = results
      .filter(
        (r): r is PromiseFulfilledResult<{ paymentId: string; status: string }> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value.status);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe("REFUNDED");
  });

  it("does not leave a stray pending refund behind after the race", async () => {
    const { payment } = await paidPayment();

    await Promise.allSettled([
      paymentService.refund(payment.id),
      paymentService.refund(payment.id),
      paymentService.refund(payment.id),
    ]);

    const rows = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("SUCCEEDED");
  });

  it("keeps the ledger balanced under a concurrent refund race", async () => {
    const { payment } = await paidPayment(750_000);

    await Promise.allSettled([
      paymentService.refund(payment.id),
      paymentService.refund(payment.id),
    ]);

    const entries = await prisma.ledgerEntry.findMany({ where: { paymentId: payment.id } });
    const refundRows = entries.filter((e) => e.type === "REFUND");
    const full = entries.find((e) => e.type === "FULL_PAYMENT");

    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]?.amount).toBe(-(full?.amount ?? 0));
  });
});

describe("refund authorization", () => {
  it("requires authentication to refund", async () => {
    const { payment } = await paidPayment();
    const res = await request(app).post(`/api/admin/payments/${payment.id}/refund`).send({});
    expect(res.status).toBe(401);
  });

  it("lets an ADMIN refund through the API", async () => {
    const { payment } = await paidPayment();
    await createAdmin();
    const token = await login(app, "admin", "admin@example.com", "adminpass123");

    const res = await request(app)
      .post(`/api/admin/payments/${payment.id}/refund`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "admin refund" });

    expect(res.status).toBe(200);
    expect((await getPayment(payment.id))?.status).toBe("REFUNDED");
  });

  it("refuses a HOST refunding a payment for another host's room", async () => {
    const { payment } = await paidPayment();
    const other = await createHost("other@example.com", "otherpass123");
    const token = await login(app, "host", other.email, "otherpass123");

    const res = await request(app)
      .post(`/api/host/payments/${payment.id}/refund`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(403);
    expect((await getPayment(payment.id))?.status).toBe("PAID");
  });
});
