/**
 * Booking controller.
 *
 * GUEST:  create a booking; read it back with the tracking token.
 * HOST:   bookings for own rooms.
 * ADMIN:  all bookings.
 */

import type { NextFunction, Request, Response } from "express";
import { bookingService } from "../../services/BookingService";
import { actorId } from "../../auth/auth.middleware";
import {
  serializeBookingForGuest,
  serializeBookingForStaff,
} from "../serializers";

export async function createBooking(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const booking = await bookingService.createBooking(req.body);
    // 201 with the tracking token — this is the ONLY response that returns it
    // alongside creation; afterwards the guest must supply it.
    res.status(201).json({ booking: serializeBookingForGuest(booking) });
  } catch (err) {
    next(err);
  }
}

/** GUEST: read a booking by its secure tracking token. */
export async function getBookingByToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const booking = await bookingService.findByTrackingToken(req.params.token as string);
    res.json({ booking: serializeBookingForGuest(booking) });
  } catch (err) {
    next(err);
  }
}

export async function listHostBookings(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bookings = await bookingService.listForHost(actorId(req));
    res.json({ bookings: bookings.map(serializeBookingForStaff) });
  } catch (err) {
    next(err);
  }
}

export async function listAllBookings(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bookings = await bookingService.listAll();
    res.json({ bookings: bookings.map(serializeBookingForStaff) });
  } catch (err) {
    next(err);
  }
}

export async function getBookingById(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const booking = await bookingService.findById(req.params.id as string);
    res.json({ booking: serializeBookingForStaff(booking) });
  } catch (err) {
    next(err);
  }
}
