/**
 * Webhook security: signature verification, raw-body integrity, replay
 * deduplication, and amount cross-checking.
 *
 * PAID may only be reached through a signature-verified webhook. These tests
 * assert that nothing else can move a payment into a paid state.
 */

import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/api/app";
import { prisma } from "../src/database/prisma";
import {
  createBooking,
  createHost,
  createPayment,
  createRoom,
  getBooking,
  getPayment,
  ledgerCount,
  postWebhook,
  resetDb,
  sendWebhook,
  signedWebhook,
} from "./helpers/fixtures";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

async function setupPayment(pricePerNight = 100_000) {
  const host = await createHost();
  const room = await createRoom(host.id, pricePerNight);
  const booking = (await createBooking(app, { roomId: room.id })).body.booking;
  const paymentRes = await createPayment(app, booking.id, booking.trackingToken);
  const payment = await prisma.payment.findUnique({ where: { id: paymentRes.body.payment.id } });
  return { host, room, booking, payment: payment! };
}

describe("successful payment webhook", () => {
  it("moves payment to PAID and booking to CONFIRMED", async () => {
    const { payment, booking } = await setupPayment();

    const res = await sendWebhook(app, payment, "PAID", "evt-happy-1");

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.status).toBe("PAID");

    expect((await getPayment(payment.id))?.status).toBe("PAID");
    expect((await getBooking(booking.id))?.status).toBe("CONFIRMED");
  });

  it("writes exactly four ledger entries with the correct invariant", async () => {
    const { payment } = await setupPayment(825_000);
    await sendWebhook(app, payment, "PAID", "evt-ledger-1");

    const entries = await prisma.ledgerEntry.findMany({ where: { paymentId: payment.id } });
    expect(entries).toHaveLength(4);

    const byType: Record<string, number> = {};
    for (const e of entries) byType[e.type] = e.amount;

    expect(byType.FULL_PAYMENT).toBe(payment.amount);
    expect(byType.HOST_REVENUE + byType.PLATFORM_REVENUE + byType.GATEWAY_FEE).toBe(
      byType.FULL_PAYMENT,
    );
    // 1000 bps platform fee, 0 bps gateway fee.
    expect(byType.PLATFORM_REVENUE).toBe(Math.floor(payment.amount / 10));
    expect(byType.GATEWAY_FEE).toBe(0);
  });

  it("records a payment event for the state change", async () => {
    const { payment } = await setupPayment();
    await sendWebhook(app, payment, "PAID", "evt-event-1");

    const events = await prisma.paymentEvent.findMany({ where: { paymentId: payment.id } });
    const change = events.find((e) => e.toState === "PAID");
    expect(change).toBeTruthy();
    expect(change?.fromState).toBe("PENDING");
  });

  it("creates a notification for the guest", async () => {
    const { payment, booking } = await setupPayment();
    await sendWebhook(app, payment, "PAID", "evt-notify-1");

    const notes = await prisma.notification.findMany({ where: { bookingId: booking.id } });
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });
});

