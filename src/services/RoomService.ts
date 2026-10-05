/**
 * RoomService.
 *
 * Hosts own rooms; authorization is enforced by checking room.hostId against
 * the authenticated actorId from the JWT — never against a client-supplied
 * host id (PRD §13, §16).
 */

import { prisma } from "../database/prisma";
import { forbidden, notFound } from "../domain/errors";

export interface CreateRoomInput {
  name: string;
  description?: string;
  pricePerNight: number;
  capacity?: number;
}

export type UpdateRoomInput = Partial<CreateRoomInput> & { isActive?: boolean };

export class RoomService {
  /** PUBLIC: only active rooms are visible to guests. */
  async listPublic() {
    return prisma.room.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        description: true,
        pricePerNight: true,
        capacity: true,
        // hostId deliberately omitted from the public projection.
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findPublicById(id: string) {
    const room = await prisma.room.findFirst({
      where: { id, isActive: true },
      select: {
        id: true,
        name: true,
        description: true,
        pricePerNight: true,
        capacity: true,
      },
    });
    if (!room) throw notFound("Room not found");
    return room;
  }

  async create(hostId: string, input: CreateRoomInput) {
    return prisma.room.create({
      data: {
        hostId,
        name: input.name,
        description: input.description ?? null,
        pricePerNight: input.pricePerNight,
        capacity: input.capacity ?? 2,
      },
    });
  }

  /** Rooms owned by the authenticated host. */
  async listForHost(hostId: string) {
    return prisma.room.findMany({
      where: { hostId },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Update a room, but only when the caller owns it.
   * Ownership check happens against the stored hostId, so a host can never
   * edit another host's room by guessing an id.
   */
  async update(roomId: string, hostId: string, input: UpdateRoomInput) {
    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw notFound("Room not found");
    if (room.hostId !== hostId) {
      throw forbidden("You do not own this room");
    }

    return prisma.room.update({
      where: { id: roomId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.pricePerNight !== undefined
          ? { pricePerNight: input.pricePerNight }
          : {}),
        ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
  }

  /** Soft-delete (deactivate) a room the caller owns. */
  async deactivate(roomId: string, hostId: string) {
    return this.update(roomId, hostId, { isActive: false });
  }

  /** ADMIN: every room regardless of owner. */
  async listAll() {
    return prisma.room.findMany({
      include: { host: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
  }
}

export const roomService = new RoomService();
