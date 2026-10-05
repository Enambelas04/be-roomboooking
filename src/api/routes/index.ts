/**
 * Route mounting (PRD §30).
 *
 *   /api                PUBLIC + GUEST
 *   /api/auth           login (rate limited)
 *   /api/host           HOST  (router-level guard)
 *   /api/admin          ADMIN (router-level guard)
 *   /api/payments/webhook  WEBHOOK (raw body + signature)
 *
 * The webhook is mounted BEFORE the JSON body parser so it can read the exact
 * raw bytes the provider signed.
 */

import { Router } from "express";
import { publicRouter, webhookRouter } from "./public";
import { authRouter } from "./auth";
import { hostRouter } from "./host";
import { adminRouter } from "./admin";

export const apiRouter = Router();

// Webhook first — must not be touched by express.json().
apiRouter.use(webhookRouter);

apiRouter.use(authRouter);
apiRouter.use(publicRouter);
apiRouter.use("/host", hostRouter);
apiRouter.use("/admin", adminRouter);

export { publicRouter, webhookRouter, authRouter, hostRouter, adminRouter };
