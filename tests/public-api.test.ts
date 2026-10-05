/**
 * Public API surface and cross-cutting security behaviour.
 *
 * Covers unauthenticated room browsing, consistent error shapes, security
 * headers, CORS, and the body size limit.
 */

import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/api/app";
import { createHost, createRoom, resetDb } from "./helpers/fixtures";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

describe("public room browsing", () => {
  it("lists rooms without authentication", async () => {
    const host = await createHost();
    await createRoom(host.id, 100_000, "Visible Room");

    const res = await request(app).get("/api/rooms");

    expect(res.status).toBe(200);
    expect(res.body.rooms).toHaveLength(1);
    expect(res.body.rooms[0].name).toBe("Visible Room");
  });

  it("does not expose hostId in the public room projection", async () => {
    const host = await createHost();
    await createRoom(host.id);

    const res = await request(app).get("/api/rooms");
    expect(JSON.stringify(res.body)).not.toContain("hostId");
  });

  it("returns room detail without authentication", async () => {
    const host = await createHost();
    const room = await createRoom(host.id, 250_000, "Detail Room");

    const res = await request(app).get(`/api/rooms/${room.id}`);

    expect(res.status).toBe(200);
    expect(res.body.room.pricePerNight).toBe(250_000);
  });

  it("hides inactive rooms from the public listing", async () => {
    const host = await createHost();
    const room = await createRoom(host.id, 100_000, "Hidden Room");
    await request(app)
      .delete(`/api/host/rooms/${room.id}`)
      .set("Authorization", `Bearer ${await loginHost()}`);

    const res = await request(app).get("/api/rooms");
    expect(res.body.rooms).toHaveLength(0);
  });

  it("returns 404 for an unknown room", async () => {
    const res = await request(app).get("/api/rooms/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

async function loginHost() {
  const res = await request(app)
    .post("/api/host/login")
    .send({ email: "host@example.com", password: "hostpass123" });
  return res.body.token;
}

describe("health endpoint", () => {
  it("responds without authentication", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("consistent error responses", () => {
  it("uses one error shape for every failure class", async () => {
    const cases: Array<[string, number]> = [
      ["/api/does-not-exist", 404],
      ["/api/rooms/does-not-exist", 404],
    ];

    for (const [path, expected] of cases) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(expected);
      expect(res.body.error, path).toBeTruthy();
      expect(typeof res.body.error.code, path).toBe("string");
      expect(typeof res.body.error.message, path).toBe("string");
    }
  });

  it("returns a validation error shape for a malformed body", async () => {
    const res = await request(app).post("/api/bookings").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it("does not leak internal details on an unhandled error", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(JSON.stringify(res.body)).not.toContain("at ");
    expect(JSON.stringify(res.body)).not.toContain("/Users/");
  });
});

describe("security headers", () => {
  it("sets helmet headers and hides x-powered-by", async () => {
    const res = await request(app).get("/health");

    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeTruthy();
  });
});

describe("CORS", () => {
  it("allows a configured origin", async () => {
    const res = await request(app).get("/health").set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("does not allow an unconfigured origin", async () => {
    const res = await request(app).get("/health").set("Origin", "http://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("request body size limit", () => {
  it("rejects an oversized JSON body", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);

    const res = await request(app)
      .post("/api/bookings")
      .set("Content-Type", "application/json")
      .send(
        JSON.stringify({
          roomId: room.id,
          customerName: "x".repeat(200_000),
          customerEmail: "big@example.com",
          checkIn: "2027-01-01",
          checkOut: "2027-01-02",
        }),
      );

    expect([400, 413]).toContain(res.status);
  });
});
