/**
 * Password hashing (PRD §12).
 *
 * bcrypt with a work factor of 12. Plaintext passwords are never stored and
 * hashes are never returned through any API response — the serializers in
 * src/api/serializers.ts are the only place User rows become JSON.
 */

import bcrypt from "bcryptjs";

const WORK_FACTOR = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, WORK_FACTOR);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    // A malformed hash must read as "wrong password", never as an exception
    // that could be distinguished by an attacker.
    return false;
  }
}
