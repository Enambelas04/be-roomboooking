/**
 * Payment controller.
 *
 * POST /api/payments/create   GUEST + booking validation
 * POST /api/payments/webhook  WEBHOOK + signature verification
 *
 * The webhook handler does NOT accept a client-declared status. It hands the
 * RAW body to the gateway adapter, which verifies the signature, and only then
 * does PaymentService touch state (PRD §5, §6).
 */

import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../database/prisma";
import { config } from "../../config";
import { paymentService } from "../../services/PaymentService";
import { getGateway } from "../../payment/registry";
import { MOCK_SIGNATURE_HEADER, MockPaymentGateway } from "../../payment/MockPaymentGateway";
import { serializePayment } from "../serializers";
import { actorId } from "../../auth/auth.middleware";
import { badRequest, forbidden } from "../../domain/errors";
import { Role } from "../../domain/statuses";

/** GUEST: create a payment for a booking. Amount always comes from the booking. */
export async function createPayment(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bookingId: string = req.body.bookingId;
    // Audit fix F9: the tracking token proves the caller owns the booking.
    const trackingToken: string = req.body.trackingToken;
    // Server-generated idempotency key when the client does not supply one.
    const idempotencyKey: string =
      req.body.idempotencyKey ?? `auto_${bookingId}_${crypto.randomUUID()}`;

    const result = await paymentService.createPayment({
      bookingId,
      trackingToken,
      idempotencyKey,
    });
    res.status(result.reused ? 200 : 201).json({
      payment: serializePayment(result.payment),
      checkoutUrl: result.checkoutUrl,
      reused: result.reused,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * WEBHOOK: provider -> us.
 *
 * Reads the raw body (captured by rawBodyCapture), asks the gateway adapter to
 * verify the signature and normalize the event, then lets PaymentService apply
 * it idempotently.
 */
export async function handleWebhook(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawBody = req.rawBody ?? "";
    if (!rawBody) {
      throw badRequest("Empty webhook body");
    }

    const provider = (req.query.provider as string | undefined) ?? undefined;
    const gateway = getGateway(provider);

    // Throws on forged/invalid signature — nothing is written in that case.
    const event = await gateway.parseWebhook({
      rawBody,
      headers: req.headers as Record<string, string | string[] | undefined>,
      query: req.query as Record<string, unknown>,
    });

    const signatureHeader =
      req.headers[MOCK_SIGNATURE_HEADER] ?? req.headers["x-signature"];
    const signature = Array.isArray(signatureHeader)
      ? (signatureHeader[0] ?? null)
      : (signatureHeader ?? null);

    const result = await paymentService.processWebhookEvent(
      gateway.name,
      event,
      rawBody,
      signature,
    );

    res
      .status(200)
      .json({ received: true, duplicate: result.duplicate, status: result.status });
  } catch (err) {
    next(err);
  }
}

/** HOST (own rooms) or ADMIN: refund a PAID payment (PRD §23). */
export async function refundPayment(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = req.user;
    if (!user) throw forbidden();

    const paymentId = req.params.id as string;

    if (user.role === Role.HOST) {
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        select: { booking: { select: { room: { select: { hostId: true } } } } },
      });
      if (!payment) {
        // Delegate to the service for the canonical 404 shape.
        await paymentService.findById(paymentId);
      }
      if (payment && payment.booking.room.hostId !== actorId(req)) {
        throw forbidden("You do not own the room for this payment");
      }
    }

    const result = await paymentService.refund(paymentId, req.body?.reason);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPayment(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payment = await paymentService.findById(req.params.id as string);
    res.json({ payment: serializePayment(payment) });
  } catch (err) {
    next(err);
  }
}

