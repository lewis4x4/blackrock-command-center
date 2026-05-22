export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

const SECRET_FIELD_HINTS = ["token", "key", "authorization", "private", "secret", "password"];

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SECRET_FIELD_HINTS.some((hint) => lower.includes(hint))) {
      out[key] = "[redacted]";
    } else {
      out[key] = sanitize(nested);
    }
  }
  return out;
}

export function createLogger(component = "runner"): Logger {
  function write(level: LogLevel, message: string, fields: Record<string, unknown> = {}) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component,
      message,
      ...(sanitize(fields) as Record<string, unknown>),
    });
    Bun.stdout.write(`${line}\n`);
  }

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

export function errorSummary(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
