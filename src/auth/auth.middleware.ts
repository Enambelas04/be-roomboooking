/**
 * Authentication + authorization middleware (PRD §15).
 *
 *   requireAuth()        — valid JWT required
 *   requireRole("HOST")  — valid JWT AND that role
 *   requireRole("ADMIN") — valid JWT AND that role
 *
 * Role checks are enforced server-side only. The client can never influence
 * its own role, and actor identity always comes from the verified token.
 */

import type { NextFunction, Request, Response } from "express";
import { forbidden, unauthorized } from "../domain/errors";
import { Role } from "../domain/statuses";
import { verifyToken, type AuthTokenPayload } from "./jwt";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || Array.isArray(header)) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

export function requireAuth() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = extractBearer(req);
    if (!token) {
      next(unauthorized("Missing bearer token"));
      return;
    }
    try {
      req.user = verifyToken(token);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = extractBearer(req);
    if (!token) {
      next(unauthorized("Missing bearer token"));
      return;
    }
    try {
      const user = verifyToken(token);
      req.user = user;
      if (!roles.includes(user.role)) {
        next(forbidden(`Requires role: ${roles.join(" or ")}`));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireHost = () => requireRole(Role.HOST);
export const requireAdmin = () => requireRole(Role.ADMIN);

/** Read the authenticated actor id. Throws if called on an unauthenticated route. */
export function actorId(req: Request): string {
  if (!req.user) {
    throw unauthorized("No authenticated actor on this request");
  }
  return req.user.sub;
}
