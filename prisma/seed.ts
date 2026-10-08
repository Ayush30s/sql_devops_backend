import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth.ts";

/**
 * Course content — courses, modules, topics, exercises, datasets, badges and the rank ladder — lives only
 * in the database, so the seed has one job left: the admin account, from ADMIN_EMAIL and ADMIN_PASSWORD.
 */
const db = new PrismaClient();

/** The admin account is only created when ADMIN_EMAIL and ADMIN_PASSWORD are set. */
async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL?.toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("  no ADMIN_EMAIL/ADMIN_PASSWORD set, skipping the admin user");
    return;
  }
  const passwordHash = await hashPassword(password);
  await db.user.upsert({
    where: { email },
    create: { email, passwordHash, name: "Admin", role: "ADMIN", profile: { create: {} }, streak: { create: {} } },
    update: { passwordHash, role: "ADMIN" },
  });
  console.log(`  admin user ${email}`);
}

async function main() {
  console.log("Seeding DevOps SQL Academy...");
  await seedAdmin();
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
