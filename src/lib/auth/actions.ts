"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { checkRateLimit, clientIp } from "@/lib/security/rate-limit";
import { verifyPassword } from "./password";
import { createSession, destroySession } from "./session";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
  next: z.string().optional(),
});

export type LoginState = { error?: string; email?: string } | undefined;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  const typedEmail = String(formData.get("email") ?? "").slice(0, 320);
  if (!parsed.success) return { error: "Please enter a valid email address and password.", email: typedEmail };

  const h = await headers();
  const ip = clientIp(h);
  const { email, password } = parsed.data;

  const [ipLimit, emailLimit] = await Promise.all([
    checkRateLimit({ key: `login:ip:${ip}`, limit: 20, windowSeconds: 900 }),
    checkRateLimit({ key: `login:email:${email}`, limit: 8, windowSeconds: 900 }),
  ]);
  if (!ipLimit.allowed || !emailLimit.allowed) {
    await logger.warn("auth", "Login rate limit hit", { ip, email });
    return { error: "Too many sign-in attempts. Please wait 15 minutes and try again.", email: typedEmail };
  }

  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  // Always run a compare to keep timing similar for unknown users.
  const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid");
  if (!user || !ok || !user.isActive) {
    return { error: "Incorrect email or password.", email: typedEmail };
  }

  await createSession(user.id, { userAgent: h.get("user-agent"), ip });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  const next = parsed.data.next && parsed.data.next.startsWith("/") && !parsed.data.next.startsWith("//") ? parsed.data.next : "/";
  redirect(next);
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
