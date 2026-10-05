/**
 * Booking concurrency: overlapping bookings for the same room must not both be
 * accepted, even when the requests arrive simultaneously.
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

const payload = (roomId: string, checkIn: string, checkOut: string, email: string) => ({
  roomId,
  customerName: "Race Guest",
  customerEmail: email,
  checkIn,
  checkOut,
});

describe("overbooking protection", () => {
  it("rejects a sequential overlapping booking", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);

    const first = await createBooking(app, {
      roomId: room.id,
      checkIn: "2027-01-10",
      checkOut: "2027-01-15",
    });
    const second = await createBooking(app, {
      roomId: room.id,
      checkIn: "2027-01-12",
      checkOut: "2027-01-18",
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");
  });

  it("rejects a partially overlapping booking from the other side", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);

    await createBooking(app, { roomId: room.id, checkIn: "2027-02-10", checkOut: "2027-02-15" });
    const second = await createBooking(app, {
      roomId: room.id,
      checkIn: "2027-02-05",
      checkOut: "2027-02-11",
    });

    expect(second.status).toBe(409);
  });

  it("allows back-to-back bookings that only touch at the boundary", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);

    const first = await createBooking(app, {
      roomId: room.id,
      checkIn: "2027-03-01",
      checkOut: "2027-03-05",
    });
    // Check-in on the previous check-out day is not an overlap ([in, out) ranges).
    const second = await createBooking(app, {
      roomId: room.id,
      checkIn: "2027-03-05",
      checkOut: "2027-03-08",
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it("allows a booking for a different room on the same dates", async () => {
    const host = await createHost();
    const roomA = await createRoom(host.id, 100_000, "Room A");
    const roomB = await createRoom(host.id, 100_000, "Room B");

    const a = await createBooking(app, { roomId: roomA.id, checkIn: "2027-04-01", checkOut: "2027-04-05" });
    const b = await createBooking(app, { roomId: roomB.id, checkIn: "2027-04-01", checkOut: "2027-04-05" });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("accepts only one of three simultaneous overlapping bookings", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);

    const body = (n: number) => payload(room.id, "2027-05-01", "2027-05-05", `race${n}@example.com`);

    const results = await Promise.allSettled([
      request(app).post("/api/bookings").send(body(1)),
      request(app).post("/api/bookings").send(body(2)),
      request(app).post("/api/bookings").send(body(3)),
    ]);

    const created = results.filter(
      (r) => r.status === "fulfilled" && (r.value as { status: number }).status === 201,
    ).length;

    expect(created).toBe(1);

    const stored = await prisma.booking.count({
      where: {
        roomId: room.id,
        status: { in: ["PENDING_PAYMENT", "PAID", "CONFIRMED"] },
      },
    });
    expect(stored).toBe(1);
  });

  it("does not let a failed booking block the dates", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);

    const first = await createBooking(app, {
      roomId: room.id,
      checkIn: "2027-06-01",
      checkOut: "2027-06-05",
    });
    // A failed/expired booking no longer occupies the room.
    await prisma.booking.update({ where: { id: first.body.booking.id }, data: { status: "EXPIRED" } });

    const second = await createBooking(app, {
      roomId: room.id,
      checkIn: "2027-06-01",
      checkOut: "2027-06-05",
    });

    expect(second.status).toBe(201);
  });
});
