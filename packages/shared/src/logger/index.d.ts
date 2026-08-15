export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type LogRecord = {
  timestamp: string;
  namespace: string;
  service: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
};

export type RedactKey = string | RegExp | ((key: string) => boolean);

export type LoggerOptions = {
  namespace?: string;
  service?: string;
  level?: LogLevel | string;
  format?: 'json' | 'pretty' | string;
  redactKeys?: RedactKey[];
  redactor?: (value: string) => string;
  maxDepth?: number;
  maxNodes?: number;
  transports?: LogTransport | LogTransport[];
  baseFields?: Record<string, unknown>;
};

export type LogTransport = (record: LogRecord, format: string) => void;

export interface Logger {
  trace(message: string, fields?: Record<string, unknown>): void;
  trace(fields: Record<string, unknown>, message?: string): void;
  trace(message: string): void;
  trace(): void;

  debug(message: string, fields?: Record<string, unknown>): void;
  debug(fields: Record<string, unknown>, message?: string): void;
  debug(message: string): void;
  debug(): void;

  info(message: string, fields?: Record<string, unknown>): void;
  info(fields: Record<string, unknown>, message?: string): void;
  info(message: string): void;
  info(): void;

  warn(message: string, fields?: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  warn(message: string): void;
  warn(): void;

  error(message: string, fields?: Record<string, unknown>): void;
  error(fields: Record<string, unknown>, message?: string): void;
  error(message: string): void;
  error(): void;

  fatal(message: string, fields?: Record<string, unknown>): void;
  fatal(fields: Record<string, unknown>, message?: string): void;
  fatal(message: string): void;
  fatal(): void;

  child(fields: Record<string, unknown>): Logger;
}

export const LEVELS: Readonly<Record<LogLevel, number>>;

export function createLogger(options?: LoggerOptions): Logger;
export function createConsoleTransport(format?: string): LogTransport;
