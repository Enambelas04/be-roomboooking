/**
 * Rate limiting.
 *
 * The limiters are built when their module is first imported, so the low limits
 * must be set before the app is imported. Imports are dynamic for that reason.
 * With fileParallelism off, this file runs in its own process, so these limits
 * do not affect the other suites.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import type supertest from "supertest";

process.env.RATE_LIMIT_AUTH_MAX = "3";
process.env.RATE_LIMIT_BOOKING_MAX = "3";
process.env.RATE_LIMIT_WINDOW_MS = "60000";

describe("rate limiting", () => {
  let request: typeof supertest;
  let app: Express;

  beforeAll(async () => {
    request = (await import("supertest")).default;
    const { createApp } = await import("../src/api/app");
    app = createApp();
  });

  it("blocks auth attempts beyond the configured limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/host/login")
        .send({ email: "nobody@example.com", password: "x" });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it("returns the standard error shape when limited", async () => {
    const res = await request(app)
      .post("/api/host/login")
      .send({ email: "nobody@example.com", password: "x" });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });

  it("blocks booking creation beyond the configured limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/bookings")
        .send({
          roomId: "does-not-exist",
          customerName: "Spam",
          customerEmail: "spam@example.com",
          checkIn: "2027-01-01",
          checkOut: "2027-01-02",
        });
      statuses.push(res.status);
    }

    // The first requests reach the handler (404 for an unknown room); the rest
    // are refused by the limiter.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(2);
  });
});
