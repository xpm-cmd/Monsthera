import { timestamp } from "../core/types.js";
import type { Timestamp } from "../core/types.js";

/**
 * Wall-clock digits as MySQL/Dolt return them over the text protocol,
 * e.g. "2026-06-11 13:02:54.500". Every Monsthera write path stores UTC
 * digits (ISO strings from `timestamp()`), so digits coming back from a
 * DATETIME/TIMESTAMP column are reinterpreted as UTC — never host-local.
 */
const MYSQL_DATETIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)$/;

/**
 * Normalize a DATETIME/TIMESTAMP column value from the mysql2 driver into an
 * ISO-8601 UTC timestamp. The driver hands back a `Date` (binary protocol —
 * instant-correct thanks to the pool's `timezone: "Z"`) or a digit string;
 * both must surface as the same instant (w-arq1yroe).
 */
export function toIsoTimestamp(value: string | Date): Timestamp {
  if (value instanceof Date) return timestamp(value.toISOString());
  const match = value.match(MYSQL_DATETIME_RE);
  if (match) return timestamp(new Date(`${match[1]}T${match[2]}Z`).toISOString());
  return timestamp(value);
}
