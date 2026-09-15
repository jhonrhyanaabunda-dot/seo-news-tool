import "server-only";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { env } from "@/lib/env";
import { emailConfigProblem, friendlyResendError, friendlySmtpError, isRetryableResendError, normalizeSmtpPassword } from "./config";

const RESEND_MIN_SPACING_MS = 250;
const RESEND_MAX_ATTEMPTS = 3;
let lastResendAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Email delivery behind one interface so the provider can be swapped via
 * EMAIL_PROVIDER without touching report code.
 *   resend   HTTPS API — recommended on Vercel (no SMTP sockets needed)
 *   smtp     any SMTP relay (Google Workspace, SES, Postmark, Mailgun…)
 *   console  development only: logs the message instead of sending
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Same key → the provider sends at most once (Resend honours it for 24 hours), even if a retry follows a lost response. */
  idempotencyKey?: string;
}

export interface EmailProvider {
  name: string;
  send(message: EmailMessage): Promise<{ id: string | null }>;
}

class ResendProvider implements EmailProvider {
  name = "resend";
  private client: Resend;
  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }
  async send(m: EmailMessage) {
    for (let attempt = 1; ; attempt++) {
      // Digests and alerts go out one recipient after another; keep under Resend's per-second request limit.
      const wait = lastResendAt + RESEND_MIN_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastResendAt = Date.now();
      const { data, error } = await this.client.emails.send(
        { from: env().EMAIL_FROM, to: [m.to], subject: m.subject, html: m.html, text: m.text },
        m.idempotencyKey ? { idempotencyKey: m.idempotencyKey } : undefined,
      );
      if (!error) return { id: data?.id ?? null };
      if (attempt < RESEND_MAX_ATTEMPTS && isRetryableResendError(error.name, error.statusCode)) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(friendlyResendError(error.name, error.message, error.statusCode));
    }
  }
}

class SmtpProvider implements EmailProvider {
  name = "smtp";
  private transport = nodemailer.createTransport({
    host: env().SMTP_HOST,
    port: env().SMTP_PORT,
    secure: env().SMTP_SECURE,
    auth: env().SMTP_USER ? { user: env().SMTP_USER, pass: normalizeSmtpPassword(env().SMTP_HOST, env().SMTP_PASS) } : undefined,
    // One authenticated connection reused for a digest's recipients, instead of logging in for every email.
    pool: true,
    maxConnections: 1,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  async send(m: EmailMessage) {
    try {
      const info = await this.transport.sendMail({ from: env().EMAIL_FROM, to: m.to, subject: m.subject, html: m.html, text: m.text });
      return { id: info.messageId ?? null };
    } catch (err) {
      throw new Error(friendlySmtpError(err as { code?: string; responseCode?: number; message?: string }, env().SMTP_HOST));
    }
  }
}

class ConsoleProvider implements EmailProvider {
  name = "console";
  async send(m: EmailMessage) {
    console.log(`\n──── EMAIL (console provider) ────\nTo: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n──────────────────────────────────\n`);
    return { id: `console-${Date.now()}` };
  }
}

let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;
  const e = env();
  if (e.EMAIL_PROVIDER === "resend" || e.EMAIL_PROVIDER === "smtp") {
    // Fail with the fix spelled out (e.g. placeholder sender) instead of a provider's generic rejection.
    const problem = emailConfigProblem(e);
    if (problem) throw new Error(problem);
    cached = e.EMAIL_PROVIDER === "resend" ? new ResendProvider(e.RESEND_API_KEY!) : new SmtpProvider();
  } else {
    if (e.NODE_ENV === "production") console.warn("EMAIL_PROVIDER=console in production: emails are logged, not delivered.");
    cached = new ConsoleProvider();
  }
  return cached;
}
