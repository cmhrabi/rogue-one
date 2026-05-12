import pino, { type Logger } from "pino";

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
  });
}

export type { Logger };