describe("invalid webhook signature rejection", () => {
  it("rejects a forged signature and leaves state untouched", async () => {
    const { payment } = await setupPayment();
    const signed = signedWebhook({
      eventId: "evt-forged-1",
      providerRef: payment.providerRef!,
      paymentId: payment.id,
      status: "PAID",
      amount: payment.amount,
    });

    const res = await postWebhook(app, {
      rawBody: signed.rawBody,
      headers: { "x-mock-signature": "sha256=" + "0".repeat(64) },
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("WEBHOOK_ERROR");
    expect((await getPayment(payment.id))?.status).toBe("PENDING");
    expect(await ledgerCount(payment.id)).toBe(0);
  });

  it("rejects a webhook with no signature header", async () => {
    const { payment } = await setupPayment();
    const signed = signedWebhook({
      eventId: "evt-nosig-1",
      providerRef: payment.providerRef!,
      paymentId: payment.id,
      status: "PAID",
      amount: payment.amount,
    });

    const res = await request(app)
      .post("/api/payments/webhook?provider=mock")
      .set("Content-Type", "application/json")
      .send(signed.rawBody);

    expect(res.status).toBe(400);
    expect((await getPayment(payment.id))?.status).toBe("PENDING");
  });

  it("rejects a body that was modified after signing", async () => {
    const { payment } = await setupPayment();
    const signed = signedWebhook({
      eventId: "evt-tampered-body-1",
      providerRef: payment.providerRef!,
      paymentId: payment.id,
      status: "PAID",
      amount: payment.amount,
    });

    // Valid signature, but the body no longer matches it.
    const mutated = signed.rawBody.replace('"PAID"', '"FAILED"');
    const res = await postWebhook(app, {
      rawBody: mutated,
      headers: signed.headers,
    });

    expect(res.status).toBe(400);
    expect((await getPayment(payment.id))?.status).toBe("PENDING");
  });

  it("does not reveal the expected signature in the error", async () => {
    const { payment } = await setupPayment();
    const signed = signedWebhook({
      eventId: "evt-leak-1",
      providerRef: payment.providerRef!,
      paymentId: payment.id,
      status: "PAID",
      amount: payment.amount,
    });

    const res = await postWebhook(app, {
      rawBody: signed.rawBody,
      headers: { "x-mock-signature": "sha256=deadbeef" },
    });

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(signed.headers["x-mock-signature"]!);
  });
});

describe("webhook replay and deduplication", () => {
  it("treats a replayed event id as a duplicate and does not double-post", async () => {
    const { payment, booking } = await setupPayment();
    const signed = signedWebhook({
      eventId: "evt-replay-1",
      providerRef: payment.providerRef!,
      paymentId: payment.id,
      status: "PAID",
      amount: payment.amount,
    });

    const first = await postWebhook(app, signed);
    const second = await postWebhook(app, signed);

    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);

    expect(await ledgerCount(payment.id)).toBe(4);
    expect(await ledgerCount(payment.id, "FULL_PAYMENT")).toBe(1);
    expect((await getBooking(booking.id))?.status).toBe("CONFIRMED");
    expect(await prisma.notification.count({ where: { bookingId: booking.id } })).toBe(1);
  });

  it("treats a different event id for an already-PAID payment as a no-op", async () => {
    const { payment } = await setupPayment();

    await sendWebhook(app, payment, "PAID", "evt-first-pay");
    const second = await sendWebhook(app, payment, "PAID", "evt-second-pay");

    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(await ledgerCount(payment.id)).toBe(4);
  });

  it("records every received webhook in the audit table", async () => {
    const { payment } = await setupPayment();
    await sendWebhook(app, payment, "PAID", "evt-audit-1");
    await sendWebhook(app, payment, "PAID", "evt-audit-1");

    const rows = await prisma.webhookEvent.findMany({ where: { eventId: "evt-audit-1" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processed).toBe(true);
  });

  it("keeps ledger consistent under concurrent PAID webhooks with different event ids", async () => {
    const { payment } = await setupPayment();

    const a = signedWebhook({
      eventId: "evt-race-a",
      providerRef: payment.providerRef!,
      paymentId: payment.id,
      status: "PAID",
      amount: payment.amount,
    });
    const b = signedWebhook({
      eventId: "evt-race-b",
      providerRef: payment.providerRef!,
      paymentId: payment.id,
      status: "PAID",
      amount: payment.amount,
    });

    await Promise.allSettled([postWebhook(app, a), postWebhook(app, b)]);

    expect(await ledgerCount(payment.id)).toBe(4);
    expect(await ledgerCount(payment.id, "FULL_PAYMENT")).toBe(1);
    expect((await getPayment(payment.id))?.status).toBe("PAID");
  });
});

describe("amount tampering rejection", () => {
  it("rejects a signed webhook whose amount differs from the payment", async () => {
    const { payment } = await setupPayment(825_000);

    const res = await sendWebhook(app, payment, "PAID", "evt-tamper-amount", 1);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("PAYMENT_ERROR");
    expect((await getPayment(payment.id))?.status).toBe("PENDING");
    expect(await ledgerCount(payment.id)).toBe(0);
  });

  it("rejects an underpayment that is still non-zero", async () => {
    const { payment } = await setupPayment(500_000);

    const res = await sendWebhook(app, payment, "PAID", "evt-underpay-1", 499_999);

    expect(res.status).toBe(422);
    expect((await getPayment(payment.id))?.status).toBe("PENDING");
  });

  it("marks the webhook row as failed when the amount does not match", async () => {
    const { payment } = await setupPayment();
    await sendWebhook(app, payment, "PAID", "evt-tamper-mark", 1);

    const row = await prisma.webhookEvent.findFirst({ where: { eventId: "evt-tamper-mark" } });
    expect(row?.processed).toBe(false);
    expect(row?.error).toBeTruthy();
  });
});

describe("unknown payment provider handling", () => {
  it("returns 404 for an unknown provider instead of 500", async () => {
    const res = await request(app)
      .post("/api/payments/webhook?provider=bogus")
      .set("Content-Type", "application/json")
      .send("{}");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for a declared but unimplemented provider", async () => {
    const res = await request(app)
      .post("/api/payments/webhook?provider=midtrans")
      .set("Content-Type", "application/json")
      .send("{}");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a webhook whose provider does not match the payment", async () => {
    const { payment } = await setupPayment();
    const signed = signedWebhook({
      eventId: "evt-wrong-provider",
      providerRef: payment.providerRef!,
      paymentId: payment.id,
      status: "PAID",
      amount: payment.amount,
    });

    // Signed correctly, but routed as a different provider name.
    const res = await request(app)
      .post("/api/payments/webhook?provider=xendit")
      .set("Content-Type", "application/json")
      .set("x-mock-signature", signed.headers["x-mock-signature"]!)
      .send(signed.rawBody);

    expect(res.status).toBe(400);
    expect((await getPayment(payment.id))?.status).toBe("PENDING");
  });
});

describe("mock checkout page is not a paid bypass", () => {
  it("refuses the checkout page without the tracking token", async () => {
    const { payment, booking } = await setupPayment();
    const txn = payment.providerRef!;

    const res = await request(app).get(`/api/mock-payment/${txn}`);

    expect([400, 404]).toContain(res.status);
    expect(res.text).not.toContain("data-sig");
    // Sanity: the token really is required.
    const withToken = await request(app).get(
      `/api/mock-payment/${txn}?token=${encodeURIComponent(booking.trackingToken)}`,
    );
    expect(withToken.status).toBe(200);
  });

  it("refuses the checkout page with a wrong tracking token", async () => {
    const { payment } = await setupPayment();
    const res = await request(app).get(`/api/mock-payment/${payment.providerRef!}?token=${"y".repeat(43)}`);
    expect(res.status).toBe(404);
  });
});
