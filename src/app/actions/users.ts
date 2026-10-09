"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { assertAdmin, assertUser } from "@/lib/auth/guards";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/lib/auth/password";
import { revokeAllSessions } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { dealerships, userDealerships, users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { cleanText } from "@/lib/security/sanitize";

export type UserFormState = { error?: string; ok?: string; tempPassword?: string } | undefined;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run a change that removes `targetId` as an active administrator only if another active administrator remains.
 * The admin rows are locked first, so two admins removing each other at the same moment can't both succeed.
 * Returns undefined (and changes nothing) when it would leave no administrator.
 */
async function keepAnAdmin<T>(targetId: number, change: (tx: Tx) => Promise<T>): Promise<T | undefined> {
  return db.transaction(async (tx) => {
    const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), eq(users.isActive, true))).for("update");
    if (!admins.some((a) => a.id !== targetId)) return undefined;
    return change(tx);
  });
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; i++) {
    if ((e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export async function createUserAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const admin = await assertAdmin();
  const parsed = z
    .object({
      email: z.string().trim().toLowerCase().email().max(320),
      name: z.string().transform((v) => cleanText(v, 200)).pipe(z.string().min(2)),
      role: z.enum(["admin", "viewer", "client"]),
    })
    .safeParse({ email: formData.get("email"), name: formData.get("name"), role: formData.get("role") });
  if (!parsed.success) return { error: "Enter a valid name, email address and role." };
  const [exists] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${parsed.data.email}`).limit(1);
  if (exists) return { error: "A user with this email address already exists." };
  const tempPassword = randomBytes(12).toString("base64url");
  await db.insert(users).values({ ...parsed.data, passwordHash: await hashPassword(tempPassword) });
  await logger.info("admin", "User created", { by: admin.email, email: parsed.data.email, role: parsed.data.role });
  revalidatePath("/admin/users");
  return { ok: `Account created for ${parsed.data.email}. Share this temporary password securely; it is shown only once.`, tempPassword };
}

export async function updateUserAction(formData: FormData) {
  const admin = await assertAdmin();
  const id = z.coerce.number().int().positive().parse(formData.get("userId"));
  const op = String(formData.get("op"));
  if (id === admin.id && op !== "noop") {
    // Prevent admins locking themselves out.
    return;
  }
  if (op === "make-admin" || op === "activate") {
    await db.update(users).set(op === "make-admin" ? { role: "admin", updatedAt: new Date() } : { isActive: true, updatedAt: new Date() }).where(eq(users.id, id));
  } else if (op === "make-viewer" || op === "make-client" || op === "deactivate") {
    const change = op === "make-viewer" ? { role: "viewer" as const } : op === "make-client" ? { role: "client" as const } : { isActive: false };
    const done = await keepAnAdmin(id, (tx) => tx.update(users).set({ ...change, updatedAt: new Date() }).where(eq(users.id, id)).returning({ id: users.id }));
    // A demoted or deactivated account must not keep browsing on its old cookie.
    if (done) await revokeAllSessions(id);
  }
  await logger.info("admin", "User updated", { by: admin.email, userId: id, op });
  revalidatePath("/admin/users");
}

export async function resetPasswordAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const admin = await assertAdmin();
  const id = z.coerce.number().int().positive().parse(formData.get("userId"));
  const [u] = await db.select().from(users).where(and(eq(users.id, id), ne(users.id, admin.id))).limit(1);
  if (!u) return { error: "User not found." };
  const tempPassword = randomBytes(12).toString("base64url");
  await db.update(users).set({ passwordHash: await hashPassword(tempPassword), updatedAt: new Date() }).where(eq(users.id, id));
  await revokeAllSessions(id);
  await logger.info("admin", "Password reset", { by: admin.email, userId: id });
  return { ok: `Password reset for ${u.email}.`, tempPassword };
}

export async function changeOwnPasswordAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const me = await assertUser();
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (next !== confirm) return { error: "The new passwords do not match." };
  const weak = validatePasswordStrength(next);
  if (weak) return { error: weak };
  const [u] = await db.select().from(users).where(eq(users.id, me.id)).limit(1);
  if (!u || !(await verifyPassword(current, u.passwordHash))) return { error: "Your current password is incorrect." };
  await db.update(users).set({ passwordHash: await hashPassword(next), updatedAt: new Date() }).where(eq(users.id, me.id));
  return { ok: "Your password has been changed." };
}

export async function editUserAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const admin = await assertAdmin();
  const parsed = z
    .object({
      userId: z.coerce.number().int().positive(),
      email: z.string().trim().toLowerCase().email().max(320),
      name: z.string().transform((v) => cleanText(v, 200)).pipe(z.string().min(2)),
    })
    .safeParse({ userId: formData.get("userId"), email: formData.get("email"), name: formData.get("name") });
  if (!parsed.success) return { error: "Enter a name (at least 2 characters) and a valid email address." };
  const { userId, email, name } = parsed.data;
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return { error: "User not found." };
  const [taken] = await db.select({ id: users.id }).from(users).where(and(sql`lower(${users.email}) = ${email}`, ne(users.id, userId))).limit(1);
  if (taken) return { error: "Another user already has this email address." };
  try {
    await db.update(users).set({ name, email, updatedAt: new Date() }).where(eq(users.id, userId));
  } catch (err) {
    // Another save took the address between the check above and this write.
    if (isUniqueViolation(err)) return { error: "Another user already has this email address." };
    throw err;
  }
  await logger.info("admin", "User edited", { by: admin.email, userId, ...(u.email !== email ? { from: u.email, to: email } : {}), ...(u.name !== name ? { name } : {}) });
  revalidatePath("/admin/users");
  revalidatePath("/", "layout"); // the sidebar shows the signed-in user's name and email
  return { ok: "Saved." };
}

export async function deleteUserAction(formData: FormData) {
  const admin = await assertAdmin();
  const id = z.coerce.number().int().positive().parse(formData.get("userId"));
  // Admins can't delete themselves, so at least one administrator (the one acting) always remains.
  if (id === admin.id) return;
  const u = await keepAnAdmin(id, async (tx) => (await tx.delete(users).where(eq(users.id, id)).returning({ email: users.email }))[0]); // sessions are removed with the user
  if (u) await logger.info("admin", "User deleted", { by: admin.email, userId: id, email: u.email });
  revalidatePath("/admin/users");
}

/**
 * Replace a client's dealership assignments. Only `client` accounts carry
 * assignments — A3 staff reach the whole portfolio by role — so this refuses
 * any other role rather than writing rows that would never be read.
 */
export async function setUserDealershipsAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const admin = await assertAdmin();
  const userId = z.coerce.number().int().positive().parse(formData.get("userId"));
  const ids = z
    .array(z.coerce.number().int().positive())
    .max(500)
    .safeParse(formData.getAll("dealershipId").map(String).filter(Boolean));
  if (!ids.success) return { error: "Select one or more dealerships." };

  const [u] = await db.select({ id: users.id, email: users.email, role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return { error: "User not found." };
  if (u.role !== "client") return { error: "Only dealership accounts can be assigned to specific dealerships." };

  // Drop anything that is not a real dealership, so a tampered form cannot
  // store a dangling id that a later dealership would inherit.
  const valid = ids.data.length ? await db.select({ id: dealerships.id }).from(dealerships).where(inArray(dealerships.id, ids.data)) : [];
  const keep = valid.map((d) => d.id);

  await db.transaction(async (tx) => {
    await tx.delete(userDealerships).where(eq(userDealerships.userId, userId));
    if (keep.length) await tx.insert(userDealerships).values(keep.map((dealershipId) => ({ userId, dealershipId })));
  });
  await logger.info("admin", "Dealership access changed", { by: admin.email, userId, dealerships: keep.length });
  revalidatePath("/admin/users");
  return { ok: keep.length ? `Access saved: ${keep.length} dealership${keep.length === 1 ? "" : "s"}.` : "Access saved: no dealerships. This account can sign in but will see nothing." };
}
