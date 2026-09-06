import type { NextRequest } from 'next/server';
import { rateLimiter } from '@/middleware/rate-limit';

export function middleware(request: NextRequest) {
  // Extract tenant ID from header or subdomain
  const tenantId = request.headers.get('x-tenant-id') || 
                   new URL(request.url).hostname.split('.')[0] || 'default';
  
  // Rate limiting based on tenant tier
  rateLimiter(tenantId);
  
  // Add tenant ID to response headers
  const response = new Response(null, { status: 200 });
  response.headers.set('x-tenant-id', tenantId);
  
  return response;
}

export const config = {
  matcher: '/api/v1/:path*',
};
