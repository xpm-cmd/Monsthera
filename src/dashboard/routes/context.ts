import type { IncomingMessage, ServerResponse } from "node:http";
import type { MonstheraContainer } from "../../core/container.js";

/**
 * Per-request context threaded through the domain route handlers.
 *
 * Each `handle<Domain>Routes(ctx)` returns `true` when it matched the
 * request and wrote a response, or `false` to let the chain continue.
 */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pathname: string;
  container: MonstheraContainer;
}
