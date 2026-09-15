import { test } from "node:test";
import assert from "node:assert/strict";
import { emailConfigNote, emailConfigProblem, friendlyResendError, fromAddress, isRetryableResendError } from "@/lib/email/config";

const resend = { EMAIL_PROVIDER: "resend" as const, EMAIL_FROM: "A3 SEO Monitor <reports@a3brands.com>", RESEND_API_KEY: "re_123456789" };

test("a complete Resend configuration is deliverable", () => {
  assert.equal(emailConfigProblem(resend), null);
  assert.equal(emailConfigNote(resend), null);
});

test("configurations that cannot deliver say what to fix", () => {
  assert.match(emailConfigProblem({ ...resend, EMAIL_PROVIDER: "console" })!, /development mode/);
  assert.match(emailConfigProblem({ ...resend, RESEND_API_KEY: undefined })!, /RESEND_API_KEY is not set/);
  assert.match(emailConfigProblem({ ...resend, RESEND_API_KEY: "sk_live_abc" })!, /start with re_/);
  assert.match(emailConfigProblem({ ...resend, EMAIL_FROM: "A3 SEO Monitor <seo-monitor@example.com>" })!, /placeholder/);
  assert.match(emailConfigProblem({ ...resend, EMAIL_FROM: "A3 SEO Monitor <seo-monitor@localhost>" })!, /placeholder/);
  assert.match(emailConfigProblem({ ...resend, EMAIL_FROM: "not an address" })!, /not a valid sender/);
  assert.match(emailConfigProblem({ EMAIL_PROVIDER: "smtp", EMAIL_FROM: "reports@a3brands.com" })!, /SMTP_HOST/);
});

test("Resend's test sender works but is flagged as owner-only", () => {
  const cfg = { ...resend, EMAIL_FROM: "A3 SEO Monitor <onboarding@resend.dev>" };
  assert.equal(emailConfigProblem(cfg), null);
  assert.match(emailConfigNote(cfg)!, /only delivered to the email address that owns the Resend account/);
});

test("sender addresses are read from either form", () => {
  assert.equal(fromAddress("A3 SEO Monitor <Reports@A3Brands.com>"), "reports@a3brands.com");
  assert.equal(fromAddress("reports@a3brands.com"), "reports@a3brands.com");
  assert.equal(fromAddress("A3 SEO Monitor"), null);
});

test("rate limits and server errors are retried; configuration errors are not", () => {
  assert.equal(isRetryableResendError("rate_limit_exceeded", 429), true);
  assert.equal(isRetryableResendError("internal_server_error", 500), true);
  assert.equal(isRetryableResendError("validation_error", 403), false);
  assert.equal(isRetryableResendError("invalid_api_key", 403), false);
});

test("Resend errors are explained in terms of what to change", () => {
  assert.match(friendlyResendError("validation_error", "The a3brands.com domain is not verified."), /Resend → Domains/);
  assert.match(friendlyResendError("validation_error", "You can only send testing emails to your own email address"), /account owner/);
  assert.match(friendlyResendError("invalid_api_key", "API key is invalid"), /RESEND_API_KEY/);
  assert.match(friendlyResendError("validation_error", "API key is invalid", 401), /RESEND_API_KEY/, "Resend reports a bad key as a 401 validation_error");
});

const gmail = { EMAIL_PROVIDER: "smtp" as const, EMAIL_FROM: "A3 SEO Monitor <a3brandsllc@gmail.com>", SMTP_HOST: "smtp.gmail.com", SMTP_PORT: 465, SMTP_SECURE: true, SMTP_USER: "a3brandsllc@gmail.com", SMTP_PASS: "abcd efgh ijkl mnop" };

test("a Gmail App Password setup is deliverable, spaces in the password included", async () => {
  const { normalizeSmtpPassword } = await import("@/lib/email/config");
  assert.equal(emailConfigProblem(gmail), null);
  assert.equal(normalizeSmtpPassword(gmail.SMTP_HOST, gmail.SMTP_PASS), "abcdefghijklmnop");
  assert.equal(normalizeSmtpPassword("smtp.example.com", "pass word"), "pass word", "other servers keep the password as typed");
});

test("Gmail setups that cannot deliver say what to fix", () => {
  assert.match(emailConfigProblem({ ...gmail, SMTP_PASS: undefined })!, /App Password/);
  assert.match(emailConfigProblem({ ...gmail, SMTP_PASS: "MyNormalPassword!" })!, /normal Gmail password will not work/);
  assert.match(emailConfigProblem({ ...gmail, SMTP_USER: undefined })!, /SMTP_USER/);
  assert.match(emailConfigProblem({ ...gmail, EMAIL_FROM: "A3 SEO Monitor <reports@a3brands.com>" })!, /must be the same Gmail address/);
  assert.match(emailConfigProblem({ ...gmail, SMTP_SECURE: false })!, /465 needs SMTP_SECURE=true/);
});

test("SMTP failures are explained", async () => {
  const { friendlySmtpError } = await import("@/lib/email/config");
  assert.match(friendlySmtpError({ code: "EAUTH", responseCode: 535, message: "Username and Password not accepted" }, "smtp.gmail.com"), /Google App Password/);
  assert.match(friendlySmtpError({ code: "ETIMEDOUT", message: "Connection timeout" }, "smtp.gmail.com"), /port 465/);
});
