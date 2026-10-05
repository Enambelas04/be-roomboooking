/**
 * PaymentService (PRD §4, §5, §6, §22, §23).
 *
 * The ONLY place allowed to change payment or booking payment-related state.
 * Controllers never touch payment state directly.
 *
 * Responsibilities enforced here:
 *  - payment state transitions (via the domain state machine)
 *  - booking state transitions
 *  - idempotency (client retries of payment creation)
 *  - payment creation deduplication
 *  - webhook deduplication (WebhookEvent unique(provider, eventId))
 *  - atomic database writes (single prisma.$transaction)
 *  - ledger consistency (exact invariant)
 *  - refund consistency
 *
 * SECURITY: PAID is reachable ONLY from a signature-verified webhook. There is
 * no code path that accepts a client-declared status.
 *
 * ---------------------------------------------------------------------------
 * Audit fixes applied in this file:
 *
 *  F3  concurrent refund / idempotency — the refund is claimed by inserting a
 *      PENDING Refund row (unique per payment) BEFORE the provider is called,
 *      and the payment transition PAID -> REFUNDED is claimed with a
 *      conditional update inside the transaction. Two concurrent refunds can
 *      therefore not double-refund or double-post ledger entries.
 *
 *  F4  payment retry — a booking in PAYMENT_FAILED returns to PENDING_PAYMENT
 *      when a new payment is created, so a retried payment can reach PAID.
 *      Previously PAYMENT_FAILED -> PAID was rejected by the state machine and
 *      the retry could never confirm.
 *
 *  F6  terminal payment transitions — a webhook requesting a different
 *      terminal state than the one already reached is acknowledged as an
 *      idempotent no-op. It used to throw, which surfaced as a 500 and made the
 *      provider retry forever.
 *
 *  F7  booking state-machine assertion — the guard now validates the path the
 *      code actually writes (current -> PAID -> CONFIRMED) instead of asserting
 *      a target that was never written.
 *
 *  F9  guest payment creation — the caller must present the booking's tracking
 *      token as proof of ownership, not just its id.
 */

import { prisma } from "../database/prisma";
import { conflict, notFound, paymentError } from "../domain/errors";
import { splitFees, formatIdr } from "../domain/money";
import {
  BookingStatus,
  LedgerType,
  PaymentStatus,
  RefundStatus,
  assertBookingTransition,
  assertPaymentTransition,
} from "../domain/statuses";
import { logger } from "../lib/logger";
import { getGateway } from "../payment/registry";
import type { NormalizedWebhookEvent } from "../payment/PaymentGateway";

export interface CreatePaymentInput {
  bookingId: string;
  /** Proof of ownership of the booking (PRD §10, audit fix F9). */
  trackingToken: string;
  /** Client-supplied key used to dedupe retries. */
  idempotencyKey: string;
}

export interface WebhookResult {
  duplicate: boolean;
  status: string;
  paymentId?: string;
}

/** Payment states from which no further state change is accepted. */
const TERMINAL_PAYMENT_STATES: readonly string[] = [
  PaymentStatus.PAID,
  PaymentStatus.REFUNDED,
  PaymentStatus.CANCELLED,
  PaymentStatus.EXPIRED,
  PaymentStatus.FAILED,
];

export class PaymentService {
  /**
   * Create a payment for a booking.
   *
   * The caller must present the booking's tracking token: a bare booking id is
   * not proof of ownership (audit fix F9).
   *
   * Deduplication: the same idempotencyKey returns the existing payment
   * instead of creating a second one. A booking that is already PAID or
   * CONFIRMED cannot start another payment.
   *
   * Retry (audit fix F4): a booking in PAYMENT_FAILED is moved back to
   * PENDING_PAYMENT so the retry payment can later reach PAID. EXPIRED is
   * terminal — the guest must create a new booking.
   */
  async createPayment(input: CreatePaymentInput) {
    const booking = await prisma.booking.findUnique({
      where: { id: input.bookingId },
      include: { room: true },
    });
    if (!booking) throw notFound("Booking not found");

    // Ownership proof. The same error as "not found" so a wrong token cannot be
    // used to discover which booking ids exist.
    if (booking.trackingToken !== input.trackingToken) {
      throw notFound("Booking not found");
    }

    if (
      booking.status === BookingStatus.CONFIRMED ||
      booking.status === BookingStatus.PAID ||
      booking.status === BookingStatus.REFUNDED
    ) {
      throw conflict(`Booking is already ${booking.status}`);
    }
    if (booking.status === BookingStatus.EXPIRED) {
      throw conflict("Booking has expired");
    }
    if (booking.status === BookingStatus.CANCELLED) {
      throw conflict("Booking has been cancelled");
    }

    // Idempotent replay: return the payment already created for this key.
    const existing = await prisma.payment.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (existing.bookingId !== booking.id) {
        throw conflict("Idempotency key already used for a different booking");
      }
      return { payment: existing, checkoutUrl: null as string | null, reused: true };
    }

