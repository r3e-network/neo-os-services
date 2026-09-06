import z from 'zod';

export const SwapSchema = z.object({
  tokenIn: z.string().uuid(),
  tokenOut: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  recipient: z.string().optional(),
});

export const QuoteSchema = z.object({
  sources: z.array(z.string()).default(['NeoSwap']),
  deadline: z.number().int().positive().optional(),
  slippageTolerance: z.number().min(0).max(50).default(0.5),
  routes: z.array(z.object({
    poolIds: z.array(z.string()),
    percentage: z.number().min(0).max(100),
  })).default([{ poolIds: [], percentage: 100 }]),
});

// Validation schemas for API requests
export const RouteRequestSchema = z.object({
  tokenIn: z.string().describe('Input token address'),
  tokenOut: z.string().describe('Output token address'),
  amount: z.string().describe('Amount in smallest denomination'),
  maxHops: z.number().int().min(1).max(6).optional().default(4),
  excludePools: z.array(z.string()).optional(),
  includePools: z.array(z.string()).optional(),
});

export const RouteResponseSchema = z.object({
  requestId: z.string().uuid(),
  timestamp: z.number().int(),
  bestRoute: z.object({
    poolPath: z.array(z.string()),
    inAmount: z.string(),
    outAmount: z.string(),
    priceImpact: z.number(),
    gasEstimate: z.string(),
    protocolFeeBps: z.number(),
  }),
  alternativeRoutes: z.array(z.any()),
  mevScan: z.object({
    isSuspicious: z.boolean(),
    riskLevel: z.enum(['low', 'medium', 'high']),
    detectedPatterns: z.array(z.string()),
    suggestedSlippage: z.number(),
  }),
  totalLiquidity: z.string(),
});

export type RouteRequest = z.infer<typeof RouteRequestSchema>;
export type RouteResponse = z.infer<typeof RouteResponseSchema>;
