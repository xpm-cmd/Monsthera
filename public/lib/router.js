// ─── Client-side router (History API) ───────────────────────────────────────

class Router {
  constructor() {
    this.routes = [];
    this.notFound = null;
  }

  add(pattern, handler) {
    // Convert "/knowledge/:id" → regex with named groups
    const paramNames = [];
    const regexStr = pattern.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    this.routes.push({
      regex: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
    });
    return this;
  }

  onNotFound(handler) {
    this.notFound = handler;
    return this;
  }

  resolve(pathname) {
    // Normalize trailing slashes for matching (but preserve root "/")
    const normalized = pathname.replace(/\/$/, "") || "/";
    for (const route of this.routes) {
      const match = normalized.match(route.regex);
      if (match) {
        const params = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
        return { handler: route.handler, params };
      }
    }
    return null;
  }

  async handleRoute() {
    const pathname = window.location.pathname;
    const result = this.resolve(pathname);
    if (result) {
      await result.handler(result.params);
    } else if (this.notFound) {
      await this.notFound();
    }
  }

  navigate(path) {
    if (path === window.location.pathname) return;
    window.history.pushState(null, "", path);
    this.handleRoute();
  }

  start() {
    window.addEventListener("popstate", () => this.handleRoute());
    this.handleRoute();
  }
}

export const router = new Router();

export function navigate(path) {
  router.navigate(path);
}
