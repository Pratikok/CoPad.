import { createClient } from '@supabase/supabase-js';

export function createSupabaseClient(url, anonKey) {
  const supabaseUrl = url || import.meta.env.VITE_SUPABASE_URL;
  const key = anonKey || import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !key) {
    throw new Error('Supabase URL and anon key are required.');
  }
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });
}
