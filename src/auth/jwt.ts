/**
 * JWT issuing and verification (PRD §12, §14, §16).
 *
 * The token payload carries the actor identity. Services derive actorId from
 * the verified token — never from the request body (PRD §16).
 */

import jwt, { type SignOptions } from "jsonwebtoken";
import { config } from "../config";
import type { Role } from "../domain/statuses";
import { unauthorized } from "../domain/errors";

export interface AuthTokenPayload {
  /** User id of the authenticated HOST or ADMIN. */
  sub: string;
  role: Role;
  email: string;
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as SignOptions);
}

export function verifyToken(token: string): AuthTokenPayload {
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (typeof decoded !== "object" || decoded === null) {
      throw unauthorized("Invalid token payload");
    }
    const { sub, role, email } = decoded as Record<string, unknown>;
    if (typeof sub !== "string" || typeof role !== "string" || typeof email !== "string") {
      throw unauthorized("Invalid token payload");
    }
    return { sub, role: role as Role, email };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw unauthorized("Token expired");
    }
    // Deliberately vague: never reveal whether the token was malformed,
    // signed with the wrong key, or simply unknown.
    throw unauthorized("Invalid or expired token");
  }
}
