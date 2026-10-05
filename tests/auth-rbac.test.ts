/**
 * Authentication and role-based access control.
 *
 * Only HOST and ADMIN authenticate. Guests are unauthenticated and must never
 * reach a protected route. Actor identity is always derived from the verified
 * JWT, never from the request body.
 */

import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/api/app";
import { prisma } from "../src/database/prisma";
import {
  createAdmin,
  createBooking,
  createHost,
  createRoom,
  login,
  resetDb,
} from "./helpers/fixtures";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

describe("JWT authentication", () => {
  it("issues a token for valid HOST credentials", async () => {
    await createHost();

    const res = await request(app)
      .post("/api/host/login")
      .send({ email: "host@example.com", password: "hostpass123" });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user.role).toBe("HOST");
  });

  it("issues a token for valid ADMIN credentials", async () => {
    await createAdmin();

    const res = await request(app)
      .post("/api/admin/login")
      .send({ email: "admin@example.com", password: "adminpass123" });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("ADMIN");
  });

  it("rejects a wrong password", async () => {
    await createHost();
    const res = await request(app)
      .post("/api/host/login")
      .send({ email: "host@example.com", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns the same error for an unknown account and a wrong password", async () => {
    await createHost();

    const unknown = await request(app)
      .post("/api/host/login")
      .send({ email: "ghost@example.com", password: "whatever" });
    const wrong = await request(app)
      .post("/api/host/login")
      .send({ email: "host@example.com", password: "wrong" });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it("rejects an inactive account", async () => {
    const host = await createHost();
    await prisma.user.update({ where: { id: host.id }, data: { isActive: false } });

    const res = await request(app)
      .post("/api/host/login")
      .send({ email: "host@example.com", password: "hostpass123" });

    expect(res.status).toBe(401);
  });

  it("refuses HOST credentials at the ADMIN login", async () => {
    await createHost();
    const res = await request(app)
      .post("/api/admin/login")
      .send({ email: "host@example.com", password: "hostpass123" });
    expect(res.status).toBe(401);
  });

  it("refuses ADMIN credentials at the HOST login", async () => {
    await createAdmin();
    const res = await request(app)
      .post("/api/host/login")
      .send({ email: "admin@example.com", password: "adminpass123" });
    expect(res.status).toBe(401);
  });

  it("never returns a password hash", async () => {
    await createHost();
    const res = await request(app)
      .post("/api/host/login")
      .send({ email: "host@example.com", password: "hostpass123" });
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    expect(JSON.stringify(res.body)).not.toContain("$2");
  });

  it("normalizes the login email so case does not matter", async () => {
    await createHost(); // stored as host@example.com

    const res = await request(app)
      .post("/api/host/login")
      .send({ email: "HOST@Example.COM", password: "hostpass123" });

    expect(res.status).toBe(200);
  });

  it("stores a normalized email when an admin creates a user", async () => {
    await createAdmin();
    const token = await login(app, "admin", "admin@example.com", "adminpass123");

    const created = await request(app)
      .post("/api/admin/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "NewHost@Example.COM", password: "newhostpass1", role: "HOST" });

    expect(created.status).toBe(201);
    expect(created.body.user.email).toBe("newhost@example.com");

    const loginRes = await request(app)
      .post("/api/host/login")
      .send({ email: "NewHost@Example.COM", password: "newhostpass1" });
    expect(loginRes.status).toBe(200);
  });

  it("rejects a malformed bearer token", async () => {
    const res = await request(app).get("/api/me").set("Authorization", "Bearer not.a.jwt");
    expect(res.status).toBe(401);
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).get("/api/me");
    expect(res.status).toBe(401);
  });
});

describe("HOST RBAC", () => {
  it("lets a HOST read their own rooms", async () => {
    const host = await createHost();
    await createRoom(host.id);
    const token = await login(app, "host", host.email, "hostpass123");

    const res = await request(app).get("/api/host/rooms").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.rooms).toHaveLength(1);
  });

  it("blocks a HOST from ADMIN routes", async () => {
    const host = await createHost();
    const token = await login(app, "host", host.email, "hostpass123");

    for (const path of ["/api/admin/users", "/api/admin/payments", "/api/admin/ledger", "/api/admin/bookings"]) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status, path).toBe(403);
    }
  });

  it("blocks an ADMIN from HOST routes", async () => {
    await createAdmin();
    const token = await login(app, "admin", "admin@example.com", "adminpass123");

    const res = await request(app).get("/api/host/rooms").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("blocks a guest from HOST and ADMIN routes", async () => {
    for (const path of [
      "/api/host/rooms",
      "/api/host/bookings",
      "/api/host/revenue",
      "/api/admin/payments",
      "/api/admin/ledger",
      "/api/admin/users",
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
  });
});

describe("HOST ownership enforcement", () => {
  it("does not let a HOST modify another host's room", async () => {
    const hostA = await createHost("hosta@example.com", "hostapass123");
    const hostB = await createHost("hostb@example.com", "hostbpass123");
    const roomB = await createRoom(hostB.id, 100_000, "Room B");
    const tokenA = await login(app, "host", hostA.email, "hostapass123");

    const patch = await request(app)
      .patch(`/api/host/rooms/${roomB.id}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "Hijacked" });

    expect(patch.status).toBe(403);
    const after = await prisma.room.findUnique({ where: { id: roomB.id } });
    expect(after?.name).toBe("Room B");
  });

  it("does not let a HOST deactivate another host's room", async () => {
    const hostA = await createHost("hosta2@example.com", "hostapass123");
    const hostB = await createHost("hostb2@example.com", "hostbpass123");
    const roomB = await createRoom(hostB.id);
    const tokenA = await login(app, "host", hostA.email, "hostapass123");

    const del = await request(app)
      .delete(`/api/host/rooms/${roomB.id}`)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(del.status).toBe(403);
    const after = await prisma.room.findUnique({ where: { id: roomB.id } });
    expect(after?.isActive).toBe(true);
  });

  it("only lists a host's own bookings", async () => {
    const hostA = await createHost("hosta3@example.com", "hostapass123");
    const hostB = await createHost("hostb3@example.com", "hostbpass123");
    const roomA = await createRoom(hostA.id, 100_000, "A Room");
    const roomB = await createRoom(hostB.id, 100_000, "B Room");
    await createBooking(app, { roomId: roomA.id });
    await createBooking(app, { roomId: roomB.id });

    const tokenA = await login(app, "host", hostA.email, "hostapass123");
    const res = await request(app).get("/api/host/bookings").set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
  });

  it("only reports revenue for the host's own rooms", async () => {
    const hostA = await createHost("hosta4@example.com", "hostapass123");
    const tokenA = await login(app, "host", hostA.email, "hostapass123");

    const res = await request(app).get("/api/host/revenue").set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});

describe("ADMIN RBAC", () => {
  it("lets an ADMIN read all administrative resources", async () => {
    await createAdmin();
    const token = await login(app, "admin", "admin@example.com", "adminpass123");

    for (const path of [
      "/api/admin/users",
      "/api/admin/bookings",
      "/api/admin/rooms",
      "/api/admin/payments",
      "/api/admin/ledger",
      "/api/admin/revenue",
    ]) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status, path).toBe(200);
    }
  });

  it("does not expose password hashes in the admin user list", async () => {
    await createAdmin();
    await createHost();
    const token = await login(app, "admin", "admin@example.com", "adminpass123");

    const res = await request(app).get("/api/admin/users").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });
});

describe("actor identity comes from the JWT", () => {
  it("ignores a client-supplied hostId and uses the token subject", async () => {
    const hostA = await createHost("ownera@example.com", "ownerapass123");
    const hostB = await createHost("ownerb@example.com", "ownerbpass123");
    const tokenA = await login(app, "host", hostA.email, "ownerapass123");

    const res = await request(app)
      .post("/api/host/rooms")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        name: "Injected Owner Room",
        pricePerNight: 50_000,
        hostId: hostB.id,
        actorId: hostB.id,
        role: "ADMIN",
      });

    expect(res.status).toBe(201);

    const created = await prisma.room.findFirst({ where: { name: "Injected Owner Room" } });
    expect(created?.hostId).toBe(hostA.id);
    expect(created?.hostId).not.toBe(hostB.id);
  });
});
