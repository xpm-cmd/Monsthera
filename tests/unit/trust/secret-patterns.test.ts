import { describe, it, expect } from "vitest";
import { compileSecretPatterns, scanForSecrets, redactSecrets, isSensitiveFile } from "../../../src/trust/secret-patterns.js";

describe("scanForSecrets", () => {
  it("detects API keys", () => {
    const content = 'const key = "sk_live_abcdefghijklmnopqrstuvwxyz";';
    const results = scanForSecrets(content);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.pattern).toBe("api_key");
  });

  it("detects AWS access keys", () => {
    const content = "AWS_KEY=AKIAIOSFODNN7EXAMPLE";
    const results = scanForSecrets(content);
    expect(results.some((r) => r.pattern === "aws_access_key")).toBe(true);
  });

  it("detects GitHub tokens", () => {
    const content = 'token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"';
    const results = scanForSecrets(content);
    expect(results.some((r) => r.pattern === "github_token")).toBe(true);
  });

  it("detects generic password assignments", () => {
    const content = 'password = "supersecretpassword123"';
    const results = scanForSecrets(content);
    expect(results.some((r) => r.pattern === "generic_secret")).toBe(true);
  });

  it("detects private keys", () => {
    const content = "-----BEGIN RSA PRIVATE KEY-----";
    const results = scanForSecrets(content);
    expect(results.some((r) => r.pattern === "private_key")).toBe(true);
  });

  it("detects connection strings", () => {
    const content = "DATABASE_URL=postgres://user:pass@localhost:5432/db";
    const results = scanForSecrets(content);
    expect(results.some((r) => r.pattern === "connection_string")).toBe(true);
  });

  it("returns correct line numbers", () => {
    const content = "line1\nline2\npassword = \"secret12345678\"\nline4";
    const results = scanForSecrets(content);
    expect(results[0]!.line).toBe(3);
  });

  it("returns empty for clean code", () => {
    const content = 'const x = 42;\nfunction hello() { return "world"; }';
    const results = scanForSecrets(content);
    expect(results).toHaveLength(0);
  });

  it("detects custom configured patterns", () => {
    const content = 'const token = "corp_ABC123XYZ456";';
    const patterns = compileSecretPatterns([
      { name: "corp_token", pattern: "corp_[A-Z0-9]{12}" },
    ]);
    const results = scanForSecrets(content, patterns);
    expect(results.some((r) => r.pattern === "corp_token")).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("replaces secrets with [REDACTED]", () => {
    const content = 'const key = "sk_live_abcdefghijklmnopqrstuvwxyz";';
    const redacted = redactSecrets(content);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("sk_live_abcdefghijklmnopqrstuvwxyz");
  });

  it("redacts custom configured secrets", () => {
    const content = 'const token = "corp_ABC123XYZ456";';
    const patterns = compileSecretPatterns([
      { name: "corp_token", pattern: "corp_[A-Z0-9]{12}" },
    ]);
    const redacted = redactSecrets(content, patterns);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("corp_ABC123XYZ456");
  });
});

describe("isSensitiveFile", () => {
  it("detects .env files", () => {
    expect(isSensitiveFile(".env")).toBe(true);
    expect(isSensitiveFile("path/to/.env")).toBe(true);
  });

  it("detects .env.* files", () => {
    expect(isSensitiveFile(".env.local")).toBe(true);
    expect(isSensitiveFile("config/.env.production")).toBe(true);
  });

  it("detects key files", () => {
    expect(isSensitiveFile("server.key")).toBe(true);
    expect(isSensitiveFile("path/to/cert.pem")).toBe(true);
  });

  it("detects credentials files", () => {
    expect(isSensitiveFile("credentials.json")).toBe(true);
    expect(isSensitiveFile("secrets.yaml")).toBe(true);
  });

  it("does not flag regular files", () => {
    expect(isSensitiveFile("src/index.ts")).toBe(false);
    expect(isSensitiveFile("README.md")).toBe(false);
    expect(isSensitiveFile("package.json")).toBe(false);
  });
});
