import { timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Paths that skip authentication (safe for monitoring). */
const AUTH_EXEMPT_PATHS = new Set(["/api/health", "/api/status"]);

/** Methods that never require auth. */
const AUTH_EXEMPT_METHODS = new Set(["GET", "OPTIONS"]);

/**
 * Check whether a request carries a valid Bearer token.
 * Returns true when:
 *  - the request method or path is exempt, OR
 *  - the Authorization header contains a valid Bearer token.
 */
export function requireAuth(
  req: IncomingMessage,
  token: string,
  pathname: string,
): boolean {
  if (AUTH_EXEMPT_METHODS.has(req.method ?? "GET")) return true;
  if (AUTH_EXEMPT_PATHS.has(pathname)) return true;

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;

  const provided = header.slice(7); // strip "Bearer "
  if (provided.length !== token.length) return false;

  return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

/**
 * Generate a cryptographically random dashboard token.
 */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}
