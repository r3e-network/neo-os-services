// Next.js API route for quote calculation
import { NextRequest, NextResponse } from 'next/server';
import { cacheKeyFromRequest, getCached, setCache } from '@/utils/cache';
import { requestCounter, latencyHistogram } from '@/utils/metrics';

/**
 * GET /api/v1/quote
 * Calculate optimal swap routes with Redis TTL caching
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();

  try {
    const url = new URL(request.url);

    // Extract query parameters
    const tokenIn = url.searchParams.get('tokenIn');
    const tokenOut = url.searchParams.get('tokenOut');
    const amount = url.searchParams.get('amount');

    if (!tokenIn || !tokenOut || !amount) {
      return NextResponse.json(
        { error: 'Missing required parameters: tokenIn, tokenOut, amount' },
        { status: 400 }
      );
    }

    // Generate cache key
    const cacheKey = cacheKeyFromRequest(tokenIn, tokenOut, amount);

    // Try to get from cache first (TTL: 10 seconds)
    let cachedQuote = await getCached(cacheKey);
    if (cachedQuote) {
      return NextResponse.json({ ...cachedQuote, cached: true });
    }

    // Fetch from routing engine (mock implementation)
    const quote = await calculateQuote({
      tokenIn: tokenIn as string,
      tokenOut: tokenOut as string,
      amount: amount as string,
    });

    // Cache the result for 10 seconds
    await setCache(cacheKey, quote, 10);

    const duration = (Date.now() - startTime) / 1000;
    requestCounter.inc({ method: 'GET', endpoint: '/api/v1/quote', status_code: 200 });
    latencyHistogram.observe(duration, '/api/v1/quote');

    return NextResponse.json({
      ...quote,
      timestamp: Date.now(),
      cached: false,
    });
  } catch (error) {
    console.error('Quote calculation failed:', error);

    const duration = (Date.now() - startTime) / 1000;
    requestCounter.inc({ method: 'GET', endpoint: '/api/v1/quote', status_code: 500 });
    latencyHistogram.observe(duration, '/api/v1/quote');

    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function calculateQuote(params: {
  tokenIn: string;
  tokenOut: string;
  amount: string;
}): Promise<any> {
  // In production, this would call the routing engine service
  // For now, return mock response

  return {
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    amountIn: params.amount,
    amountOut: (parseFloat(params.amount) * 0.98).toString(), // Mock 2% price impact
    gasEstimate: '50000',
    priceImpact: 0.02,
    feeBps: 30,
    bestRoute: {
      poolPath: ['pool-1', 'pool-2'],
      minOutputAmount: (parseFloat(params.amount) * 0.97).toString(),
    },
    mevProtection: {
      enabled: true,
      riskLevel: 'low',
      suggestedSlippage: 0.5,
    },
  };
}
