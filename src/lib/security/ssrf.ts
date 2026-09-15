import "server-only";
import { isIP } from "node:net";
import dns from "node:dns/promises";

/**
 * Server-Side Request Forgery protection for every outbound URL the system
 * fetches (dealership sites, sitemaps, RSS feeds, link checks).
 *
 *  - Only http/https.
 *  - Only ports 80/443 (and the scheme default).
 *  - Hostnames must resolve to public unicast addresses. Loopback, link-local,
 *    private (RFC1918), CGNAT, multicast, metadata (169.254.169.254) and IPv6
 *    equivalents are rejected.
 *  - Redirects are re-validated hop by hop by the fetcher (see seo/fetcher.ts).
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "instance-data"]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function inCidr4(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

const PRIVATE_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
];

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return PRIVATE_V4.some((c) => inCidr4(ip, c));
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice(7);
      return isIP(v4) === 4 ? isPrivateIp(v4) : true;
    }
    if (/^fe[89ab]/.test(lower)) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("ff")) return true; // multicast
    if (lower.startsWith("2001:db8")) return true; // documentation
    if (lower.startsWith("64:ff9b")) return true; // NAT64 — could map to private v4
    return false;
  }
  return true;
}

/** Synchronous structural validation (no DNS). Throws UnsafeUrlError. */
export function assertUrlShape(input: string | URL): URL {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("Only http and https URLs are allowed");
  if (url.username || url.password) throw new UnsafeUrlError("Credentials in URLs are not allowed");
  if (url.port && url.port !== "80" && url.port !== "443") throw new UnsafeUrlError("Only ports 80 and 443 are allowed");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || BLOCKED_HOSTNAMES.has(host)) throw new UnsafeUrlError("Host is not allowed");
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    if (isPrivateIp(bare)) throw new UnsafeUrlError("IP address is not public");
    return url;
  }
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost") || !host.includes("."))
    throw new UnsafeUrlError("Host is not a public domain");
  return url;
}

const dnsCache = new Map<string, { ips: string[]; expires: number }>();

/**
 * Full validation including DNS resolution. Returns the resolved public
 * addresses so the caller can log or pin them.
 */
export async function assertSafeUrl(input: string | URL): Promise<{ url: URL; addresses: string[] }> {
  const url = assertUrlShape(input);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) return { url, addresses: [host] };

  const cached = dnsCache.get(host);
  if (cached && cached.expires > Date.now()) return { url, addresses: cached.ips };

  let addresses: string[] = [];
  try {
    const results = await dns.lookup(host, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new UnsafeUrlError("Hostname could not be resolved");
  }
  if (addresses.length === 0) throw new UnsafeUrlError("Hostname could not be resolved");
  for (const ip of addresses) {
    if (isPrivateIp(ip)) throw new UnsafeUrlError("Host resolves to a non-public address");
  }
  dnsCache.set(host, { ips: addresses, expires: Date.now() + 5 * 60_000 });
  return { url, addresses };
}
