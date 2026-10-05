/**
 * AuthService (PRD §12, §14).
 *
 * Login for HOST and ADMIN. Guests have no account and no login route.
 *
 * Security notes:
 *  - Unknown email and wrong password both return the SAME error, so the
 *    endpoint cannot be used to enumerate accounts.
 *  - Password hashes never leave this layer.
 */

import { prisma } from "../database/prisma";
import { unauthorized } from "../domain/errors";
import { Role } from "../domain/statuses";
import { verifyPassword } from "../auth/password";
import { signToken } from "../auth/jwt";

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  token: string;
  user: { id: string; email: string; name: string | null; role: Role };
}

export class AuthService {
  async login(input: LoginInput, expectedRole?: Role): Promise<LoginResult> {
    const user = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });

    // Same generic failure whether the account is missing, inactive, or the
    // password is wrong.
    const genericFailure = unauthorized("Invalid email or password");

    if (!user) {
      // Still spend time hashing-equivalent work so timing does not reveal
      // whether the account exists.
      await verifyPassword(input.password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
      throw genericFailure;
    }
    if (!user.isActive) throw genericFailure;
    if (expectedRole && user.role !== expectedRole) throw genericFailure;

    const ok = await verifyPassword(input.password, user.passwordHash);
    if (!ok) throw genericFailure;

    const token = signToken({
      sub: user.id,
      role: user.role as Role,
      email: user.email,
    });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role as Role,
      },
    };
  }

  /** ADMIN: manage hosts (PRD §14). */
  async listUsers() {
    return prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
  }
}

export const authService = new AuthService();