    // Retry path (F4): a previously failed booking becomes payable again.
    if (booking.status === BookingStatus.PAYMENT_FAILED) {
      assertBookingTransition(BookingStatus.PAYMENT_FAILED, BookingStatus.PENDING_PAYMENT);
      await prisma.booking.update({
        where: { id: booking.id },
        data: { status: BookingStatus.PENDING_PAYMENT },
      });
    }

    const gateway = getGateway();

    // Amount is taken from the booking — never from the client (PRD §5).
    const payment = await prisma.payment.create({
      data: {
        bookingId: booking.id,
        provider: gateway.name,
        amount: booking.totalAmount,
        status: PaymentStatus.PENDING,
        idempotencyKey: input.idempotencyKey,
      },
    });

    try {
      const tx = await gateway.createTransaction({
        paymentId: payment.id,
        bookingId: booking.id,
        amount: booking.totalAmount,
        customerName: booking.customerName,
        customerEmail: booking.customerEmail,
        description: `Booking ${booking.id} — ${booking.room.name}`,
      });

      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: { providerRef: tx.providerRef },
      });

      await prisma.paymentEvent.create({
        data: {
          paymentId: payment.id,
          type: "CREATED",
          toState: PaymentStatus.PENDING,
          payload: JSON.stringify({ providerRef: tx.providerRef }),
        },
      });

      // The mock checkout page is gated behind the booking's tracking token
      // (audit fix F2), so the URL handed back carries it.
      const checkoutUrl = this.withTrackingToken(tx.checkoutUrl, booking.trackingToken);
      return { payment: updated, checkoutUrl, reused: false };
    } catch (err) {
      // Gateway could not be reached: mark the payment FAILED so the guest can
      // retry, and let the error surface.
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED },
      });
      logger.error("gateway createTransaction failed", {
        paymentId: payment.id,
        message: err instanceof Error ? err.message : String(err),
      });
      throw paymentError("Could not initiate payment with the provider");
    }
  }

  /** Append the booking's tracking token to a provider checkout URL. */
  private withTrackingToken(url: string, token: string): string {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}token=${encodeURIComponent(token)}`;
  }

  /**
   * Process a verified webhook event.
   *
   * Called ONLY after the gateway adapter has verified the signature. This
   * method performs dedupe, amount cross-check, and the atomic state+ledger
   * write.
   */
  async processWebhookEvent(
    provider: string,
    event: NormalizedWebhookEvent,
    rawBody: string,
    signature: string | null,
  ): Promise<WebhookResult> {
    // --- Dedupe (PRD §6) ---------------------------------------------------
    // The unique constraint on (provider, eventId) is the real guard: a
    // concurrent duplicate loses the insert race and is handled below.
    const already = await prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider, eventId: event.eventId } },
    });
    if (already) {
      return { duplicate: true, status: already.processed ? "processed" : "pending" };
    }

    let webhookRowId: string;
    try {
      const row = await prisma.webhookEvent.create({
        data: { provider, eventId: event.eventId, signature, payload: rawBody },
      });
      webhookRowId = row.id;
    } catch {
      // Lost a race with a concurrent delivery of the same event.
      return { duplicate: true, status: "concurrent-duplicate" };
    }

    try {
      const result = await this.applyEvent(provider, event);
      await prisma.webhookEvent.update({
        where: { id: webhookRowId },
        data: { processed: true, duplicate: result.duplicate },
      });
      return result;
    } catch (err) {
      await prisma.webhookEvent.update({
        where: { id: webhookRowId },
        data: {
          processed: false,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }

  /** Apply the event's effect atomically. */
  private async applyEvent(
    provider: string,
    event: NormalizedWebhookEvent,
  ): Promise<WebhookResult> {
    const payment = event.paymentId
      ? await prisma.payment.findUnique({ where: { id: event.paymentId } })
      : await prisma.payment.findFirst({ where: { providerRef: event.providerRef } });

    if (!payment) throw paymentError("Payment referenced by webhook not found");
    if (payment.provider !== provider) {
      throw paymentError("Webhook provider does not match the payment provider");
    }

    // --- Amount cross-check (PRD §5, §6) ----------------------------------
    // The provider's amount must equal the authoritative stored amount.
    // A mismatch is an attack or a provider bug; refuse to advance state.
    if (event.amount !== payment.amount) {
      logger.error("webhook amount mismatch", {
        paymentId: payment.id,
        expected: payment.amount,
        received: event.amount,
      });
      throw paymentError("Webhook amount does not match the payment amount");
    }

    // --- Terminal-state handling (audit fix F6) ---------------------------
    // Once a payment has reached a terminal state, a webhook asking for the
    // same state is a replay, and one asking for a DIFFERENT state is stale or
    // out of order. Both are acknowledged as no-ops: throwing produced a 500,
    // which made the provider retry forever and marked the webhook as failed.
    if (TERMINAL_PAYMENT_STATES.includes(payment.status)) {
      if (payment.status !== event.status) {
        logger.warn("ignoring webhook for payment in terminal state", {
          paymentId: payment.id,
          currentState: payment.status,
          requestedState: event.status,
        });
      }
      return { duplicate: true, status: payment.status, paymentId: payment.id };
    }

    if (event.status === "PAID") return this.markPaid(payment.id);
    if (event.status === "FAILED") return this.markFailed(payment.id);
    return this.markExpired(payment.id);
  }

  /**
   * PENDING -> PAID, booking -> CONFIRMED, ledger entries, notification.
   *
   * Everything happens in ONE transaction, including the claim on the payment
   * row, so a partial write cannot leave money unaccounted for (PRD §22) and a
   * concurrent PAID webhook cannot post a second set of ledger entries
   * (audit fix F3).
   */
  private async markPaid(paymentId: string): Promise<WebhookResult> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { booking: { include: { room: true } } },
    });
    if (!payment) throw paymentError("Payment not found");

    if (payment.status === PaymentStatus.PAID) {
      return { duplicate: true, status: PaymentStatus.PAID, paymentId };
    }

    // Audit fix F7: validate the path this method actually writes.
    assertPaymentTransition(payment.status as PaymentStatus, PaymentStatus.PAID);
    assertBookingTransition(payment.booking.status as BookingStatus, BookingStatus.PAID);
    assertBookingTransition(BookingStatus.PAID, BookingStatus.CONFIRMED);

    const split = splitFees(payment.amount);

    const claimed = await prisma.$transaction(async (tx) => {
      // Conditional claim: only the request that flips PENDING -> PAID proceeds.
      const res = await tx.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.PAID },
      });
      if (res.count === 0) return false;

      await tx.booking.update({
        where: { id: payment.bookingId },
        data: { status: BookingStatus.CONFIRMED },
      });

      await tx.paymentEvent.create({
        data: {
          paymentId,
          type: "STATE_CHANGE",
          fromState: payment.status,
          toState: PaymentStatus.PAID,
        },
      });

      // Ledger — HOST + PLATFORM + GATEWAY === FULL, enforced by splitFees.
      // The (paymentId, type) unique constraint makes these writes idempotent
      // even if the claim above were somehow bypassed.
      await tx.ledgerEntry.createMany({
        data: [
          { paymentId, type: LedgerType.FULL_PAYMENT, amount: split.fullPayment },
          { paymentId, type: LedgerType.HOST_REVENUE, amount: split.hostRevenue },
          {
            paymentId,
            type: LedgerType.PLATFORM_REVENUE,
            amount: split.platformRevenue,
          },
          { paymentId, type: LedgerType.GATEWAY_FEE, amount: split.gatewayFee },
        ],
      });

      await tx.notification.create({
        data: {
          bookingId: payment.bookingId,
          channel: "log",
          recipient: payment.booking.customerEmail,
          subject: "Booking confirmed",
          body:
            `Your booking for ${payment.booking.room.name} is confirmed. ` +
            `Amount paid: ${formatIdr(payment.amount)}.`,
        },
      });

      return true;
    });

    if (!claimed) {
      const now = await prisma.payment.findUnique({ where: { id: paymentId } });
      return { duplicate: true, status: now?.status ?? "unknown", paymentId };
    }

    logger.info("payment marked paid", {
      paymentId,
      bookingId: payment.bookingId,
      amount: payment.amount,
    });

    return { duplicate: false, status: PaymentStatus.PAID, paymentId };
  }

  private async markFailed(paymentId: string): Promise<WebhookResult> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw paymentError("Payment not found");

    if (payment.status === PaymentStatus.FAILED) {
      return { duplicate: true, status: PaymentStatus.FAILED, paymentId };
    }
    assertPaymentTransition(payment.status as PaymentStatus, PaymentStatus.FAILED);

    const bookingStatus = await this.bookingStatus(payment.bookingId);
    assertBookingTransition(bookingStatus as BookingStatus, BookingStatus.PAYMENT_FAILED);

    const claimed = await prisma.$transaction(async (tx) => {
      const res = await tx.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
      if (res.count === 0) return false;

      await tx.booking.update({
        where: { id: payment.bookingId },
        data: { status: BookingStatus.PAYMENT_FAILED },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId,
          type: "STATE_CHANGE",
          fromState: payment.status,
          toState: PaymentStatus.FAILED,
        },
      });
      return true;
    });

    if (!claimed) {
      const now = await prisma.payment.findUnique({ where: { id: paymentId } });
      return { duplicate: true, status: now?.status ?? "unknown", paymentId };
    }

    return { duplicate: false, status: PaymentStatus.FAILED, paymentId };
  }

  private async markExpired(paymentId: string): Promise<WebhookResult> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw paymentError("Payment not found");

    if (payment.status === PaymentStatus.EXPIRED) {
      return { duplicate: true, status: PaymentStatus.EXPIRED, paymentId };
    }
    assertPaymentTransition(payment.status as PaymentStatus, PaymentStatus.EXPIRED);

    const bookingStatus = await this.bookingStatus(payment.bookingId);
    assertBookingTransition(bookingStatus as BookingStatus, BookingStatus.EXPIRED);

    const claimed = await prisma.$transaction(async (tx) => {
      const res = await tx.payment.updateMany({
        where: { id: paymentId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.EXPIRED },
      });
      if (res.count === 0) return false;

      await tx.booking.update({
        where: { id: payment.bookingId },
        data: { status: BookingStatus.EXPIRED },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId,
          type: "STATE_CHANGE",
          fromState: payment.status,
          toState: PaymentStatus.EXPIRED,
        },
      });
      return true;
    });

    if (!claimed) {
      const now = await prisma.payment.findUnique({ where: { id: paymentId } });
      return { duplicate: true, status: now?.status ?? "unknown", paymentId };
    }

    return { duplicate: false, status: PaymentStatus.EXPIRED, paymentId };
  }

  private async bookingStatus(bookingId: string): Promise<string> {
    const b = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { status: true },
    });
    if (!b) throw notFound("Booking not found");
    return b.status;
  }

  /**
   * Refund a PAID payment (PRD §23).
   *
   * Concurrency (audit fix F3): the operation is claimed by inserting a PENDING
   * Refund row, which is unique per payment. Exactly one caller wins, so the
   * provider is never asked to refund twice and the ledger cannot receive two
   * REFUND entries. If the provider call fails the claim is released so the
   * refund can be retried.
   *
   * Note on the crash window: if the process dies between the provider call and
   * the transaction below, a PENDING Refund row remains and the payment is
   * still PAID. That state is detectable and safely re-runnable; it is
   * deliberately not auto-resolved because only the provider knows whether the
   * money moved.
   */
  async refund(paymentId: string, reason?: string) {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw notFound("Payment not found");
    if (payment.status !== PaymentStatus.PAID) {
      throw conflict("Only a PAID payment can be refunded");
    }
    if (!payment.providerRef) {
      throw paymentError("Payment has no provider reference to refund");
    }

    // --- Claim ---------------------------------------------------------------
    let refundRowId: string;
    try {
      const row = await prisma.refund.create({
        data: {
          paymentId,
          amount: payment.amount,
          status: RefundStatus.PENDING,
          reason: reason ?? null,
        },
      });
      refundRowId = row.id;
    } catch {
      // Unique(paymentId) rejected the insert: a refund already exists or is
      // in flight.
      throw conflict("A refund for this payment is already in progress or completed");
    }

    // --- Provider ------------------------------------------------------------
    let refundResult;
    try {
      const gateway = getGateway(payment.provider);
      refundResult = await gateway.refund({
        providerRef: payment.providerRef,
        amount: payment.amount,
        reason,
      });
    } catch (err) {
      // Release the claim so the refund can be retried.
      await prisma.refund.delete({ where: { id: refundRowId } }).catch(() => undefined);
      throw err;
    }

    if (refundResult.status !== "SUCCEEDED") {
      await prisma.refund
        .update({ where: { id: refundRowId }, data: { status: RefundStatus.FAILED } })
        .catch(() => undefined);
      throw paymentError("Provider did not confirm the refund");
    }

    // --- Persist atomically --------------------------------------------------
    try {
      await prisma.$transaction(async (tx) => {
        // Second claim: the payment transition itself.
        const res = await tx.payment.updateMany({
          where: { id: paymentId, status: PaymentStatus.PAID },
          data: { status: PaymentStatus.REFUNDED },
        });
        if (res.count === 0) {
          throw conflict("Payment is no longer in a refundable state");
        }

        await tx.refund.update({
          where: { id: refundRowId },
          data: { status: RefundStatus.SUCCEEDED },
        });

        await tx.booking.update({
          where: { id: payment.bookingId },
          data: { status: BookingStatus.REFUNDED },
        });

        await tx.paymentEvent.create({
          data: {
            paymentId,
            type: "REFUNDED",
            fromState: PaymentStatus.PAID,
            toState: PaymentStatus.REFUNDED,
          },
        });

        // Negative ledger entry keeps the running totals consistent.
        await tx.ledgerEntry.create({
          data: { paymentId, type: LedgerType.REFUND, amount: -payment.amount },
        });
      });
    } catch (err) {
      // The provider already moved the money. Reverting silently would hide a
      // real inconsistency, so log loudly and keep the claim for reconciliation.
      logger.error("refund persistence failed after provider success", {
        paymentId,
        refundRowId,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    logger.info("payment refunded", { paymentId, amount: payment.amount });
    return { paymentId, status: PaymentStatus.REFUNDED };
  }

  /** Ledger entries for one payment (ADMIN). */
  async ledgerForPayment(paymentId: string) {
    const entries = await prisma.ledgerEntry.findMany({ where: { paymentId } });
    if (entries.length === 0) throw notFound("No ledger entries for this payment");
    return entries;
  }

  /** Full ledger (ADMIN). */
  async allLedger() {
    return prisma.ledgerEntry.findMany({
      include: { payment: { select: { id: true, bookingId: true, provider: true } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async listAllPayments() {
    return prisma.payment.findMany({
      include: {
        booking: { select: { id: true, customerEmail: true, status: true } },
        refunds: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findById(id: string) {
    const payment = await prisma.payment.findUnique({
      where: { id },
      include: { booking: true, refunds: true, events: true },
    });
    if (!payment) throw notFound("Payment not found");
    return payment;
  }

  /** Host revenue: HOST_REVENUE entries for payments on the host's own rooms. */
  async hostRevenue(hostId: string) {
    const entries = await prisma.ledgerEntry.findMany({
      where: {
        type: LedgerType.HOST_REVENUE,
        payment: { booking: { room: { hostId } } },
      },
      include: {
        payment: {
          select: {
            id: true,
            booking: { select: { id: true, room: { select: { name: true } } } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const total = entries.reduce((sum, e) => sum + e.amount, 0);
    return { total, entries };
  }

  /** Platform revenue across all payments (ADMIN). */
  async platformRevenue() {
    const entries = await prisma.ledgerEntry.findMany({
      where: { type: LedgerType.PLATFORM_REVENUE },
    });
    const total = entries.reduce((sum, e) => sum + e.amount, 0);
    return { total, count: entries.length };
  }
}

export const paymentService = new PaymentService();
