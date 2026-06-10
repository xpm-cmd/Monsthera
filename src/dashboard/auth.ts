import { timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Paths that skip authentication (safe for monitoring). */
const AUTH_EXEMPT_PATHS = new Set(["/api/health", "/api/status"]);

/**
 * Methods that never require auth. Only OPTIONS — CORS preflight requests carry
 * no Authorization header by design. GET is deliberately NOT exempt: every
 * GET /api/* endpoint (knowledge, work, events, search, agents, code-intel)
 * exposes the corpus and must carry a valid Bearer token. The dashboard SPA
 * already attaches the token to every request, including GETs (see
 * public/lib/api.js).
 */
const AUTH_EXEMPT_METHODS = new Set(["OPTIONS"]);

/**
 * Check whether a request carries a valid Bearer token.
 * Returns true when:
 *  - the request method (OPTIONS) or path (health/status) is exempt, OR
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