/** HOST: revenue for own rooms. */
export async function hostRevenue(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await paymentService.hostRevenue(actorId(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function listPayments(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const payments = await paymentService.listAllPayments();
    res.json({ payments: payments.map((p) => serializePayment(p)) });
  } catch (err) {
    next(err);
  }
}

export async function listLedger(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const entries = await paymentService.allLedger();
    res.json({ entries });
  } catch (err) {
    next(err);
  }
}

export async function platformRevenue(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await paymentService.platformRevenue();
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * Mock checkout page (PRD §7).
 *
 * Audit fix F2: this page is gated twice.
 *   1. It is refused entirely when NODE_ENV=production — the mock provider is a
 *      development aid and must never be reachable from a production host.
 *   2. It requires the booking's tracking token, so holding a transaction
 *      reference is not enough to self-approve a payment.
 *
 * Each button POSTs a SIGNED webhook back to our own webhook endpoint using
 * fetch — it does NOT post a form body, because the signature is computed over
 * the exact raw JSON bytes and a form-encoded submission would not verify.
 */
export async function mockCheckout(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (config.isProduction) {
      res.status(404).send("Not found");
      return;
    }

    const providerRef = req.params.transaction as string;
    const token = req.query.token as string | undefined;

    const payment = await prisma.payment.findFirst({
      where: { providerRef },
      include: { booking: { select: { trackingToken: true } } },
    });
    // Same response whether the transaction is unknown or the token is wrong,
    // so neither can be probed.
    if (!payment || !token || payment.booking.trackingToken !== token) {
      res.status(404).send("Not found");
      return;
    }

    // Build signed payloads server-side so the secret never reaches the page.
    const gateway = new MockPaymentGateway();
    const payloads = {
      PAID: gateway.buildSignedWebhook({
        eventId: crypto.randomUUID(),
        providerRef,
        paymentId: payment.id,
        status: "PAID",
        amount: payment.amount,
      }),
      FAILED: gateway.buildSignedWebhook({
        eventId: crypto.randomUUID(),
        providerRef,
        paymentId: payment.id,
        status: "FAILED",
        amount: payment.amount,
      }),
      EXPIRED: gateway.buildSignedWebhook({
        eventId: crypto.randomUUID(),
        providerRef,
        paymentId: payment.id,
        status: "EXPIRED",
        amount: payment.amount,
      }),
    };

    const buttons = (Object.keys(payloads) as Array<keyof typeof payloads>)
      .map(
        (k) => `<button data-status="${k}"
      data-body='${payloads[k].rawBody.replace(/'/g, "&#39;")}'
      data-sig="${payloads[k].headers[MOCK_SIGNATURE_HEADER]}">${k}</button>`,
      )
      .join("\n");

    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8">
<title>Mock Checkout</title></head>
<body style="font-family:sans-serif;max-width:560px;margin:60px auto">
<h1>Mock Payment Gateway</h1>
<p><em>Development only — never enabled in production.</em></p>
<p>Transaction <code>${providerRef}</code></p>
<p>Amount: <strong>Rp ${payment.amount.toLocaleString("id-ID")}</strong></p>
<p>Status: <code>${payment.status}</code></p>
<p>Choosing an outcome emits a <em>signed</em> webhook to
<code>/api/payments/webhook?provider=mock</code>:</p>
<div id="btns">${buttons}</div>
<pre id="out" style="background:#f4f4f4;padding:10px;margin-top:20px"></pre>
<script>
document.querySelectorAll('#btns button').forEach(function (b) {
  b.addEventListener('click', async function () {
    var out = document.getElementById('out');
    out.textContent = 'sending ' + b.dataset.status + '...';
    try {
      var r = await fetch('/api/payments/webhook?provider=mock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   '${MOCK_SIGNATURE_HEADER}': b.dataset.sig },
        body: b.dataset.body
      });
      out.textContent = r.status + ' ' + JSON.stringify(await r.json());
    } catch (e) { out.textContent = 'error: ' + e; }
  });
});
</script>
</body></html>`);
  } catch (err) {
    next(err);
  }
}
