import { readFileSync } from "node:fs";

export interface ParsedTicket {
  title: string;
  description: string;
  rationale: string;
  severity: "critical" | "high" | "medium" | "low";
  priority: number;
  tags: string[];
  dependsOn: number[];
  affectedPaths: string[];
  acceptanceCriteria?: string;
}

export function parseTicketsFile(filePath: string): ParsedTicket[] {
  const raw = readFileSync(filePath, "utf-8");
  if (filePath.endsWith(".json")) {
    return parseJsonTickets(raw);
  }
  if (filePath.endsWith(".md")) {
    return parseMarkdownTickets(raw);
  }
  throw new Error(`Unsupported tickets file format: ${filePath}. Use .json or .md`);
}

function parseJsonTickets(raw: string): ParsedTicket[] {
  const data = JSON.parse(raw);
  const tickets = Array.isArray(data) ? data : data.tickets ?? data.proposedTasks;
  if (!Array.isArray(tickets)) {
    throw new Error("JSON tickets file must be an array or have a 'tickets'/'proposedTasks' key");
  }
  return tickets.map((t: Record<string, unknown>, i: number) => ({
    title: String(t.title ?? `Task ${i + 1}`),
    description: String(t.description ?? ""),
    rationale: String(t.rationale ?? t.description ?? ""),
    severity: parseSeverity(t.severity),
    priority: typeof t.priority === "number" ? t.priority : 5,
    tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
    dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(Number) : [],
    affectedPaths: Array.isArray(t.affectedPaths) ? t.affectedPaths.map(String) : [],
    acceptanceCriteria: typeof t.acceptanceCriteria === "string" ? t.acceptanceCriteria : undefined,
  }));
}

function parseMarkdownTickets(raw: string): ParsedTicket[] {
  const tickets: ParsedTicket[] = [];
  // Split on ### TXX — or ### Txx — headers
  const sections = raw.split(/^### T\d+\s*[—–-]\s*/m).slice(1);
  const ticketIdMap = new Map<string, number>();

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const lines = section.split("\n");
    const title = lines[0]?.trim() ?? `Task ${i + 1}`;

    const ticket: ParsedTicket = {
      title,
      description: "",
      rationale: title,
      severity: "medium",
      priority: 5,
      tags: [],
      dependsOn: [],
      affectedPaths: [],
    };

    // Track ticket ID for dependsOn resolution
    const idMatch = raw.split(/^### (T\d+)\s*[—–-]/m);
    for (let j = 1; j < idMatch.length; j += 2) {
      const id = idMatch[j];
      if (id) ticketIdMap.set(id, Math.floor((j - 1) / 2));
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- **severity:**")) {
        ticket.severity = parseSeverity(extractValue(trimmed));
      } else if (trimmed.startsWith("- **priority:**")) {
        ticket.priority = parseInt(extractValue(trimmed), 10) || 5;
      } else if (trimmed.startsWith("- **tags:**")) {
        ticket.tags = extractValue(trimmed).split(",").map((t) => t.replace(/`/g, "").trim()).filter(Boolean);
      } else if (trimmed.startsWith("- **dependsOn:**")) {
        const depStr = extractValue(trimmed);
        const deps = depStr.match(/T(\d+)/g);
        if (deps) {
          ticket.dependsOn = deps.map((d) => {
            const idx = ticketIdMap.get(d);
            return idx ?? parseInt(d.slice(1), 10) - 1;
          });
        }
      } else if (trimmed.startsWith("- **affectedPaths:**")) {
        ticket.affectedPaths = extractValue(trimmed).split(",").map((p) => p.replace(/`/g, "").trim()).filter(Boolean);
      } else if (trimmed.startsWith("- **description:**")) {
        ticket.description = extractValue(trimmed);
      } else if (trimmed.startsWith("- **acceptanceCriteria:**")) {
        ticket.acceptanceCriteria = extractValue(trimmed);
      }
    }

    // If no inline description, use everything after the metadata lines
    if (!ticket.description) {
      const descLines = lines.filter((l) => !l.trim().startsWith("- **") && !l.trim().startsWith("---") && l.trim());
      ticket.description = descLines.slice(1).join("\n").trim(); // skip title line
    }

    tickets.push(ticket);
  }

  return tickets;
}

function extractValue(line: string): string {
  const match = line.match(/\*\*[^*]+:\*\*\s*(.*)/);
  return match?.[1]?.trim() ?? "";
}

function parseSeverity(value: unknown): "critical" | "high" | "medium" | "low" {
  const s = String(value).toLowerCase().trim();
  if (s === "critical" || s === "high" || s === "medium" || s === "low") return s;
  return "medium";
}
