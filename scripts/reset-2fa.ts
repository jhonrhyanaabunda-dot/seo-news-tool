/**
 * Emergency: clear a user's two-factor login when they have lost both their phone
 * and their recovery codes and no other administrator can reset it from Users.
 *
 *   npm run user:2fa-reset -- --email you@a3brands.com
 */
import "./load-env";
import { parseArgs } from "node:util";
import postgres from "postgres";

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" } } });
  const email = values.email?.trim().toLowerCase();
  if (!email) throw new Error("Usage: npm run user:2fa-reset -- --email you@a3brands.com");
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const rows = await sql`
      update users set totp_secret_enc = null, totp_enabled_at = null, totp_last_step = null, totp_recovery_hashes = null, updated_at = now()
      where lower(email) = ${email} returning id, email`;
    if (!rows.length) throw new Error(`No user with the email ${email}.`);
    await sql`insert into system_logs (level, source, message, details) values ('warn', 'auth', 'Two-factor login reset from the command line', ${sql.json({ email })})`;
    console.log(`Two-factor login cleared for ${rows[0].email}. They can sign in with their password and set it up again.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
