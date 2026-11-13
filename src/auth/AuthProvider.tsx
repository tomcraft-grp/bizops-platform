// Real session state, backed by Supabase Auth — never the local per-browser demo "DB" the rest of
// this prototype uses. `profile.role` (SUPER_ADMIN/ADMIN/USER) is the server-enforced truth (via RLS
// on public.profiles); this context only mirrors it for the UI, it never grants anything itself.
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export type ProfileRole = 'SUPER_ADMIN' | 'ADMIN' | 'USER';
export interface Profile {
  id: string; email: string; display_name: string | null; role: ProfileRole; status: 'active' | 'disabled';
  created_at: string; updated_at: string;
  // LINE members (see lib/liff.ts): no email/password, just LINE + phone + PDPA consent.
  phone?: string | null; line_user_id?: string | null; pdpa_consent_at?: string | null;
}
interface AuthState {
  session: Session | null; profile: Profile | null; loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (newPassword: string) => Promise<{ error: string | null }>;
  refreshProfile: () => Promise<void>;
}
const AuthContext = createContext<AuthState | null>(null);
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function recordLoginAttempt(email: string, success: boolean) {
  void supabase.from('login_attempts').insert({ email, success }).then(() => undefined, () => undefined);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = async (uid: string) => {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).single();
    setProfile(error ? null : (data as Profile));
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) loadProfile(data.session.user.id).finally(() => setLoading(false));
      else setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession) void loadProfile(newSession.user.id);
      else setProfile(null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);


  const signIn: AuthState['signIn'] = async (email, password) => {
    const { data: failCount, error: rpcErr } = await supabase.rpc('recent_login_failures', { p_email: email, p_minutes: LOCKOUT_MINUTES });
    if (!rpcErr && typeof failCount === 'number' && failCount >= MAX_FAILED_ATTEMPTS) {
      return { error: `Too many failed attempts. Please wait ${LOCKOUT_MINUTES} minutes and try again.` };
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    recordLoginAttempt(email, !error);
    return { error: error?.message ?? null };
  };

  const signOut = async () => { await supabase.auth.signOut(); };

  const requestPasswordReset: AuthState['requestPasswordReset'] = async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${window.location.pathname}#/reset-password`,
    });
    return { error: error?.message ?? null };
  };

  const updatePassword: AuthState['updatePassword'] = async (newPassword) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    return { error: error?.message ?? null };
  };

  const refreshProfile = async () => { if (session) await loadProfile(session.user.id); };

  return (
    <AuthContext.Provider value={{ session, profile, loading, signIn, signOut, requestPasswordReset, updatePassword, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}
