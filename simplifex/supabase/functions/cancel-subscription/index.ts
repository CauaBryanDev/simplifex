// Simplifex — Edge Function: cancel-subscription
// Cancela (status "cancelled") a assinatura recorrente do usuário autenticado
// no Mercado Pago e reflete localmente no Supabase.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MP_ACCESS_TOKEN = Deno.env.get('MP_ACCESS_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace('Bearer ', '');
    if (!jwt) return jsonResponse({ error: 'Não autenticado' }, 401);

    const supabaseAuth = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser(jwt);
    if (userError || !userData?.user) return jsonResponse({ error: 'Sessão inválida' }, 401);
    const user = userData.user;

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: assinatura, error: findError } = await supabaseAdmin
      .from('assinaturas')
      .select('*')
      .eq('user_id', user.id)
      .in('status', ['authorized', 'pending', 'paused'])
      .order('criado_em', { ascending: false })
      .limit(1)
      .single();

    if (findError || !assinatura) return jsonResponse({ error: 'Nenhuma assinatura ativa encontrada' }, 404);

    const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${assinatura.mp_preapproval_id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    const mpData = await mpRes.json();
    if (!mpRes.ok) return jsonResponse({ error: 'Falha ao cancelar no Mercado Pago', detalhe: mpData }, 502);

    await supabaseAdmin
      .from('assinaturas')
      .update({ status: 'cancelled' })
      .eq('id', assinatura.id);

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse({ error: 'Erro inesperado', detalhe: String(err) }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
