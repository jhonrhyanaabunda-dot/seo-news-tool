/**
 * Create (or reset) a user from the command line.
 *
 *   npm run user:create -- --email you@example.com --name "Your Name" [--role admin|viewer] [--password "…"]
 *
 * Without --password a strong random password is generated and printed once.
 * Run against production by pointing DATABASE_URL at the production database.
 */
import "./load-env";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      role: { type: "string", default: "admin" },
      password: { type: "string" },
    },
  });
  if (!values.email || !values.name) throw new Error('Usage: npm run user:create -- --email you@example.com --name "Your Name" [--role admin|viewer]');
  const role = values.role === "viewer" ? "viewer" : "admin";

  const { db, sqlClient } = await import("@/lib/db");
  const { users } = await import("@/lib/db/schema");
  const { hashPassword, validatePasswordStrength } = await import("@/lib/auth/password");

  const password = values.password ?? randomBytes(12).toString("base64url");
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(weak);
  const email = values.email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  const [existing] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (existing) {
    await db.update(users).set({ name: values.name, role, passwordHash, isActive: true, updatedAt: new Date() }).where(eq(users.id, existing.id));
    console.log(`Updated existing user ${email} (${role}).`);
  } else {
    await db.insert(users).values({ email, name: values.name, role, passwordHash });
    console.log(`Created user ${email} (${role}).`);
  }
  if (!values.password) console.log(`Temporary password: ${password}\nChange it after signing in (Account → Change password).`);
  await sqlClient.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
