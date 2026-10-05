/**
 * Auth controller — HOST and ADMIN login (PRD §12, §14).
 */

import type { NextFunction, Request, Response } from "express";
import { authService } from "../../services/AuthService";
import { Role } from "../../domain/statuses";

export async function hostLogin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await authService.login(req.body, Role.HOST);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function adminLogin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await authService.login(req.body, Role.ADMIN);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/** Who am I — useful for the frontend to verify a stored token. */
export async function me(req: Request, res: Response): Promise<void> {
  res.json({ user: req.user });
}
