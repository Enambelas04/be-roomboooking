/**
 * ADMIN routes (PRD §14, §17).
 *
 * Router-level `requireAdmin()` guard — admin endpoints can never be publicly
 * accessible.
 */

import { Router } from "express";
import { requireAdmin } from "../../auth/auth.middleware";
import { validate } from "../middleware/validate";
import {
  createUserSchema,
  idParamSchema,
  refundSchema,
} from "../schemas";
import { listAllRooms } from "../controllers/roomController";
import { getBookingById, listAllBookings } from "../controllers/bookingController";
import {
  getPayment,
  listLedger,
  listPayments,
  platformRevenue,
  refundPayment,
} from "../controllers/paymentController";
import {
  createUser,
  deactivateUser,
  listUsers,
} from "../controllers/adminController";

export const adminRouter = Router();

adminRouter.use(requireAdmin());

// Bookings & rooms
adminRouter.get("/bookings", listAllBookings);
adminRouter.get("/bookings/:id", validate(idParamSchema, "params"), getBookingById);
adminRouter.get("/rooms", listAllRooms);

// Payments, refunds, ledger, revenue
adminRouter.get("/payments", listPayments);
adminRouter.get("/payments/:id", validate(idParamSchema, "params"), getPayment);
adminRouter.post(
  "/payments/:id/refund",
  validate(idParamSchema, "params"),
  validate(refundSchema),
  refundPayment,
);
adminRouter.get("/ledger", listLedger);
adminRouter.get("/revenue", platformRevenue);

// Administrative accounts
adminRouter.get("/users", listUsers);
adminRouter.post("/users", validate(createUserSchema), createUser);
adminRouter.post("/users/:id/deactivate", validate(idParamSchema, "params"), deactivateUser);
