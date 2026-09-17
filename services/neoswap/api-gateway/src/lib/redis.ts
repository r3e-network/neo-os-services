import { createClient } from 'redis';

// Export singleton Redis client
let redis: any = null;

export async function getRedis(): Promise<any> {
  if (!redis) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redis = createClient({ url: redisUrl });

    await redis.connect();
    console.log('API Gateway Redis connected');
  }

  return redis;
}

// Initialize at startup
getRedis().catch(console.error);

// Default export for import convenience
export { getRedis as default };
