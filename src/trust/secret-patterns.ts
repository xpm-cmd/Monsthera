import type { SecretPatternRule } from "../core/config.js";

export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

export const DEFAULT_SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "api_key",
    pattern: /(sk|pk|api[_-]?key)[_-]?[a-zA-Z0-9_]{20,}/gi,
  },
  {
    name: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
  },
  {
    name: "github_token",
    pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g,
  },
  {
    name: "generic_secret",
    pattern: /(password|secret|token)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
  },
  {
    name: "private_key",
    pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/g,
  },
  {
    name: "connection_string",
    pattern: /(mongodb|postgres|mysql|redis):\/\/[^\s]+/gi,
  },
];

export const DEFAULT_SENSITIVE_FILE_PATTERNS = [
  ".env",
  ".env.*",
  "*.key",
  "*.pem",
  "*.p12",
  "*.pfx",
  "credentials.*",
  "secrets.*",
  "*secret*",
  "*.keystore",
];

export function compileSecretPatterns(
  customRules: SecretPatternRule[] = [],
): SecretPattern[] {
  const defaults = DEFAULT_SECRET_PATTERNS.map(({ name, pattern }) => ({
    name,
    pattern: new RegExp(pattern.source, pattern.flags),
  }));

  const compiledCustom = customRules.map((rule) => ({
    name: rule.name,
    pattern: new RegExp(rule.pattern, normalizeFlags(rule.flags)),
  }));

  return [...defaults, ...compiledCustom];
}

export function scanForSecrets(
  content: string,
  patterns: SecretPattern[] = DEFAULT_SECRET_PATTERNS,
): Array<{ pattern: string; line: number }> {
  const results: Array<{ pattern: string; line: number }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    for (const { name, pattern } of patterns) {
      // Reset lastIndex for global regexps
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        results.push({ pattern: name, line: i + 1 });
        pattern.lastIndex = 0; // reset after test
      }
    }
  }

  return results;
}

export function redactSecrets(
  content: string,
  patterns: SecretPattern[] = DEFAULT_SECRET_PATTERNS,
): string {
  let result = content;
  for (const { pattern } of patterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
    pattern.lastIndex = 0;
  }
  return result;
}

export function isSensitiveFile(filePath: string, patterns: string[] = DEFAULT_SENSITIVE_FILE_PATTERNS): boolean {
  const fileName = filePath.split("/").pop() ?? "";
  return patterns.some((pattern) => {
    if (pattern.startsWith("*") && pattern.endsWith("*")) {
      return fileName.includes(pattern.slice(1, -1));
    }
    if (pattern.startsWith("*.")) {
      return fileName.endsWith(pattern.slice(1));
    }
    if (pattern.endsWith(".*")) {
      return fileName.startsWith(pattern.slice(0, -2) + ".");
    }
    return fileName === pattern || filePath.endsWith("/" + pattern);
  });
}

function normalizeFlags(flags?: string): string {
  const unique = new Set((flags ?? "").split("").filter(Boolean));
  unique.add("g");
  return [...unique].join("");
}
