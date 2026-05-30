/**
 * Pure extractors that scan a rendered handoff markdown body for
 * code references and article references, used to populate the
 * `codeRefs[]` and `references[]` frontmatter fields of the
 * persisted knowledge article.
 *
 * Both extractors are deliberately conservative — they look for shapes
 * the renderer is known to emit (backticked file paths, `path:` /
 * `work:` / `knowledge:` evidence citations, `handoff-<id>.md`
 * cross-links) and ignore everything else. Calling code can rely on
 * the output being a deduplicated list of strings.
 *
 * Extracted to its own module from `service.ts` so each extractor can
 * be unit-tested in isolation. The round-6 regression that motivated
 * the extraction: `collectCodeRefs`'s original regex matched the
 * entire content of backticked `pnpm test tests/foo.test.ts`, capturing
 * the command + path as a single "file" entry because `[^`]+` allowed
 * whitespace inside the backticks. The fixed regex requires path-shaped
 * content without spaces.
 *
 * The dogfood pass added a second guard (`isTransientOrArtifactRef`): even
 * path-shaped, space-free tokens are rejected when they name transient
 * scratch files (`/tmp/...`) or the sessions subsystem's own generated
 * artifacts (`facts.json`, `<id>.facts.json`, `handoff-ses-<id>.md`), which
 * never resolve to a tracked file and so would surface as stale code refs.
 */

const CODE_EXTENSIONS = "ts|tsx|js|jsx|mjs|cjs|py|rs|go|md|sh|sql|json|yml|yaml|toml";

/**
 * Backticked file-path matcher. Both the legal forms `` `src/foo.ts` ``
 * and `` `src/foo.ts:42` `` are supported. The leading character must be
 * a letter, underscore, or dot (so `./foo.ts` and `../foo.ts` work);
 * subsequent characters are word-chars, dots, slashes, or hyphens.
 * Crucially, NO whitespace is allowed inside the backticks — this is
 * what prevents `` `pnpm test src/foo.ts` `` from being captured as a
 * "file path" of `pnpm test src/foo.ts`.
 */
const BACKTICKED_PATH = new RegExp(
  // opening backtick, path-shape, extension, optional :line, closing backtick
  "`(\\.{0,2}/?[a-zA-Z_][\\w./\\-]*\\.(?:" + CODE_EXTENSIONS + ")(?::\\d+)?)`",
  "g",
);

/** `path:<file>` or `path:<file>:<line>` citation form. */
const PATH_CITATION = /path:([^\],\s]+)/g;

/**
 * Strip the structural `## Facts` section from a body before scanning.
 * Every non-degraded handoff carries a backticked `<id>.facts.json`
 * filename in that section — a navigation artifact, not substantive
 * content. Including it in scope makes the extractor surface the
 * Facts pointer as a "real" code reference on every handoff, which
 * is noise. Mirrors the coverage validator's same-shaped strip
 * (see `src/sessions/coverage-validator.ts` round-4 fix).
 */
// Match `## Facts` only when it begins a line (multiline). A naive
// `indexOf` matches the string even when it appears in prose (e.g.
// "...structural sections (like `## Facts`)...") and chops off
// substantive content. The anchor + multiline flag fixes that.
const FACTS_SECTION_START = /^## Facts/m;

function stripStructuralSections(body: string): string {
  const factsIdx = body.search(FACTS_SECTION_START);
  return factsIdx >= 0 ? body.slice(0, factsIdx) : body;
}

/**
 * Defensive filter — even when the body-side regex looks tight, real
 * LLM output can produce surprises (nested backticks, paren-tick-paren
 * sequences, frontmatter contamination during multi-pass renders). A
 * codeRef ENTRY (after extraction) must independently match the
 * path-shape contract or it is rejected. This is the load-bearing
 * guard against malformed entries leaking into `codeRefs[]`
 * frontmatter that downstream tooling has to parse.
 */
const PATH_SHAPE_FULL = new RegExp(
  "^(?:path:)?\\.{0,2}/?[a-zA-Z_][\\w./\\-]*\\.(?:" + CODE_EXTENSIONS + ")(?::\\d+)?$",
);

