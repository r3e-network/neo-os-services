import { z } from 'zod';

/**
 * Shared Zod schemas for public apps/web API inputs.
 *
 * These schemas are intentionally strict: public routes should reject malformed,
 * oversized, or unexpected inputs rather than silently coercing them.
 */

export const networkNameSchema = z.enum(['mainnet', 'testnet']);

export const didStringSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^did:[a-z0-9]+:[a-zA-Z0-9_.\-:]+$/, 'Invalid DID format');

export const paginationParamsSchema = z
  .object({
    page: z
      .string()
      .regex(/^\d+$/, 'page must be a non-negative integer')
      .optional()
      .transform((value) => (value ? Number(value) : 1))
      .pipe(z.number().int().min(1).max(10_000)),
    limit: z
      .string()
      .regex(/^\d+$/, 'limit must be a non-negative integer')
      .optional()
      .transform((value) => (value ? Number(value) : 20))
      .pipe(z.number().int().min(1).max(100)),
    offset: z
      .string()
      .regex(/^\d+$/, 'offset must be a non-negative integer')
      .optional()
      .transform((value) => (value ? Number(value) : 0))
      .pipe(z.number().int().min(0).max(100_000)),
  })
  .strict();

export const cronFeedParamsSchema = z
  .object({
    feed: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_\-\/]+$/, 'Invalid feed identifier'),
    network: networkNameSchema.optional(),
  })
  .strict();

export const emptyQuerySchema = z.object({}).strict();

export const neodidResolveQuerySchema = z
  .object({
    did: didStringSchema,
    format: z.enum(['document', 'resolution']).optional(),
  })
  .strict();
