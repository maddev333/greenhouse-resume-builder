/**
 * Leveled diagnostics for the engagements MCP server.
 *
 * EVERYTHING is written to **stderr**. In `--stdio` mode stdout carries the JSON-RPC frames, so a
 * stray `console.log` from library code corrupts the protocol stream; stderr is the only safe
 * channel, and the terminal, `func`, and App Service log streaming all capture it.
 *
 * `ENGAGEMENTS_LOG_LEVEL=silent|error|warn|info|debug` (default `info`). `debug` adds the full
 * query shapes and per-call timings needed to work out WHY a retrieval call failed. The level is
 * read on every call, so it can be changed without a rebuild.
 */

const LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LEVELS)[number];

const DEFAULT_LEVEL: LogLevel = "info";

/** The configured level, falling back to `info` for an unset or unrecognised value. */
export function logLevel(): LogLevel {
  const raw = (process.env.ENGAGEMENTS_LOG_LEVEL ?? "").trim().toLowerCase();
  return (LEVELS as readonly string[]).includes(raw)
    ? (raw as LogLevel)
    : DEFAULT_LEVEL;
}

function enabled(level: Exclude<LogLevel, "silent">): boolean {
  return LEVELS.indexOf(logLevel()) >= LEVELS.indexOf(level);
}

/**
 * Flatten an unknown throw into one readable line, keeping the fields Azure SDK errors carry
 * (`statusCode`, `code`, `details`) — a bare `err.message` on a `RestError` is often just
 * "Operation returned an invalid status code", which says nothing.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & {
    statusCode?: number;
    code?: string | number;
    details?: { error?: { message?: string; code?: string } };
  };
  const parts = [`${e.name}: ${e.message}`];
  if (e.statusCode !== undefined) parts.push(`status=${e.statusCode}`);
  if (e.code !== undefined && e.code !== e.statusCode)
    parts.push(`code=${e.code}`);
  const detail = e.details?.error?.message;
  if (detail && !e.message.includes(detail)) parts.push(`detail=${detail}`);
  return parts.join(" | ");
}

/** The HTTP status an Azure SDK error carries, when it carries one. */
export function errorStatus(err: unknown): number | undefined {
  const s = (err as { statusCode?: unknown })?.statusCode;
  return typeof s === "number" ? s : undefined;
}

export interface Logger {
  error(message: string, err?: unknown): void;
  warn(message: string, err?: unknown): void;
  info(message: string): void;
  /** Accepts a thunk so expensive formatting is skipped unless debug is on. */
  debug(message: string | (() => string)): void;
  /** True when `debug` output would be emitted. */
  isDebug(): boolean;
}

/** A logger tagged `[engagements:<scope>]`, so a noisy subsystem is easy to grep out. */
export function createLogger(scope: string): Logger {
  const tag = `[engagements:${scope}]`;
  const write = (level: string, message: string, err?: unknown): void => {
    const suffix = err === undefined ? "" : ` -- ${describeError(err)}`;
    console.error(`${tag} ${level} ${message}${suffix}`);
    // Stacks are the one thing a one-line summary cannot replace.
    if (err instanceof Error && err.stack && enabled("debug")) {
      console.error(err.stack);
    }
  };

  return {
    error: (message, err) => {
      if (enabled("error")) write("ERROR", message, err);
    },
    warn: (message, err) => {
      if (enabled("warn")) write("WARN ", message, err);
    },
    info: (message) => {
      if (enabled("info")) write("INFO ", message);
    },
    debug: (message) => {
      if (!enabled("debug")) return;
      write("DEBUG", typeof message === "function" ? message() : message);
    },
    isDebug: () => enabled("debug"),
  };
}
