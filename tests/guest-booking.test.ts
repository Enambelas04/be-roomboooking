/**
 * Guest booking creation and secure tracking.
 *
 * Guests are unauthenticated: booking creation must work with no credentials,
 * the price must be computed server-side, and the booking must only be
 * readable with its unguessable tracking token.
 */

import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/api/app";
import { prisma } from "../src/database/prisma";
import { createBooking, createHost, createRoom, resetDb } from "./helpers/fixtures";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

describe("guest booking creation", () => {
  it("creates a booking without any authentication", async () => {
    const host = await createHost();
    const room = await createRoom(host.id, 100_000);

    const res = await createBooking(app, { roomId: room.id });

    expect(res.status).toBe(201);
    expect(res.body.booking.status).toBe("PENDING_PAYMENT");
    expect(res.body.booking.id).toBeTruthy();
  });

  it("computes nights and total server-side from the room price", async () => {
    const host = await createHost();
    const room = await createRoom(host.id, 825_000);

    const res = await createBooking(app, {
      roomId: room.id,
      checkIn: "2027-03-01",
      checkOut: "2027-03-04",
    });

    expect(res.status).toBe(201);
    expect(res.body.booking.nights).toBe(3);
    expect(res.body.booking.totalAmount).toBe(825_000 * 3);
  });

  it("ignores a client-supplied totalAmount", async () => {
    const host = await createHost();
    const room = await createRoom(host.id, 500_000);

    const res = await request(app).post("/api/bookings").send({
      roomId: room.id,
      customerName: "Attacker",
      customerEmail: "attacker@example.com",
      checkIn: "2027-04-01",
      checkOut: "2027-04-02",
      totalAmount: 1,
      nights: 99,
      status: "CONFIRMED",
    });

    expect(res.status).toBe(201);
    expect(res.body.booking.totalAmount).toBe(500_000);
    expect(res.body.booking.nights).toBe(1);
    expect(res.body.booking.status).toBe("PENDING_PAYMENT");
  });

  it("rejects a booking for a room that does not exist", async () => {
    const res = await createBooking(app, { roomId: "does-not-exist" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects a booking for an inactive room", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);
    await prisma.room.update({ where: { id: room.id }, data: { isActive: false } });

    const res = await createBooking(app, { roomId: room.id });
    expect(res.status).toBe(422);
  });

  it("rejects a checkout date that is not after check-in", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);

    const res = await createBooking(app, {
      roomId: room.id,
      checkIn: "2027-05-10",
      checkOut: "2027-05-10",
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a booking with a malformed email", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);

    const res = await request(app).post("/api/bookings").send({
      roomId: room.id,
      customerName: "Guest",
      customerEmail: "not-an-email",
      checkIn: "2027-06-01",
      checkOut: "2027-06-02",
    });

    expect(res.status).toBe(400);
  });
});

describe("secure guest tracking token", () => {
  it("returns a high-entropy, non-sequential tracking token", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);

    const a = await createBooking(app, { roomId: room.id, checkIn: "2027-07-01", checkOut: "2027-07-02" });
    const b = await createBooking(app, { roomId: room.id, checkIn: "2027-08-01", checkOut: "2027-08-02" });

    const tokenA = a.body.booking.trackingToken as string;
    const tokenB = b.body.booking.trackingToken as string;

    expect(typeof tokenA).toBe("string");
    // 32 random bytes, base64url-encoded.
    expect(tokenA.length).toBeGreaterThanOrEqual(40);
    expect(tokenA).not.toBe(tokenB);
    // Must not embed the sequential booking id.
    expect(tokenA).not.toContain(a.body.booking.id);
  });

  it("lets a guest read their booking with the token", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);
    const created = await createBooking(app, { roomId: room.id });
    const token = created.body.booking.trackingToken;

    const res = await request(app).get(`/api/bookings/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.booking.id).toBe(created.body.booking.id);
    expect(res.body.booking.trackingToken).toBe(token);
  });

  it("does not leak host private information to the guest", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);
    const created = await createBooking(app, { roomId: room.id });
    const token = created.body.booking.trackingToken;

    const res = await request(app).get(`/api/bookings/${token}`);
    const body = JSON.stringify(res.body);

    expect(body).not.toContain("hostId");
    expect(body).not.toContain("passwordHash");
    expect(body).not.toContain(host.email);
  });

  it("returns 404 (not 403) for an unknown tracking token", async () => {
    const res = await request(app).get(`/api/bookings/${"x".repeat(43)}`);
    expect(res.status).toBe(404);
  });

  it("cannot be read by booking id alone", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);
    const created = await createBooking(app, { roomId: room.id });

    // The booking id is a valid path segment shape but not a tracking token.
    const res = await request(app).get(`/api/bookings/${created.body.booking.id}`);
    expect(res.status).toBe(404);
  });
});
