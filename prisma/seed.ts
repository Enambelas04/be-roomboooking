/**
 * Development seed.
 *
 * Creates one ADMIN and one HOST plus a couple of rooms so the API can be
 * exercised immediately. Passwords come from .env — never hardcoded here.
 */

import { prisma } from "../src/database/prisma";
import { hashPassword } from "../src/auth/password";
import { config } from "../src/config";
import { normalizeEmail } from "../src/domain/email";
import { Role } from "../src/domain/statuses";

async function main(): Promise<void> {
  const { adminEmail, adminPassword, hostEmail, hostPassword } = config.seed;

  if (!adminEmail || !adminPassword || !hostEmail || !hostPassword) {
    console.error(
      "Seed skipped: set SEED_ADMIN_EMAIL/PASSWORD and SEED_HOST_EMAIL/PASSWORD in .env",
    );
    return;
  }

  const adminEmailNorm = normalizeEmail(adminEmail);
  const hostEmailNorm = normalizeEmail(hostEmail);

  const admin = await prisma.user.upsert({
    where: { email: adminEmailNorm },
    update: {},
    create: {
      email: adminEmailNorm,
      passwordHash: await hashPassword(adminPassword),
      name: "Administrator",
      role: Role.ADMIN,
    },
  });

  const host = await prisma.user.upsert({
    where: { email: hostEmailNorm },
    update: {},
    create: {
      email: hostEmailNorm,
      passwordHash: await hashPassword(hostPassword),
      name: "Demo Host",
      role: Role.HOST,
    },
  });

  const existingRooms = await prisma.room.count({ where: { hostId: host.id } });
  if (existingRooms === 0) {
    await prisma.room.createMany({
      data: [
        {
          hostId: host.id,
          name: "Deluxe Room — Bogor",
          description: "Spacious room with garden view.",
          pricePerNight: 825_000,
          capacity: 2,
        },
        {
          hostId: host.id,
          name: "Standard Room — Bogor",
          description: "Cozy room for short stays.",
          pricePerNight: 450_000,
          capacity: 2,
        },
      ],
    });
  }

  console.log("Seed complete:");
  console.log(`  ADMIN ${admin.email}`);
  console.log(`  HOST  ${host.email}`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
