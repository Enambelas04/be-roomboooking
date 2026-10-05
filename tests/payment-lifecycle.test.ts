/**
 * Payment lifecycle: failure, retry, expiry, and terminal-state handling.
 *
 * The retry path matters because a booking that has failed once must still be
 * payable — otherwise a transient provider failure strands the guest.
 */

import { beforeEach, describe, expect, it } from "vitest";
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
  resetDb,
  sendWebhook,
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

describe("FAILED payment handling", () => {
  it("moves payment to FAILED and booking to PAYMENT_FAILED", async () => {
    const { payment, booking } = await setupPayment();

    const res = await sendWebhook(app, payment, "FAILED", "evt-fail-1");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("FAILED");
    expect((await getPayment(payment.id))?.status).toBe("FAILED");
    expect((await getBooking(booking.id))?.status).toBe("PAYMENT_FAILED");
  });

  it("does not write ledger entries on failure", async () => {
    const { payment } = await setupPayment();
    await sendWebhook(app, payment, "FAILED", "evt-fail-noledger");
    expect(await ledgerCount(payment.id)).toBe(0);
  });
});

describe("FAILED payment retry", () => {
  it("returns the booking to PENDING_PAYMENT when a new payment is created", async () => {
    const { payment, booking } = await setupPayment();
    await sendWebhook(app, payment, "FAILED", "evt-retry-fail");

    expect((await getBooking(booking.id))?.status).toBe("PAYMENT_FAILED");

    const retry = await createPayment(app, booking.id, booking.trackingToken, "retry-key-1");

    expect(retry.status).toBe(201);
    expect((await getBooking(booking.id))?.status).toBe("PENDING_PAYMENT");
  });

  it("allows the retried payment to reach PAID and confirm the booking", async () => {
    const { payment, booking } = await setupPayment();
    await sendWebhook(app, payment, "FAILED", "evt-retry-fail-2");

    const retry = await createPayment(app, booking.id, booking.trackingToken, "retry-key-2");
    const retryPayment = await prisma.payment.findUnique({ where: { id: retry.body.payment.id } });

    const res = await sendWebhook(app, retryPayment!, "PAID", "evt-retry-paid");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PAID");
    expect((await getPayment(retryPayment!.id))?.status).toBe("PAID");
    expect((await getBooking(booking.id))?.status).toBe("CONFIRMED");
    expect(await ledgerCount(retryPayment!.id)).toBe(4);
  });

  it("does not let the original failed payment confirm the booking", async () => {
    const { payment, booking } = await setupPayment();
    await sendWebhook(app, payment, "FAILED", "evt-fail-then-late");

    // The provider later sends PAID for the ORIGINAL (failed) payment.
    const late = await sendWebhook(app, payment, "PAID", "evt-late-paid");

    // Terminal-state handling acknowledges it without advancing state.
    expect(late.status).toBe(200);
    expect((await getPayment(payment.id))?.status).toBe("FAILED");
    expect((await getBooking(booking.id))?.status).toBe("PAYMENT_FAILED");
  });
});

describe("EXPIRED payment handling", () => {
  it("moves payment and booking to EXPIRED", async () => {
    const { payment, booking } = await setupPayment();

    const res = await sendWebhook(app, payment, "EXPIRED", "evt-expire-1");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("EXPIRED");
    expect((await getPayment(payment.id))?.status).toBe("EXPIRED");
    expect((await getBooking(booking.id))?.status).toBe("EXPIRED");
  });

  it("refuses to create a payment for an expired booking", async () => {
    const { payment, booking } = await setupPayment();
    await sendWebhook(app, payment, "EXPIRED", "evt-expire-2");

    const res = await createPayment(app, booking.id, booking.trackingToken, "after-expire-1");

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("treats a stale EXPIRED after FAILED as a no-op rather than an error", async () => {
    const { payment } = await setupPayment();
    await sendWebhook(app, payment, "FAILED", "evt-terminal-fail");

    const stale = await sendWebhook(app, payment, "EXPIRED", "evt-stale-expire");

    expect(stale.status).toBe(200);
    expect(stale.body.duplicate).toBe(true);
    expect((await getPayment(payment.id))?.status).toBe("FAILED");
  });

  it("marks the stale webhook as processed, not failed", async () => {
    const { payment } = await setupPayment();
    await sendWebhook(app, payment, "FAILED", "evt-terminal-fail-2");
    await sendWebhook(app, payment, "EXPIRED", "evt-stale-expire-2");

    const row = await prisma.webhookEvent.findFirst({ where: { eventId: "evt-stale-expire-2" } });
    expect(row?.processed).toBe(true);
    expect(row?.error).toBeNull();
  });
});

describe("terminal state is final", () => {
  it("ignores a FAILED webhook after the payment is PAID", async () => {
    const { payment, booking } = await setupPayment();
    await sendWebhook(app, payment, "PAID", "evt-paid-first");

    const late = await sendWebhook(app, payment, "FAILED", "evt-fail-after-paid");

    expect(late.status).toBe(200);
    expect((await getPayment(payment.id))?.status).toBe("PAID");
    expect((await getBooking(booking.id))?.status).toBe("CONFIRMED");
    expect(await ledgerCount(payment.id)).toBe(4);
  });

  it("cannot be moved to PAID twice", async () => {
    const { payment } = await setupPayment();
    await sendWebhook(app, payment, "PAID", "evt-double-paid-a");
    await sendWebhook(app, payment, "PAID", "evt-double-paid-b");

    expect(await ledgerCount(payment.id, "FULL_PAYMENT")).toBe(1);
    expect(await ledgerCount(payment.id)).toBe(4);
  });
});
