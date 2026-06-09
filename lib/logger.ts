import path from "node:path";
import pino, { type Logger, type LoggerOptions, type TransportTargetOptions } from "pino";

type GlobalWithLogger = typeof globalThis & {
  __appLogger?: Logger;
};

const globalForLogger = globalThis as GlobalWithLogger;

function parseSize(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function parseFrequency(value: string | undefined): "daily" | "hourly" | number {
  const raw = (value ?? "daily").trim().toLowerCase();
  if (raw === "daily" || raw === "hourly") return raw;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  return "daily";
}

function parseRetention(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function buildLogger(): Logger {
  // Edge runtime cannot use Node transports — fall back to stdout JSON only.
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") {
    return pino({ level: process.env.LOG_LEVEL || "info" });
  }

  const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");
  const logDir = path.resolve(process.cwd(), process.env.LOG_DIR || "logs");
  const logFile = process.env.LOG_FILE || "app.log";
  const filePath = path.join(logDir, logFile);
  const frequency = parseFrequency(process.env.LOG_ROTATE_FREQUENCY);
  const size = parseSize(process.env.LOG_ROTATE_SIZE, "10m");
  const retention = parseRetention(process.env.LOG_RETENTION, 7);
  const isProd = process.env.NODE_ENV === "production";

  const targets: TransportTargetOptions[] = [
    {
      target: "pino-roll",
      level,
      options: {
        file: filePath,
        frequency,
        size,
        mkdir: true,
        dateFormat: "yyyy-MM-dd",
        limit: { count: retention },
      },
    },
  ];

  // Also mirror to stdout. Pretty-print in development, JSON in production.
  if (isProd) {
    targets.push({
      target: "pino/file",
      level,
      options: { destination: 1 },
    });
  } else {
    targets.push({
      target: "pino-pretty",
      level,
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    });
  }

  const options: LoggerOptions = {
    level,
    base: { app: "agents-chat" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  try {
    const transport = pino.transport({ targets });
    return pino(options, transport);
  } catch (err) {
    // If transport setup fails (e.g., bundler can't resolve workers), fall back to stdout.
    // eslint-disable-next-line no-console
    console.warn("[logger] failed to initialize transports, falling back to stdout:", err);
    return pino(options);
  }
}

export const logger: Logger =
  globalForLogger.__appLogger ?? (globalForLogger.__appLogger = buildLogger());

export function createLogger(name: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ name, ...bindings });
}

export type { Logger } from "pino";
