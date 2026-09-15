"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { assertAdmin, assertUser } from "@/lib/auth/guards";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/lib/auth/password";
import { revokeAllSessions } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { cleanText } from "@/lib/security/sanitize";

export type UserFormState = { error?: string; ok?: string; tempPassword?: string } | undefined;

export async function createUserAction(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const admin = await assertAdmin();
  const parsed = z
    .object({
      email: z.string().trim().toLowerCase().email().max(320),
      name: z.string().transform((v) => cleanText(v, 200)).pipe(z.string().min(2)),
      role: z.enum(["admin", "viewer"]),
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
  if (op === "make-admin" || op === "make-viewer") {
    await db.update(users).set({ role: op === "make-admin" ? "admin" : "viewer", updatedAt: new Date() }).where(eq(users.id, id));
  } else if (op === "deactivate" || op === "activate") {
    await db.update(users).set({ isActive: op === "activate", updatedAt: new Date() }).where(eq(users.id, id));
    if (op === "deactivate") await revokeAllSessions(id);
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
