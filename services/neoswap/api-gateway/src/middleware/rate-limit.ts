import { TENANT_CONFIG } from '@/utils/metrics';
import { createClient } from 'redis';

let redisClient: any = null;

async function getRedis() {
  if (!redisClient) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = createClient({ url: redisUrl });
    await redisClient.connect();
  }
  return redisClient;
}

export function generateRateLimitKey(tenantId: string): string {
  return `ratelimit:${tenantId}`;
}

export async function checkRateLimit(tenantId: string, maxRequests: number, windowMs: number): Promise<{
  allowed: boolean;
  remaining: number;
  resetTime: number;
}> {
  const redis = await getRedis();
  const key = generateRateLimitKey(tenantId);
  
  // Get current count
  const current = await redis.get(key);
  const count = current ? parseInt(current) : 0;
  
  if (count >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: Date.now() + windowMs,
    };
  }
  
  // Increment with TTL
  await redis.incr(key);
  await redis.expire(key, Math.floor(windowMs / 1000));
  
  return {
    allowed: true,
    remaining: maxRequests - count - 1,
    resetTime: Date.now() + windowMs,
  };
}

export function rateLimiter(tenantId: string, options: { maxRequests: number; windowMs: number } = {
  maxRequests: TENANT_CONFIG.rateLimits.free.maxRequests,
  windowMs: TENANT_CONFIG.rateLimits.free.windowMs,
}) {
  const limitCheck = async () => {
    const result = await checkRateLimit(tenantId, options.maxRequests, options.windowMs);
    
    if (!result.allowed) {
      throw new Error('Rate limit exceeded');
    }
    
    return result;
  };
  
  return limitCheck;
}
