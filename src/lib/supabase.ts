// Real backend for authentication (see src/auth/AuthProvider.tsx) and the centralized feedback
// store (src/lib/feedbackApi.ts uses the same project via raw fetch — this client is for Auth, where
// supabase-js's session handling, token refresh and email-link flows are too easy to get wrong by hand).
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://hlvravynjalculvplrxc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_H2G8TT0QzfwUPI7HsqDT1g_sBlEJa5V';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