function isPathShaped(ref: string): boolean {
  return PATH_SHAPE_FULL.test(ref);
}

/**
 * Transient or generated paths that ARE path-shaped (so they survive
 * `isPathShaped`) but must never be persisted as `codeRefs[]`, because they
 * do not resolve to a tracked file — persisting them guarantees a "stale
 * code ref" finding on the next `doctor` run. Observed live in the dogfood
 * pass: 6 such refs across 3 handoff notes.
 *
 *   - scratch paths under /tmp, /var, /private (dry-run artifacts)
 *   - the session's own facts sidecar: `facts.json` / `<id>.facts.json`
 *     (lives under knowledge/sessions/, never at the cited bare path)
 *   - sibling handoff notes: `handoff-ses-<id>.md` — these are cross-links
 *     that belong in `references[]` (collectArticleReferences already picks
 *     them up from the markdown-link form), not in codeRefs[]
 *   - any other session-id-prefixed artifact: `ses-<ts>-…`
 *
 * Rejecting by shape is safer than a blanket "bare filename" rule, which
 * would also drop legitimate root files like `package.json` / `README.md`.
 */
const TRANSIENT_PATH_PREFIXES = ["/tmp/", "/var/", "/private/"] as const;
const ARTIFACT_BASENAME_PATTERNS: readonly RegExp[] = [
  /^facts\.json$/,
  /\.facts\.json$/,
  /^handoff-ses-/,
  /^ses-\d/,
];

function isTransientOrArtifactRef(ref: string): boolean {
  for (const prefix of TRANSIENT_PATH_PREFIXES) {
    if (ref.startsWith(prefix)) return true;
  }
  const lastSlash = ref.lastIndexOf("/");
  const basename = lastSlash === -1 ? ref : ref.slice(lastSlash + 1);
  return ARTIFACT_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

/**
 * Extract code references from a rendered handoff body. Returns a
 * deduplicated, insertion-ordered list. The returned strings are the
 * inner content of the match (without surrounding backticks or
 * `path:` prefix), suitable for direct insertion into the article's
 * `codeRefs[]` frontmatter.
 *
 * Strips the `## Facts` section before scanning (its backticked
 * `.facts.json` filename is structural noise) and applies a
 * defensive shape-filter to every extracted entry.
 */
export function collectCodeRefs(body: string): string[] {
  const scoped = stripStructuralSections(body);
  const refs = new Set<string>();
  for (const match of scoped.matchAll(BACKTICKED_PATH)) {
    if (match[1] && isPathShaped(match[1]) && !isTransientOrArtifactRef(match[1])) refs.add(match[1]);
  }
  for (const match of scoped.matchAll(PATH_CITATION)) {
    if (match[1] && isPathShaped(match[1]) && !isTransientOrArtifactRef(match[1])) refs.add(match[1]);
  }
  return [...refs];
}

/** `work:<id>` citation form. */
const WORK_CITATION = /work:([a-z0-9-]+)/g;
/** `knowledge:<slug>` citation form. */
const KNOWLEDGE_CITATION = /knowledge:([a-z0-9-]+)/g;
/** Markdown link to a sibling handoff article. */
const HANDOFF_LINK = /handoff-(ses-[a-z0-9-]+)\.md/g;

/**
 * Extract article references from a rendered handoff body for graph
 * navigation. Picks up `work:`, `knowledge:`, and inter-handoff
 * markdown links. Deduplicated, insertion-ordered.
 */
export function collectArticleReferences(body: string): string[] {
  const refs = new Set<string>();
  for (const match of body.matchAll(WORK_CITATION)) {
    if (match[1]) refs.add(match[1]);
  }
  for (const match of body.matchAll(KNOWLEDGE_CITATION)) {
    if (match[1]) refs.add(match[1]);
  }
  for (const match of body.matchAll(HANDOFF_LINK)) {
    if (match[1]) refs.add(`handoff-${match[1]}`);
  }
  return [...refs];
}
