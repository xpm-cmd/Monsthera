export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  domain?: string;
  operation?: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(options: {
  level?: LogLevel;
  domain?: string;
  output?: (entry: LogEntry) => void;
  _parentContext?: Record<string, unknown>;
}): Logger {
  const level = options.level ?? "info";
  const domain = options.domain;
  const parentContext = options._parentContext ?? {};

  const output =
    options.output ??
    ((entry: LogEntry) => {
      process.stderr.write(JSON.stringify(entry) + "\n");
    });

  function emit(logLevel: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LOG_LEVELS[logLevel] < LOG_LEVELS[level]) return;

    const entry: LogEntry = {
      ...parentContext,
      ...context,
      level: logLevel,
      message,
      timestamp: new Date().toISOString(),
    };

    if (domain !== undefined) {
      entry.domain = domain;
    }

    output(entry);
  }

  return {
    debug(message, context) {
      emit("debug", message, context);
    },
    info(message, context) {
      emit("info", message, context);
    },
    warn(message, context) {
      emit("warn", message, context);
    },
    error(message, context) {
      emit("error", message, context);
    },
    child(context) {
      const childDomain = (context.domain as string | undefined) ?? domain;
      // Merge parent context, then child context (child wins on conflicts)
      const mergedContext = { ...parentContext, ...context };
      // Remove domain from merged context since it's handled separately
      const rest = Object.fromEntries(
        Object.entries(mergedContext).filter(([k]) => k !== "domain"),
      );
      return createLogger({
        level,
        domain: childDomain,
        output,
        _parentContext: rest,
      });
    },
  };
}
