/**
 * HOST routes (PRD §13, §17).
 *
 * The router-level `requireHost()` guard means every route defined below is
 * protected by construction — a newly added route cannot forget the check.
 *
 * Hosts may NOT: modify payment status, view another host's rooms or
 * bookings, see platform revenue, or reach admin endpoints.
 */

import { Router } from "express";
import { requireHost } from "../../auth/auth.middleware";
import { validate } from "../middleware/validate";
import { idParamSchema, createRoomSchema, updateRoomSchema } from "../schemas";
import {
  createRoom,
  deactivateRoom,
  listHostRooms,
  updateRoom,
} from "../controllers/roomController";
import { listHostBookings } from "../controllers/bookingController";
import { hostRevenue, refundPayment } from "../controllers/paymentController";

export const hostRouter = Router();

// Applied once, at the router level — not per-route.
hostRouter.use(requireHost());

// Rooms
hostRouter.post("/rooms", validate(createRoomSchema), createRoom);
hostRouter.get("/rooms", listHostRooms);
hostRouter.patch(
  "/rooms/:id",
  validate(idParamSchema, "params"),
  validate(updateRoomSchema),
  updateRoom,
);
hostRouter.delete(
  "/rooms/:id",
  validate(idParamSchema, "params"),
  deactivateRoom,
);

// Bookings for the host's own rooms only
hostRouter.get("/bookings", listHostBookings);

// Revenue — HOST_REVENUE entries for the host's own rooms only
hostRouter.get("/revenue", hostRevenue);

// Refund a payment for one of the host's own rooms
hostRouter.post("/payments/:id/refund", validate(idParamSchema, "params"), refundPayment);

// NOTE: there is deliberately NO route here that can set a payment status.
// PAID is reachable only via the signature-verified webhook (PRD §5).
