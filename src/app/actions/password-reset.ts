"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { completePasswordReset, requestPasswordReset } from "@/lib/auth/password-reset";
import { logger } from "@/lib/logger";
import { checkRateLimit, clientIp } from "@/lib/security/rate-limit";

export type ForgotState = { sent?: boolean; error?: string; email?: string } | undefined;

export async function requestPasswordResetAction(_prev: ForgotState, formData: FormData): Promise<ForgotState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase().slice(0, 320);
  const parsed = z.string().email().safeParse(email);
  if (!parsed.success) return { error: "Enter the email address you sign in with.", email };

  const ip = clientIp(await headers());
  const [ipLimit, emailLimit] = await Promise.all([
    checkRateLimit({ key: `reset:ip:${ip}`, limit: 10, windowSeconds: 3600 }),
    checkRateLimit({ key: `reset:email:${email}`, limit: 3, windowSeconds: 3600 }),
  ]);
  if (!ipLimit.allowed || !emailLimit.allowed) {
    await logger.warn("auth", "Password reset rate limit hit", { ip, email });
    // Same wording as success: a blocked attempt must not reveal whether the address exists.
    return { sent: true, email };
  }

  await requestPasswordReset(email, ip);
  return { sent: true, email };
}

export type ResetState = { ok?: boolean; error?: string } | undefined;

export async function completePasswordResetAction(_prev: ResetState, formData: FormData): Promise<ResetState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (!token) return { error: "This link is not valid. Request a new one." };
  if (password !== confirm) return { error: "The two passwords do not match." };

  const ip = clientIp(await headers());
  const limit = await checkRateLimit({ key: `reset-complete:ip:${ip}`, limit: 20, windowSeconds: 3600 });
  if (!limit.allowed) return { error: "Too many attempts. Please wait an hour and try again." };

  const result = await completePasswordReset(token, password);
  return result.ok ? { ok: true } : { error: result.error };
}
