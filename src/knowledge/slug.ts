import { slug as brandSlug } from "../core/types.js";
import type { Slug } from "../core/types.js";

/** Convert a title to a URL-safe kebab-case slug */
export function toSlug(title: string): Slug {
  let result = title
    .toLowerCase()
    .replace(/[\s_]+/g, "-")    // spaces and underscores → hyphens
    .replace(/[^a-z0-9-]/g, "") // remove non-alphanumeric except hyphens
    .replace(/-{2,}/g, "-")     // collapse consecutive hyphens
    .replace(/^-+|-+$/g, "");   // trim leading/trailing hyphens

  if (result.length === 0) {
    result = "untitled";
  }

  return brandSlug(result);
}

/** Generate a unique slug by appending a numeric suffix if needed */
export function uniqueSlug(title: string, existingSlugs: ReadonlySet<string>): Slug {
  const base = toSlug(title);
  if (!existingSlugs.has(base)) return base;

  let counter = 2;
  while (existingSlugs.has(`${base}-${counter}`)) {
    counter++;
  }
  return brandSlug(`${base}-${counter}`);
}
