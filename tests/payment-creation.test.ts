/**
 * Payment creation: authorization, idempotency, and the guarantee that the
 * client cannot influence amount or status.
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
  resetDb,
} from "./helpers/fixtures";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

async function setupBooking(pricePerNight = 100_000) {
  const host = await createHost();
  const room = await createRoom(host.id, pricePerNight);
  const res = await createBooking(app, { roomId: room.id });
  return { host, room, booking: res.body.booking };
}

describe("guest payment creation authorization", () => {
  it("creates a payment when the tracking token is presented", async () => {
    const { booking } = await setupBooking();

    const res = await createPayment(app, booking.id, booking.trackingToken);

    expect(res.status).toBe(201);
    expect(res.body.payment.status).toBe("PENDING");
    expect(res.body.payment.amount).toBe(booking.totalAmount);
    expect(res.body.checkoutUrl).toContain("/mock-payment/");
  });

  it("rejects payment creation without a tracking token", async () => {
    const { booking } = await setupBooking();

    const res = await request(app).post("/api/payments/create").send({ bookingId: booking.id });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects payment creation with a wrong tracking token", async () => {
    const { booking } = await setupBooking();

    const res = await createPayment(app, booking.id, "z".repeat(43));

    expect(res.status).toBe(404);
    const count = await prisma.payment.count({ where: { bookingId: booking.id } });
    expect(count).toBe(0);
  });

  it("does not let one guest create a payment against another guest's booking", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);
    const victim = (await createBooking(app, { roomId: room.id, customerEmail: "victim@example.com" })).body.booking;
    const attacker = (await createBooking(app, { roomId: room.id, checkIn: "2027-09-01", checkOut: "2027-09-02" })).body.booking;

    // The attacker knows their own token but targets the victim's booking id.
    const res = await createPayment(app, victim.id, attacker.trackingToken);

    expect(res.status).toBe(404);
    expect(await prisma.payment.count({ where: { bookingId: victim.id } })).toBe(0);
  });

  it("rejects payment creation for an unknown booking", async () => {
    const res = await createPayment(app, "no-such-booking", "x".repeat(43));
    expect(res.status).toBe(404);
  });
});

describe("client cannot control amount or status", () => {
  it("ignores a client-declared PAID status", async () => {
    const { booking } = await setupBooking(200_000);

    const res = await request(app).post("/api/payments/create").send({
      bookingId: booking.id,
      trackingToken: booking.trackingToken,
      status: "PAID",
      paidAt: new Date().toISOString(),
    });

    expect(res.status).toBe(201);
    expect(res.body.payment.status).toBe("PENDING");
  });

  it("ignores a client-supplied amount", async () => {
    const { booking } = await setupBooking(200_000);

    const res = await request(app).post("/api/payments/create").send({
      bookingId: booking.id,
      trackingToken: booking.trackingToken,
      amount: 1,
    });

    expect(res.status).toBe(201);
    expect(res.body.payment.amount).toBe(booking.totalAmount);
    expect(res.body.payment.amount).not.toBe(1);
  });

  it("leaves the booking in PENDING_PAYMENT after payment creation", async () => {
    const { booking } = await setupBooking();
    await createPayment(app, booking.id, booking.trackingToken);

    const row = await getBooking(booking.id);
    expect(row?.status).toBe("PENDING_PAYMENT");
  });

  it("does not expose providerRef or the idempotency key in the response", async () => {
    const { booking } = await setupBooking();
    const res = await createPayment(app, booking.id, booking.trackingToken, "idem-visible-check-1");

    expect(res.body.payment.providerRef).toBeUndefined();
    expect(res.body.payment.idempotencyKey).toBeUndefined();
  });
});

describe("payment idempotency", () => {
  it("returns the same payment for a repeated idempotency key", async () => {
    const { booking } = await setupBooking();

    const first = await createPayment(app, booking.id, booking.trackingToken, "idem-key-0001");
    const second = await createPayment(app, booking.id, booking.trackingToken, "idem-key-0001");

    expect(first.status).toBe(201);
    expect(first.body.reused).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.payment.id).toBe(first.body.payment.id);

    const count = await prisma.payment.count({ where: { bookingId: booking.id } });
    expect(count).toBe(1);
  });

  it("creates distinct payments for distinct idempotency keys", async () => {
    const { booking } = await setupBooking();

    await createPayment(app, booking.id, booking.trackingToken, "idem-key-aaa");
    await createPayment(app, booking.id, booking.trackingToken, "idem-key-bbb");

    expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(2);
  });

  it("refuses to reuse an idempotency key for a different booking", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);
    const a = (await createBooking(app, { roomId: room.id, checkIn: "2027-10-01", checkOut: "2027-10-02" })).body.booking;
    const b = (await createBooking(app, { roomId: room.id, checkIn: "2027-11-01", checkOut: "2027-11-02" })).body.booking;

    await createPayment(app, a.id, a.trackingToken, "shared-key-xyz");
    const res = await createPayment(app, b.id, b.trackingToken, "shared-key-xyz");

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("does not start a second payment for an already-confirmed booking", async () => {
    const { booking } = await setupBooking();
    const created = await createPayment(app, booking.id, booking.trackingToken);
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED" } });

    const res = await createPayment(app, booking.id, booking.trackingToken, "after-confirm-1");

    expect(res.status).toBe(409);
    expect(created.status).toBe(201);
  });
});
