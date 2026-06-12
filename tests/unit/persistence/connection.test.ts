import { describe, it, expect, vi, beforeEach } from "vitest";
import mysql from "mysql2/promise";
import { createDoltPool } from "../../../src/persistence/connection.js";

vi.mock("mysql2/promise", () => ({
  default: { createPool: vi.fn(() => ({}) as unknown) },
}));

describe("createDoltPool", () => {
  beforeEach(() => {
    vi.mocked(mysql.createPool).mockClear();
  });

  it("pins the driver timezone to UTC so DATETIME/TIMESTAMP digits round-trip (w-arq1yroe)", () => {
    createDoltPool({ host: "127.0.0.1", port: 3306, database: "monsthera" });

    expect(mysql.createPool).toHaveBeenCalledTimes(1);
    const config = vi.mocked(mysql.createPool).mock.calls[0]![0] as Record<string, unknown>;
    // Dolt stores the UTC wall-clock digits we write verbatim; without
    // timezone "Z" the driver re-reads them as host-local time, shifting
    // every stored instant by the host's UTC offset.
    expect(config["timezone"]).toBe("Z");
  });

  it("keeps the existing connection defaults", () => {
    createDoltPool({ host: "db.example", port: 3307, database: "x", user: "u", password: "p" });

    const config = vi.mocked(mysql.createPool).mock.calls[0]![0] as Record<string, unknown>;
    expect(config).toMatchObject({
      host: "db.example",
      port: 3307,
      database: "x",
      user: "u",
      password: "p",
      connectionLimit: 10,
      waitForConnections: true,
    });
  });
});
