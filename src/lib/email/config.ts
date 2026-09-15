/**
 * Email configuration checks and error wording. Pure (no env(), no network) so
 * they can be tested and shown on the Settings page before anything is sent.
 */

export interface EmailConfig {
  EMAIL_PROVIDER: "resend" | "smtp" | "console";
  EMAIL_FROM: string;
  RESEND_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_SECURE?: boolean;
  SMTP_USER?: string;
  SMTP_PASS?: string;
}

/** Gmail and Google Workspace accounts send through smtp.gmail.com with an App Password. */
export function isGmailSmtp(c: Pick<EmailConfig, "SMTP_HOST">): boolean {
  return /^smtp\.gmail\.com$/i.test(c.SMTP_HOST?.trim() ?? "");
}

/** Google shows App Passwords in groups of four ("abcd efgh ijkl mnop"); the spaces are not part of it. */
export function normalizeSmtpPassword(host: string | undefined, pass: string | undefined): string | undefined {
  if (pass === undefined) return undefined;
  return isGmailSmtp({ SMTP_HOST: host }) ? pass.replace(/\s+/g, "") : pass;
}

/** The address part of `Name <address>` or a bare address. */
export function fromAddress(from: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from.trim()) ?? /^([^<>\s]+@[^<>\s]+)$/.exec(from.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Resend's shared test sender: works without a verified domain, but only delivers to the Resend account owner's own address. */
export const RESEND_TEST_SENDER = "onboarding@resend.dev";

const PLACEHOLDER_DOMAINS = /@(example\.(com|org|net)|localhost|test|invalid)$/i;

/** Why real email cannot be delivered with this configuration, or null when it looks deliverable. */
export function emailConfigProblem(c: EmailConfig): string | null {
  if (c.EMAIL_PROVIDER === "console") return "Email is in development mode (EMAIL_PROVIDER=console): messages are written to the server log, not delivered.";
  const address = fromAddress(c.EMAIL_FROM);
  if (!address) return `EMAIL_FROM is not a valid sender ("${c.EMAIL_FROM}"). Use the form: A3 SEO Monitor <reports@yourdomain.com>.`;
  if (PLACEHOLDER_DOMAINS.test(address)) return `EMAIL_FROM uses a placeholder address (${address}). Set it to an address on your verified sending domain.`;
  if (c.EMAIL_PROVIDER === "resend") {
    if (!c.RESEND_API_KEY) return "EMAIL_PROVIDER=resend but RESEND_API_KEY is not set.";
    if (!c.RESEND_API_KEY.startsWith("re_")) return "RESEND_API_KEY does not look like a Resend API key (they start with re_).";
  }
  if (c.EMAIL_PROVIDER === "smtp") {
    if (!c.SMTP_HOST) return "EMAIL_PROVIDER=smtp but SMTP_HOST is not set.";
    if (c.SMTP_PORT === 465 && c.SMTP_SECURE === false) return "SMTP_PORT=465 needs SMTP_SECURE=true.";
    if (c.SMTP_PORT === 587 && c.SMTP_SECURE === true) return "SMTP_PORT=587 needs SMTP_SECURE=false (the connection is upgraded to TLS automatically).";
    if (isGmailSmtp(c)) {
      if (!c.SMTP_USER) return "SMTP_USER is not set: use the full Gmail address that sends the emails.";
      if (!c.SMTP_PASS) return "SMTP_PASS is not set: create a Google App Password (Google Account → Security → App passwords) and use it here.";
      const pass = normalizeSmtpPassword(c.SMTP_HOST, c.SMTP_PASS)!;
      if (pass.length !== 16) return "SMTP_PASS does not look like a Google App Password (16 letters). Your normal Gmail password will not work.";
      if (address !== c.SMTP_USER.trim().toLowerCase()) return `EMAIL_FROM (${address}) must be the same Gmail address as SMTP_USER (${c.SMTP_USER}); Gmail replaces any other sender address.`;
    }
  }
  return null;
}

/** A note to show alongside a working configuration, e.g. test-sender limits. */
export function emailConfigNote(c: EmailConfig): string | null {
  if (c.EMAIL_PROVIDER === "resend" && fromAddress(c.EMAIL_FROM) === RESEND_TEST_SENDER) {
    return `Sending from Resend's test address (${RESEND_TEST_SENDER}): emails are only delivered to the email address that owns the Resend account. Verify your domain in Resend and change EMAIL_FROM to send to anyone else.`;
  }
  return null;
}

/** Resend error codes that mean "try again shortly" rather than "this will never work". */
export function isRetryableResendError(name: string | undefined, statusCode: number | null | undefined): boolean {
  return name === "rate_limit_exceeded" || name === "concurrent_idempotent_requests" || statusCode === 429 || (statusCode !== null && statusCode !== undefined && statusCode >= 500);
}

/** Resend's error, explained in terms of what to change. */
export function friendlyResendError(name: string | undefined, message: string, statusCode?: number | null): string {
  // Resend reports a bad key as a 401 "validation_error", so the status and wording matter more than the name.
  if (statusCode === 401 || /api key/i.test(message)) name = name === "restricted_api_key" ? name : "invalid_api_key";
  switch (name) {
    case "missing_api_key":
    case "invalid_api_key":
      return `Resend rejected the API key (${message}). Create a new key in Resend → API Keys and set RESEND_API_KEY.`;
    case "restricted_api_key":
      return `The Resend API key is not allowed to send emails (${message}). Create a key with "Sending access".`;
    case "invalid_from_address":
      return `Resend rejected the sender address in EMAIL_FROM (${message}).`;
    case "validation_error":
      return /domain|verify/i.test(message)
        ? `The sending domain is not verified in Resend (${message}). Add the DNS records shown in Resend → Domains, wait for "Verified", then send again.`
        : /testing emails|own email/i.test(message)
          ? `Resend's test sender can only deliver to the Resend account owner's address (${message}). Verify your domain to email anyone else.`
          : `Resend rejected the email: ${message}`;
    case "daily_quota_exceeded":
    case "monthly_quota_exceeded":
      return `The Resend plan's sending quota is used up (${message}).`;
    case "rate_limit_exceeded":
      return `Resend's rate limit was still exceeded after retrying (${message}).`;
    default:
      return `Resend error: ${message}`;
  }
}

/** An SMTP failure (nodemailer error), explained in terms of what to change. */
export function friendlySmtpError(err: { code?: string; responseCode?: number; message?: string }, host: string | undefined): string {
  const message = err.message ?? "unknown error";
  const gmail = isGmailSmtp({ SMTP_HOST: host });
  if (err.code === "EAUTH" || err.responseCode === 535 || err.responseCode === 534) {
    return gmail
      ? `Gmail did not accept the login (${message}). SMTP_PASS must be a Google App Password for the SMTP_USER account (2-Step Verification must be on), not the normal Gmail password.`
      : `The mail server did not accept SMTP_USER/SMTP_PASS (${message}).`;
  }
  if (err.code === "ETIMEDOUT" || err.code === "ECONNECTION" || err.code === "ESOCKET" || err.code === "EDNS") {
    return `Could not connect to ${host ?? "the mail server"} (${message}). Check SMTP_HOST, SMTP_PORT and SMTP_SECURE${gmail ? " (Gmail: port 465 with SMTP_SECURE=true)" : ""}.`;
  }
  if (err.responseCode === 550 || err.responseCode === 553) return `The mail server refused the recipient or sender (${message}).`;
  if (gmail && (err.responseCode === 421 || err.responseCode === 454 || /limit/i.test(message))) {
    return `Gmail's sending limit was reached (${message}). Gmail allows about 500 recipients a day; try again later.`;
  }
  return `Email could not be sent: ${message}`;
}
