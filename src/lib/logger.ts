import "server-only";
import { db } from "@/lib/db";
import { systemLogs } from "@/lib/db/schema";

type Level = "info" | "warn" | "error";

/**
 * Structured logger. Everything goes to stdout (captured by Vercel logs);
 * warnings and errors are additionally persisted to `system_logs` so the
 * System page can surface them to admins without log access.
 */
async function write(level: Level, source: string, message: string, details?: Record<string, unknown>, dealershipId?: number) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, source, message, dealershipId, ...(details ?? {}) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  if (level !== "info") {
    try {
      await db.insert(systemLogs).values({ level, source, message: message.slice(0, 2000), details: safeDetails(details), dealershipId });
    } catch (err) {
      console.error("logger: failed to persist log", err);
    }
  }
}

function safeDetails(details?: Record<string, unknown>) {
  if (!details) return undefined;
  try {
    return JSON.parse(JSON.stringify(details, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v)));
  } catch {
    return { note: "details not serialisable" };
  }
}

export const logger = {
  info: (source: string, message: string, details?: Record<string, unknown>, dealershipId?: number) => write("info", source, message, details, dealershipId),
  warn: (source: string, message: string, details?: Record<string, unknown>, dealershipId?: number) => write("warn", source, message, details, dealershipId),
  error: (source: string, message: string, details?: Record<string, unknown>, dealershipId?: number) => write("error", source, message, details, dealershipId),
};

export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // Database errors wrap the real reason (connection reset, timeout…) in `cause`; without it a log only says "Failed query".
  const cause = err.cause instanceof Error ? err.cause.message : undefined;
  return cause && !err.message.includes(cause) ? `${err.message} (cause: ${cause})` : err.message;
}
