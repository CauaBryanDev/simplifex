/**
 * Simplifex — Cliente Supabase
 * Preencha SUPABASE_URL e SUPABASE_ANON_KEY com os dados do seu projeto
 * (Project Settings > API no painel do Supabase). A anon key é pública
 * por design — a segurança real vem do Row Level Security (schema.sql).
 */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = window.SIMPLIFEX_CONFIG?.SUPABASE_URL || 'https://SEU-PROJETO.supabase.co';
const SUPABASE_ANON_KEY = window.SIMPLIFEX_CONFIG?.SUPABASE_ANON_KEY || 'SUA_ANON_KEY_AQUI';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
