/**
 * Request schemas (zod).
 *
 * Note what is ABSENT by design:
 *  - no `status` field on any payment/booking write — clients cannot declare
 *    state (PRD §5)
 *  - no `amount` on booking/payment creation — the server derives it (PRD §5)
 *  - no `actorId`/`hostId`/`role` — identity comes from the JWT (PRD §16)
 */

import { z } from "zod";

const email = z.string().trim().toLowerCase().email("Must be a valid email");
const phone = z
  .string()
  .trim()
  .min(6, "Phone number is too short")
  .max(32, "Phone number is too long");

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required"),
});

export const createBookingSchema = z
  .object({
    roomId: z.string().min(1, "roomId is required"),
    customerName: z.string().trim().min(1, "Name is required").max(120),
    customerEmail: email,
    customerPhone: phone.optional(),
    checkIn: z.coerce.date(),
    checkOut: z.coerce.date(),
  })
  .refine((d) => d.checkOut > d.checkIn, {
    message: "checkOut must be after checkIn",
    path: ["checkOut"],
  });

export const createPaymentSchema = z.object({
  bookingId: z.string().min(1, "bookingId is required"),
  // Audit fix F9: the guest must prove ownership of the booking by presenting
  // its tracking token. Without this, anyone who knows (or guesses) a booking
  // id could create payments against another guest's booking.
  trackingToken: z.string().min(20, "trackingToken is required").max(200),
  // Optional; generated server-side when omitted so guests need not manage it.
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const trackingTokenParamSchema = z.object({
  token: z.string().min(20, "Invalid tracking token").max(200),
});

export const idParamSchema = z.object({
  id: z.string().min(1),
});

export const createRoomSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(160),
  description: z.string().trim().max(2000).optional(),
  pricePerNight: z.coerce
    .number()
    .int("Price must be an integer number of rupiah")
    .positive("Price must be greater than zero"),
  capacity: z.coerce.number().int().positive().max(50).optional(),
});

export const updateRoomSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).optional(),
  pricePerNight: z.coerce.number().int().positive().optional(),
  capacity: z.coerce.number().int().positive().max(50).optional(),
  isActive: z.boolean().optional(),
});

export const refundSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const createUserSchema = z.object({
  email,
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  name: z.string().trim().max(120).optional(),
  role: z.enum(["HOST", "ADMIN"]),
});

export const mockCheckoutQuerySchema = z.object({
  token: z.string().min(20, "token is required").max(200),
});

export const webhookQuerySchema = z.object({
  provider: z.string().min(1).optional(),
});
