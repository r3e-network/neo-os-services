// Browser-safe configuration only. Every value here is public by definition
// (NEXT_PUBLIC_* env vars are inlined into client bundles at build time) or a
// static default. Server credentials live in lib/config, which must never be
// imported from client components.
export const publicConfig = {
  name: process.env.NEXT_PUBLIC_APP_NAME || 'NeoOS Services',
  appUrl: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
};
