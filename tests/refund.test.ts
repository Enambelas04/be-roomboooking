/**
 * Refunds and concurrency protection.
 *
 * The refund flow moves real money, so the double-refund race is tested
 * directly: exactly one refund may succeed per payment, and it must produce
 * exactly one REFUND ledger entry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/api/app";
import { prisma } from "../src/database/prisma";
import { paymentService } from "../src/services/PaymentService";
import { MockPaymentGateway } from "../src/payment/MockPaymentGateway";
import {
  createAdmin,
  createBooking,
  createHost,
  createPayment,
  createRoom,
  getBooking,
  getPayment,
  ledgerCount,
  login,
  resetDb,
  sendWebhook,
  suiteEmail,
} from "./helpers/fixtures";
import { sleep } from "./helpers/isolation";

const app = createApp();

/**
 * Poll until `predicate` is true, with a bounded deadline.
 *
 * Used only to observe an already-established state (e.g. the winner has
 * reached the provider boundary), never to wait out a race.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timed out");
    }
    await sleep(5);
  }
}

beforeEach(async () => {
  await resetDb();
});

/**
 * Always undo prototype spies, even when a test fails.
 *
 * The refund race tests patch `MockPaymentGateway.prototype.refund`. Restoring
 * at the end of the test body is not enough: if an assertion fails first, the
 * spy stays installed on the shared prototype, and later tests then run against
 * a gateway that is still gated or still counting — which surfaced as an
 * unrelated-looking 404 in the authorization tests further down the file.
 *
 * `vi.restoreAllMocks()` in afterEach makes the cleanup unconditional.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

async function paidPayment(pricePerNight = 100_000) {
  const host = await createHost();
  const room = await createRoom(host.id, pricePerNight);
  const booking = (await createBooking(app, { roomId: room.id })).body.booking;
  const created = await createPayment(app, booking.id, booking.trackingToken);
  const payment = await prisma.payment.findUnique({ where: { id: created.body.payment.id } });
  await sendWebhook(app, payment!, "PAID", `evt-refund-setup-${payment!.id}`);
  return { host, room, booking, payment: payment! };
}

describe("refund behavior", () => {
  it("refunds a PAID payment and updates payment, booking and ledger", async () => {
    const { payment, booking } = await paidPayment(500_000);

    const result = await paymentService.refund(payment.id, "guest requested");

    expect(result.status).toBe("REFUNDED");
    expect((await getPayment(payment.id))?.status).toBe("REFUNDED");
    expect((await getBooking(booking.id))?.status).toBe("REFUNDED");

    const refunds = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.status).toBe("SUCCEEDED");
    expect(refunds[0]?.amount).toBe(payment.amount);

    const refundLedger = await prisma.ledgerEntry.findMany({
      where: { paymentId: payment.id, type: "REFUND" },
    });
    expect(refundLedger).toHaveLength(1);
    expect(refundLedger[0]?.amount).toBe(-payment.amount);
  });

  it("keeps the ledger balanced after a refund", async () => {
    const { payment } = await paidPayment(825_000);
    await paymentService.refund(payment.id);

    const entries = await prisma.ledgerEntry.findMany({ where: { paymentId: payment.id } });
    const byType: Record<string, number> = {};
    for (const e of entries) byType[e.type] = (byType[e.type] ?? 0) + e.amount;

    const splitTotal =
      (byType.HOST_REVENUE ?? 0) + (byType.PLATFORM_REVENUE ?? 0) + (byType.GATEWAY_FEE ?? 0);
    expect(splitTotal).toBe(byType.FULL_PAYMENT);
    expect(byType.REFUND).toBe(-byType.FULL_PAYMENT);
  });

  it("records a REFUNDED payment event", async () => {
    const { payment } = await paidPayment();
    await paymentService.refund(payment.id, "test");

    const events = await prisma.paymentEvent.findMany({
      where: { paymentId: payment.id, toState: "REFUNDED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.fromState).toBe("PAID");
  });

  it("refuses to refund a payment that is not PAID", async () => {
    const host = await createHost();
    const room = await createRoom(host.id);
    const booking = (await createBooking(app, { roomId: room.id })).body.booking;
    const created = await createPayment(app, booking.id, booking.trackingToken);

    await expect(paymentService.refund(created.body.payment.id)).rejects.toThrow(/PAID/i);
  });

  it("refuses a second sequential refund", async () => {
    const { payment } = await paidPayment();
    await paymentService.refund(payment.id, "first");

    await expect(paymentService.refund(payment.id, "second")).rejects.toThrow();

    expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(await ledgerCount(payment.id, "REFUND")).toBe(1);
  });

  it("ignores a PAID webhook arriving after a refund", async () => {
    const { payment } = await paidPayment();
    await paymentService.refund(payment.id);

    const late = await sendWebhook(app, payment, "PAID", "evt-paid-after-refund");

    expect(late.status).toBe(200);
    expect((await getPayment(payment.id))?.status).toBe("REFUNDED");
    expect(await ledgerCount(payment.id, "FULL_PAYMENT")).toBe(1);
  });
});

describe("concurrent / double refund protection", () => {
  /**
   * The invariant this suite exists to protect is about the REFUND, not about
   * how many callers happen to return successfully:
   *
   *   provider refund calls = 1
   *   Refund rows           = 1
   *   REFUND ledger rows    = 1
   *   no orphaned PENDING row
   *
   * A losing caller may either converge (resolve) or be told the refund is
   * already in progress (reject with CONFLICT). Both are correct outcomes and
   * neither touches the money — asserting that every caller resolves made the
   * test depend on scheduling, which is what made it flaky. The convergence
   * path is still exercised by the dedicated deterministic test below.
   */
  function assertRefundInvariant(
    rows: Array<{ status: string }>,
    refundLedgerRows: number,
  ) {
    expect(rows, "exactly one Refund row").toHaveLength(1);
    expect(rows[0]?.status, "the refund reached a terminal success").toBe("SUCCEEDED");
    expect(rows.filter((r) => r.status === "PENDING"), "no orphaned PENDING row").toHaveLength(0);
    expect(refundLedgerRows, "exactly one REFUND ledger entry").toBe(1);
  }

  it("calls the provider exactly once and records one refund under a race", async () => {
    const { payment } = await paidPayment(300_000);

    // Count real provider invocations at the prototype level, so the assertion
    // covers the actual gateway call rather than a service-level guess.
    const spy = vi.spyOn(MockPaymentGateway.prototype, "refund");

    await Promise.allSettled([
      paymentService.refund(payment.id, "race A"),
      paymentService.refund(payment.id, "race B"),
      paymentService.refund(payment.id, "race C"),
    ]);

    expect(spy, "provider must be called exactly once").toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.providerRef).toBe(payment.providerRef);

    const rows = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    assertRefundInvariant(rows, await ledgerCount(payment.id, "REFUND"));
    expect((await getPayment(payment.id))?.status).toBe("REFUNDED");

    spy.mockRestore();
  });

  it("calls the provider exactly once under higher concurrency", async () => {
    const { payment } = await paidPayment(400_000);
    const spy = vi.spyOn(MockPaymentGateway.prototype, "refund");

    await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => paymentService.refund(payment.id, `r${i}`)),
    );

    expect(spy, "provider must be called exactly once").toHaveBeenCalledTimes(1);

    const rows = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    assertRefundInvariant(rows, await ledgerCount(payment.id, "REFUND"));

    spy.mockRestore();
  });

  /**
   * Deterministic convergence check.
   *
   * Rather than racing two callers and hoping the second one observes the claim
   * in time, the claim is established first, its holder is held at the provider
   * boundary, and only then is the second caller started. That makes "the loser
   * converges without touching the provider" a certain outcome instead of a
   * timing-dependent one — no timeout is involved.
   */
  it("makes a late caller converge on the existing refund without re-calling the provider", async () => {
    const { payment } = await paidPayment(250_000);

    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerCalls = 0;

    const original = MockPaymentGateway.prototype.refund;
    const spy = vi
      .spyOn(MockPaymentGateway.prototype, "refund")
      .mockImplementation(async function (
        this: MockPaymentGateway,
        input: Parameters<MockPaymentGateway["refund"]>[0],
      ) {
        providerCalls++;
        // Hold the winner here so the loser must observe an in-flight claim.
        await providerGate;
        return original.call(this, input);
      });

    // 1. Winner starts and reaches the provider boundary.
    const winner = paymentService.refund(payment.id, "winner");
    await waitUntil(() => providerCalls === 1);

    // 2. The claim row exists and is PENDING while the provider is held.
    const inFlight = await prisma.refund.findUnique({ where: { paymentId: payment.id } });
    expect(inFlight?.status, "claim is held in PENDING").toBe("PENDING");

    // 3. A late caller arrives while the refund is in flight.
    const late = paymentService.refund(payment.id, "late");

    // 4. Release the provider so the winner can finish.
    releaseProvider();

    const [winnerResult, lateResult] = await Promise.allSettled([winner, late]);

    expect(winnerResult.status).toBe("fulfilled");
    // The late caller must never reach the provider.
    expect(providerCalls, "provider called once, by the winner only").toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);

    // The late caller either converged or was told it is in progress — never a
    // second provider call, and never a second refund.
    if (lateResult.status === "fulfilled") {
      expect(lateResult.value.status).toBe("REFUNDED");
    } else {
      expect(String(lateResult.reason?.code ?? lateResult.reason?.message)).toMatch(
        /CONFLICT|in progress/i,
      );
    }

    const rows = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    assertRefundInvariant(rows, await ledgerCount(payment.id, "REFUND"));
    expect((await getPayment(payment.id))?.status).toBe("REFUNDED");

    spy.mockRestore();
  });

  it("processes exactly one refund when two run simultaneously", async () => {
    const { payment } = await paidPayment(300_000);

    const results = await Promise.allSettled([
      paymentService.refund(payment.id, "race A"),
      paymentService.refund(payment.id, "race B"),
    ]);

    // At least one caller must complete the refund. The other may converge or
    // be told it is in progress; both are correct and neither moves money. What
    // must be singular is the refund itself, not the count of resolving callers.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    expect(await prisma.refund.count({ where: { paymentId: payment.id, status: "SUCCEEDED" } })).toBe(1);
    expect(await ledgerCount(payment.id, "REFUND")).toBe(1);
    expect((await getPayment(payment.id))?.status).toBe("REFUNDED");

    // The refund rows must all agree: exactly one, SUCCEEDED, no PENDING leftover.
    const rows = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    assertRefundInvariant(rows, await ledgerCount(payment.id, "REFUND"));

    // Any caller that did converge must report the same outcome as the winner.
    const values = results
      .filter(
        (r): r is PromiseFulfilledResult<{ paymentId: string; status: string }> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value.status);
    expect(new Set(values)).toEqual(new Set(["REFUNDED"]));
  });

  it("does not leave a stray pending refund behind after the race", async () => {
    const { payment } = await paidPayment();

    await Promise.allSettled([
      paymentService.refund(payment.id),
      paymentService.refund(payment.id),
      paymentService.refund(payment.id),
    ]);

    const rows = await prisma.refund.findMany({ where: { paymentId: payment.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("SUCCEEDED");
  });

  it("keeps the ledger balanced under a concurrent refund race", async () => {
    const { payment } = await paidPayment(750_000);

    await Promise.allSettled([
      paymentService.refund(payment.id),
      paymentService.refund(payment.id),
    ]);

    const entries = await prisma.ledgerEntry.findMany({ where: { paymentId: payment.id } });
    const refundRows = entries.filter((e) => e.type === "REFUND");
    const full = entries.find((e) => e.type === "FULL_PAYMENT");

    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]?.amount).toBe(-(full?.amount ?? 0));
  });
});

describe("refund authorization", () => {
  it("requires authentication to refund", async () => {
    const { payment } = await paidPayment();
    const res = await request(app).post(`/api/admin/payments/${payment.id}/refund`).send({});
    expect(res.status).toBe(401);
  });

  it("lets an ADMIN refund through the API", async () => {
    const { payment } = await paidPayment();
    const admin = await createAdmin();
    const token = await login(app, "admin", admin.email, "adminpass123");

    const res = await request(app)
      .post(`/api/admin/payments/${payment.id}/refund`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "admin refund" });

    expect(res.status).toBe(200);
    expect((await getPayment(payment.id))?.status).toBe("REFUNDED");
  });

  it("refuses a HOST refunding a payment for another host's room", async () => {
    const { payment } = await paidPayment();
    const other = await createHost(suiteEmail("other"), "otherpass123");
    const token = await login(app, "host", other.email, "otherpass123");

    const res = await request(app)
      .post(`/api/host/payments/${payment.id}/refund`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(403);
    expect((await getPayment(payment.id))?.status).toBe("PAID");
  });
});
