/**
 * BookingService.
 *
 * Guests create bookings without authenticating, so the service:
 *  - validates the room exists and is active
 *  - computes nights and the authoritative total server-side (never trusts a
 *    client-supplied amount — PRD §5)
 *  - generates a cryptographically secure trackingToken (PRD §10)
 *  - prevents overlapping double-bookings for the same room
 *
 * ---------------------------------------------------------------------------
 * Audit fix F5 (overbooking): the overlap check is read-then-write, so two
 * concurrent requests could both see "no overlap" and both insert. Booking
 * creation is now serialized per room (withRoomLock) AND the overlap is
 * re-checked inside the same transaction as the insert, so a race cannot slip
 * between the check and the write.
 */

import crypto from "node:crypto";
import { prisma } from "../database/prisma";
import { bookingError, conflict, notFound } from "../domain/errors";
import { nightsBetween } from "../domain/money";
import { withRoomLock } from "../lib/roomLock";
import { BookingStatus } from "../domain/statuses";

export interface CreateBookingInput {
  roomId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  checkIn: Date;
  checkOut: Date;
}

/** Booking states that occupy the room and therefore block an overlap. */
const OCCUPYING_STATUSES = [
  BookingStatus.PENDING_PAYMENT,
  BookingStatus.PAID,
  BookingStatus.CONFIRMED,
];

/** 32 bytes of CSPRNG entropy, URL-safe. Not guessable, not sequential. */
export function generateTrackingToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export class BookingService {
  /**
   * Create a guest booking in PENDING_PAYMENT.
   *
   * Overlap rule: two bookings for the same room conflict when their
   * [checkIn, checkOut) ranges intersect and the existing booking still
   * occupies the room.
   */
  async createBooking(input: CreateBookingInput) {
    const nights = nightsBetween(input.checkIn, input.checkOut);
    if (nights <= 0) {
      throw bookingError("checkOut must be after checkIn");
    }

    const room = await prisma.room.findUnique({ where: { id: input.roomId } });
    if (!room) throw notFound("Room not found");
    if (!room.isActive) throw bookingError("Room is not available for booking");

    // Serialize per room so the check and the insert cannot interleave
    // (audit fix F5).
    return withRoomLock(room.id, async () => {
      // Authoritative amount, computed server-side from the room's own price.
      const totalAmount = room.pricePerNight * nights;

      // The overlap check and the insert share one transaction. The DB-level
      // re-check is the second line of defence behind the in-process lock.
      return prisma.$transaction(async (tx) => {
        const overlapping = await tx.booking.findFirst({
          where: {
            roomId: room.id,
            status: { in: OCCUPYING_STATUSES },
            checkIn: { lt: input.checkOut },
            checkOut: { gt: input.checkIn },
          },
        });
        if (overlapping) {
          throw conflict("Room is not available for the selected dates");
        }

        return tx.booking.create({
          data: {
            roomId: room.id,
            customerName: input.customerName,
            customerEmail: input.customerEmail,
            customerPhone: input.customerPhone ?? null,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
            nights,
            totalAmount,
            status: BookingStatus.PENDING_PAYMENT,
            trackingToken: generateTrackingToken(),
          },
          include: { room: true },
        });
      });
    });
  }

  /**
   * Look up a booking by its tracking token — the only way a guest reads a
   * booking. A wrong token yields 404, never 403, so tokens cannot be
   * enumerated by response differences.
   */
  async findByTrackingToken(token: string) {
    const booking = await prisma.booking.findUnique({
      where: { trackingToken: token },
      include: {
        room: {
          select: {
            id: true,
            name: true,
            description: true,
            pricePerNight: true,
            capacity: true,
            // host is intentionally NOT included: host private info must not
            // leak to guests (PRD §10).
          },
        },
        payments: {
          select: {
            id: true,
            status: true,
            amount: true,
            provider: true,
            createdAt: true,
            // No ledger entries, no provider secrets.
          },
        },
      },
    });
    if (!booking) throw notFound("Booking not found");
    return booking;
  }

  /** Bookings belonging to a host's own rooms only (PRD §13). */
  async listForHost(hostId: string) {
    return prisma.booking.findMany({
      where: { room: { hostId } },
      include: {
        room: { select: { id: true, name: true } },
        payments: { select: { id: true, provider: true, amount: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /** All bookings — ADMIN only (PRD §14). */
  async listAll() {
    return prisma.booking.findMany({
      include: {
        room: { select: { id: true, name: true, hostId: true } },
        payments: { select: { id: true, provider: true, amount: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findById(id: string) {
    const booking = await prisma.booking.findUnique({
      where: { id },
      include: { room: true },
    });
    if (!booking) throw notFound("Booking not found");
    return booking;
  }
}

export const bookingService = new BookingService();
