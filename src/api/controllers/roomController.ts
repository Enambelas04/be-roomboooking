/**
 * Room controller.
 *
 * PUBLIC: list/detail of active rooms.
 * HOST:   create/update/deactivate own rooms.
 * ADMIN:  list all rooms.
 */

import type { NextFunction, Request, Response } from "express";
import { roomService } from "../../services/RoomService";
import { serializeRoom } from "../serializers";
import { actorId } from "../../auth/auth.middleware";

export async function listPublicRooms(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rooms = await roomService.listPublic();
    res.json({ rooms });
  } catch (err) {
    next(err);
  }
}

export async function getPublicRoom(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const room = await roomService.findPublicById(req.params.id as string);
    res.json({ room });
  } catch (err) {
    next(err);
  }
}

export async function createRoom(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // hostId comes from the verified JWT, never from the body (PRD §16).
    const room = await roomService.create(actorId(req), req.body);
    res.status(201).json({ room: serializeRoom(room) });
  } catch (err) {
    next(err);
  }
}

export async function listHostRooms(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rooms = await roomService.listForHost(actorId(req));
    res.json({ rooms });
  } catch (err) {
    next(err);
  }
}

export async function updateRoom(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const room = await roomService.update(
      req.params.id as string,
      actorId(req),
      req.body,
    );
    res.json({ room: serializeRoom(room) });
  } catch (err) {
    next(err);
  }
}

export async function deactivateRoom(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const room = await roomService.deactivate(req.params.id as string, actorId(req));
    res.json({ room: serializeRoom(room) });
  } catch (err) {
    next(err);
  }
}

export async function listAllRooms(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rooms = await roomService.listAll();
    res.json({ rooms });
  } catch (err) {
    next(err);
  }
}
