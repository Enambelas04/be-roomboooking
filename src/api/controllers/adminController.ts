/**
 * Admin controller (PRD §14). Every route here is ADMIN-only; the guard is
 * applied in the router, not here.
 */

import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../database/prisma";
import { authService } from "../../services/AuthService";
import { hashPassword } from "../../auth/password";
import { conflict } from "../../domain/errors";
import { normalizeEmail } from "../../domain/email";
import { serializeUser } from "../serializers";

export async function listUsers(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const users = await authService.listUsers();
    res.json({ users });
  } catch (err) {
    next(err);
  }
}

/** Create a HOST or ADMIN account. */
export async function createUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { password, name, role } = req.body;
    // Audit fix F1: normalize on write so it matches the lowercased lookup used
    // at login. Storing the raw value locked out any email with an uppercase
    // character.
    const email = normalizeEmail(req.body.email);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw conflict("An account with that email already exists");

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        name: name ?? null,
        role,
      },
    });
    // serializeUser never includes passwordHash.
    res.status(201).json({ user: serializeUser(user) });
  } catch (err) {
    next(err);
  }
}

export async function deactivateUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id as string },
      data: { isActive: false },
    });
    res.json({ user: serializeUser(user) });
  } catch (err) {
    next(err);
  }
}
