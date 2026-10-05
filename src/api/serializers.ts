/**
 * Response serializers.
 *
 * The single boundary where DB rows become JSON. Guarantees that sensitive
 * columns (passwordHash, provider secrets, idempotency keys) can never be
 * emitted by accident, even if a service returns a whole row.
 *
 * Inputs are declared structurally (not as full Prisma models) so callers that
 * use a narrower `select` still type-check. Every serializer whitelists its
 * output fields — nothing is spread through blindly.
 */

// --- Structural input shapes ------------------------------------------------

export interface UserLike {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

export interface RoomLike {
  id: string;
  name: string;
  description: string | null;
  pricePerNight: number;
  capacity: number;
  isActive?: boolean;
  createdAt?: Date;
}

export interface PaymentLike {
  id: string;
  bookingId?: string;
  provider: string;
  amount: number;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
  refunds?: RefundLike[];
}

export interface RefundLike {
  id: string;
  paymentId: string;
  amount: number;
  status: string;
  reason: string | null;
  createdAt?: Date;
}

export interface BookingLike {
  id: string;
  trackingToken: string;
  status: string;
  roomId?: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  totalAmount: number;
  createdAt?: Date;
  room?: unknown;
  payments?: PaymentLike[];
}

export interface LedgerLike {
  id: string;
  paymentId: string;
  type: string;
  amount: number;
  createdAt?: Date;
}

// --- Serializers ------------------------------------------------------------

/** Public user projection — NEVER includes passwordHash. */
export function serializeUser(user: UserLike) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export function serializeRoom(room: RoomLike) {
  return {
    id: room.id,
    name: room.name,
    description: room.description,
    pricePerNight: room.pricePerNight,
    capacity: room.capacity,
    ...(room.isActive !== undefined ? { isActive: room.isActive } : {}),
    ...(room.createdAt !== undefined ? { createdAt: room.createdAt } : {}),
  };
}

export function serializePayment(payment: PaymentLike) {
  return {
    id: payment.id,
    ...(payment.bookingId !== undefined ? { bookingId: payment.bookingId } : {}),
    provider: payment.provider,
    amount: payment.amount,
    status: payment.status,
    ...(payment.createdAt !== undefined ? { createdAt: payment.createdAt } : {}),
    ...(payment.updatedAt !== undefined ? { updatedAt: payment.updatedAt } : {}),
    // providerRef and idempotencyKey are internal identifiers — not exposed.
    ...(payment.refunds ? { refunds: payment.refunds.map(serializeRefund) } : {}),
  };
}

export function serializeRefund(refund: RefundLike) {
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    amount: refund.amount,
    status: refund.status,
    reason: refund.reason,
    ...(refund.createdAt !== undefined ? { createdAt: refund.createdAt } : {}),
  };
}

/**
 * Guest-facing booking projection (PRD §10).
 * Excludes internal ledger data, host private info, and platform revenue.
 * trackingToken IS returned — it is the guest's own handle, required to read
 * the booking.
 */
export function serializeBookingForGuest(booking: BookingLike) {
  return {
    id: booking.id,
    trackingToken: booking.trackingToken,
    status: booking.status,
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    customerPhone: booking.customerPhone,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    nights: booking.nights,
    totalAmount: booking.totalAmount,
    ...(booking.createdAt !== undefined ? { createdAt: booking.createdAt } : {}),
    ...(booking.room !== undefined ? { room: booking.room } : {}),
    ...(booking.payments ? { payments: booking.payments.map(serializePayment) } : {}),
  };
}

/**
 * Host/Admin booking projection. Deliberately omits trackingToken — staff read
 * bookings by id, and a leaked token would hand a guest's booking to anyone
 * with staff read access.
 */
export function serializeBookingForStaff(booking: BookingLike) {
  return {
    id: booking.id,
    status: booking.status,
    ...(booking.roomId !== undefined ? { roomId: booking.roomId } : {}),
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    customerPhone: booking.customerPhone,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    nights: booking.nights,
    totalAmount: booking.totalAmount,
    ...(booking.createdAt !== undefined ? { createdAt: booking.createdAt } : {}),
    ...(booking.room !== undefined ? { room: booking.room } : {}),
    ...(booking.payments ? { payments: booking.payments.map(serializePayment) } : {}),
  };
}

export function serializeLedgerEntry(entry: LedgerLike) {
  return {
    id: entry.id,
    paymentId: entry.paymentId,
    type: entry.type,
    amount: entry.amount,
    ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
  };
}
