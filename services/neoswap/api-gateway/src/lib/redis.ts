import { createClient } from 'redis';

// Export singleton Redis client
let redis: any = null;

export async function getRedis(): Promise<any> {
  if (!redis) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL is required for API Gateway cache');
    redis = createClient({ url: redisUrl });

    await redis.connect();
    console.log('API Gateway Redis connected');
  }

  return redis;
}

// Default export for import convenience
export { getRedis as default };
