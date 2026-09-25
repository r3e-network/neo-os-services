import { getRedis } from '@/lib/redis';
import { CACHE_CONFIG } from '@/utils/metrics';

const cacheKeyPrefix = 'neoswap:quote:';

export function cacheKeyFromRequest(tokenIn: string, tokenOut: string, amount: string): string {
  return `${cacheKeyPrefix}${tokenIn}:${tokenOut}:${amount}`;
}

export async function getCached(key: string): Promise<any | null> {
  try {
    const data = await (await getRedis()).get(key);
    if (data) {
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Cache read failed:', error);
  }
  return null;
}

export async function setCache(
  key: string,
  data: any,
  ttlSeconds: number = CACHE_CONFIG.ROUTE_CACHE_TTL
): Promise<void> {
  try {
    await (await getRedis()).setEx(key, ttlSeconds, JSON.stringify(data));
  } catch (error) {
    console.error('Cache write failed:', error);
  }
}

export async function deleteCache(key: string): Promise<boolean> {
  try {
    const deleted = await (await getRedis()).del(key);
    return deleted > 0;
  } catch (error) {
    console.error('Cache delete failed:', error);
    return false;
  }
}
