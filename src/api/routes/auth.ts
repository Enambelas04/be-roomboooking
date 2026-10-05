/**
 * AUTH routes — login for the two authenticated roles (PRD §12, §14).
 * Guests have no login route and no account.
 */

import { Router } from "express";
import { authRateLimiter } from "../middleware/rateLimit";
import { validate } from "../middleware/validate";
import { loginSchema } from "../schemas";
import { adminLogin, hostLogin, me } from "../controllers/authController";
import { requireAuth } from "../../auth/auth.middleware";

export const authRouter = Router();

authRouter.post("/host/login", authRateLimiter(), validate(loginSchema), hostLogin);
authRouter.post("/admin/login", authRateLimiter(), validate(loginSchema), adminLogin);
authRouter.get("/me", requireAuth(), me);
