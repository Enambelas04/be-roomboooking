/**
 * Rate limiting.
 *
 * ISOLATION: this suite is collected by its OWN vitest project
 * (`vitest.rate-limit.config.ts`), which supplies RATE_LIMIT_* through the
 * project `env` block. That is required because the limiter MAX values are read
 * when `src/config` is first evaluated and the limiters are constructed on
 * first import of the route modules — they cannot be changed from inside a
 * test. Running in a dedicated project (and process) means those values can
 * never leak into another suite, which is what previously caused unrelated
 * suites to fail.
 *
 * `npm test` runs both projects in sequence.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import type supertest from "supertest";
import { resetDb, suiteEmail } from "./helpers/isolation";

const AUTH_MAX = 3;
const BOOKING_MAX = 3;

let request: typeof supertest;
let app: Express;

beforeAll(async () => {
  // The limits arrive from the project env block, so a plain import is safe
  // here — no environment mutation and therefore nothing to restore.
  expect(process.env.RATE_LIMIT_AUTH_MAX).toBe(String(AUTH_MAX));

  request = (await import("supertest")).default;
  const { createApp } = await import("../src/api/app");
  app = createApp();

  // This suite touches the database (booking attempts), so it resets on entry
  // like every other suite.
  await resetDb();
});

describe("rate limiting", () => {
  it("blocks auth attempts beyond the configured limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/host/login")
        .send({ email: suiteEmail("ratelimit"), password: "x" });
      statuses.push(res.status);
    }

    // The first AUTH_MAX requests reach the handler (401 for an unknown
    // account); the rest are refused by the limiter.
    expect(statuses.slice(0, AUTH_MAX), `first ${AUTH_MAX} requests`).toEqual(
      Array.from({ length: AUTH_MAX }, () => 401),
    );
    expect(statuses.slice(AUTH_MAX), "remaining requests are limited").toEqual(
      Array.from({ length: 5 - AUTH_MAX }, () => 429),
    );
  });

  it("returns the standard error shape when limited", async () => {
    // The auth bucket was exhausted by the previous test.
    const res = await request(app)
      .post("/api/host/login")
      .send({ email: suiteEmail("ratelimit"), password: "x" });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(typeof res.body.error.message).toBe("string");
  });

  it("blocks booking creation beyond the configured limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/bookings")
        .send({
          roomId: "does-not-exist",
          customerName: "Spam",
          customerEmail: suiteEmail("spam"),
          checkIn: "2027-01-01",
          checkOut: "2027-01-02",
        });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, BOOKING_MAX).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(BOOKING_MAX).every((s) => s === 429)).toBe(true);
  });

  it("does not rate limit the health endpoint", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
    }
  });
});
