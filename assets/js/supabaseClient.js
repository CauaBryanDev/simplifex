/**
 * Simplifex — Cliente Supabase
 * Preencha SUPABASE_URL e SUPABASE_ANON_KEY com os dados do seu projeto
 * (Project Settings > API no painel do Supabase). A anon key é pública
 * por design — a segurança real vem do Row Level Security (schema.sql).
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = window.SIMPLIFEX_CONFIG?.SUPABASE_URL || 'https://umtbatzuhjdlzaswaklr.supabase.co';
const SUPABASE_ANON_KEY = window.SIMPLIFEX_CONFIG?.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtdGJhdHp1aGpkbHphc3dha2xyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxNTkxMzEsImV4cCI6MjEwNDczNTEzMX0.BpITG3uoZDB1FHpZyx2778km6g1SlavJieMffR3r4kw';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
    },
});