/**
 * Shared test fixtures and helpers.
 *
 * Tests exercise the real Express app over HTTP (supertest) against a real
 * SQLite database — no mocked service layer — so the assertions cover the
 * actual routing, middleware, service and persistence path.
 */

import type { Express } from "express";
import request from "supertest";
import { prisma } from "../../src/database/prisma";
import { hashPassword } from "../../src/auth/password";
import { MockPaymentGateway } from "../../src/payment/MockPaymentGateway";
import { Role } from "../../src/domain/statuses";

export const gateway = new MockPaymentGateway();

/** Tables in FK-safe deletion order. */
const TABLES = [
  "Notification",
  "LedgerEntry",
  "Refund",
  "PaymentEvent",
  "WebhookEvent",
  "Payment",
  "Booking",
  "Room",
  "User",
] as const;

/** Truncate every table so each test starts from a known empty state. */
export async function resetDb(): Promise<void> {
  for (const table of TABLES) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export async function createHost(email = "host@example.com", password = "hostpass123") {
  return prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), role: Role.HOST, name: "Host" },
  });
}

export async function createAdmin(email = "admin@example.com", password = "adminpass123") {
  return prisma.user.create({
    data: { email, passwordHash: await hashPassword(password), role: Role.ADMIN, name: "Admin" },
  });
}

export async function createRoom(hostId: string, pricePerNight = 100_000, name = "Test Room") {
  return prisma.room.create({
    data: { hostId, name, pricePerNight, capacity: 2 },
  });
}

/** Log in and return the JWT. Throws if login did not succeed. */
export async function login(
  app: Express,
  kind: "host" | "admin",
  email: string,
  password: string,
): Promise<string> {
  const res = await request(app).post(`/api/${kind}/login`).send({ email, password });
  if (res.status !== 200 || typeof res.body?.token !== "string") {
    throw new Error(`login failed for ${kind} ${email}: ${res.status}`);
  }
  return res.body.token;
}

// ---------------------------------------------------------------------------
// Booking / payment helpers
// ---------------------------------------------------------------------------

export interface BookingOverrides {
  roomId: string;
  checkIn?: string;
  checkOut?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
}

/** Create a guest booking through the public API. */
export async function createBooking(app: Express, overrides: BookingOverrides) {
  const res = await request(app)
    .post("/api/bookings")
    .send({
      customerName: "Guest One",
      customerEmail: `guest-${Date.now()}-${Math.random()}@example.com`,
      checkIn: "2027-01-01",
      checkOut: "2027-01-03",
      ...overrides,
    });
  return res;
}

/** Create a payment through the guest API. */
export async function createPayment(
  app: Express,
  bookingId: string,
  trackingToken: string,
  idempotencyKey?: string,
) {
  return request(app)
    .post("/api/payments/create")
    .send({ bookingId, trackingToken, ...(idempotencyKey ? { idempotencyKey } : {}) });
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface WebhookOverrides {
  eventId: string;
  providerRef: string;
  paymentId: string;
  status: "PAID" | "FAILED" | "EXPIRED";
  amount: number;
}

/** Build a correctly signed mock webhook. */
export function signedWebhook(o: WebhookOverrides) {
  return gateway.buildSignedWebhook(o);
}

/** Deliver a signed webhook to the real endpoint. */
export async function postWebhook(
  app: Express,
  signed: { rawBody: string; headers: Record<string, string> },
  provider = "mock",
) {
  return request(app)
    .post(`/api/payments/webhook?provider=${provider}`)
    .set("Content-Type", "application/json")
    .set("x-mock-signature", signed.headers["x-mock-signature"]!)
    .send(signed.rawBody);
}

/** Convenience: sign and deliver in one step. */
export async function sendWebhook(
  app: Express,
  payment: { id: string; providerRef: string | null; amount: number },
  status: "PAID" | "FAILED" | "EXPIRED",
  eventId: string,
  amountOverride?: number,
) {
  const signed = signedWebhook({
    eventId,
    providerRef: payment.providerRef!,
    paymentId: payment.id,
    status,
    amount: amountOverride ?? payment.amount,
  });
  return postWebhook(app, signed);
}

/** Fetch a payment row directly, for state assertions. */
export function getPayment(id: string) {
  return prisma.payment.findUnique({ where: { id } });
}

/** Fetch a booking row directly, for state assertions. */
export function getBooking(id: string) {
  return prisma.booking.findUnique({ where: { id } });
}

/** Ledger entries for a payment, grouped by type. */
export async function ledgerByType(paymentId: string): Promise<Record<string, number>> {
  const entries = await prisma.ledgerEntry.findMany({ where: { paymentId } });
  const out: Record<string, number> = {};
  for (const e of entries) out[e.type] = (out[e.type] ?? 0) + e.amount;
  return out;
}

/** Count ledger rows of a given type for a payment. */
export function ledgerCount(paymentId: string, type?: string) {
  return prisma.ledgerEntry.count({ where: { paymentId, ...(type ? { type } : {}) } });
}
