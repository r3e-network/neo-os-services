import { z } from 'zod';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const pcr = z
  .string()
  .regex(/^[0-9a-f]{96}$/)
  .refine((value) => !/^0+$/.test(value));
const release = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const context = z.object({ profile_sha256: digest }).strict();

/**
 * Runtime pin projection only, NOT the dual release/artifact admission schema.
 * Profile digests must be bound to the validated manifest by the admission gate.
 * Parsing here proves structure, never provenance or actual EIF reproducibility.
 */
export const dualNitroMeasurementSchema = z
  .object({
    schema: z.literal('neoos/dual-nitro-measurement/v1'),
    release,
    network: z.null(),
    networks: z.tuple([z.literal('mainnet'), z.literal('testnet')]),
    app_ids: z.tuple([z.literal('morpheus-oracle'), z.literal('morpheus-custody')]),
    git_commit: z.string().regex(/^[0-9a-f]{40}$/),
    built_at: z.string().datetime({ offset: true }),
    manifest_sha256: digest,
    eif_sha256: digest,
    contexts: z.object({ mainnet: context, testnet: context }).strict(),
    supersedes: z
      .array(release)
      .max(1024)
      .refine((ids) => new Set(ids).size === ids.length),
    pcr0: pcr,
    pcr1: pcr,
    pcr2: pcr,
  })
  .strict();

export type DualNitroMeasurement = z.infer<typeof dualNitroMeasurementSchema>;

export function parseDualNitroMeasurement(value: unknown): DualNitroMeasurement {
  const record = dualNitroMeasurementSchema.parse(value);
  // Parsed copies are immutable so selection cannot validate one graph and use another.
  Object.freeze(record.networks);
  Object.freeze(record.app_ids);
  Object.freeze(record.supersedes);
  Object.freeze(record.contexts.mainnet);
  Object.freeze(record.contexts.testnet);
  Object.freeze(record.contexts);
  return Object.freeze(record);
}
