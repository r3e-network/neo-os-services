export function json(status: number, body: unknown, headers?: Record<string, string>): Response;

export function trimString(value: unknown): string;

export function parseTimestampMs(value: unknown): number;

export function getClientIp(request: Request): string;

export function timingSafeCompare(a: unknown, b: unknown): boolean;

export function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => R | Promise<R>
): Promise<R[]>;

export function resolveScanConcurrency(config: unknown): number;

export function stableStringify(value: unknown): string;
