// Simplifex — Edge Function: create-preapproval
// Cria uma assinatura recorrente (Preapproval) no Mercado Pago para o plano
// escolhido e devolve o `init_point` (URL de checkout) para o front-end
// redirecionar o usuário.
//
// Segredos necessários (configure com `supabase secrets set`):
//   MP_ACCESS_TOKEN            -> Access Token PRIVADO do Mercado Pago
//   SUPABASE_URL               -> preenchido automaticamente pelo runtime
//   SUPABASE_SERVICE_ROLE_KEY  -> Service Role Key do projeto Supabase
//   APP_BASE_URL               -> ex: https://simplifex.com.br
//
// Deploy: supabase functions deploy create-preapproval

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MP_ACCESS_TOKEN = Deno.env.get('MP_ACCESS_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'http://localhost:3000';

const PLANOS_PRECO: Record<string, number> = {
  mei: 27.90,
  me: 79.90,
};
const PLANOS_NOME: Record<string, string> = {
  mei: 'Simplifex MEI — assinatura mensal',
  me: 'Simplifex ME — assinatura mensal',
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // 1. Autentica o usuário a partir do JWT enviado pelo front-end
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace('Bearer ', '');
    if (!jwt) return jsonResponse({ error: 'Não autenticado' }, 401);

    const supabaseAuth = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser(jwt);
    if (userError || !userData?.user) return jsonResponse({ error: 'Sessão inválida' }, 401);
    const user = userData.user;

    // 2. Valida o plano solicitado
    const { plano_id } = await req.json();
    if (!plano_id || !PLANOS_PRECO[plano_id]) {
      return jsonResponse({ error: 'plano_id inválido. Use "mei" ou "me".' }, 400);
    }

    // 2.1 Trava de duplicidade (item 13): se já existe assinatura viva, o
    // caminho certo é trocar de plano, não criar uma segunda assinatura.
    // O banco também tem um índice único parcial que rejeitaria o insert
    // mesmo se essa checagem falhasse — dupla camada de proteção.
    const supabaseCheck = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: assinaturaViva } = await supabaseCheck
      .from('assinaturas')
      .select('id, plano_id, status')
      .eq('user_id', user.id)
      .in('status', ['authorized', 'pending', 'paused'])
      .maybeSingle();

    if (assinaturaViva) {
      return jsonResponse({
        error: 'ASSINATURA_JA_EXISTE',
        message: `Você já possui uma assinatura ${assinaturaViva.status === 'authorized' ? 'ativa' : 'em andamento'} (plano ${assinaturaViva.plano_id.toUpperCase()}). Use a troca de plano em vez de assinar novamente.`,
        plano_atual: assinaturaViva.plano_id,
      }, 409);
    }

    // 3. Cria a assinatura recorrente no Mercado Pago
    const mpResponse = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `${user.id}-${plano_id}-${Date.now()}`,
      },
      body: JSON.stringify({
        reason: PLANOS_NOME[plano_id],
        payer_email: user.email,
        back_url: `${APP_BASE_URL}/dashboard.html?assinatura=confirmada`,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: PLANOS_PRECO[plano_id],
          currency_id: 'BRL',
        },
        status: 'pending',
        external_reference: `${user.id}:${plano_id}`,
      }),
    });

    const mpData = await mpResponse.json();
    if (!mpResponse.ok) {
      console.error('Erro Mercado Pago:', mpData);
      return jsonResponse({ error: 'Falha ao criar assinatura no Mercado Pago', detalhe: mpData }, 502);
    }

    // 4. Grava/atualiza a assinatura no Supabase (service role, ignora RLS)
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { error: dbError } = await supabaseAdmin.from('assinaturas').upsert({
      user_id: user.id,
      plano_id,
      mp_preapproval_id: mpData.id,
      mp_payer_email: user.email,
      status: 'pending',
    }, { onConflict: 'mp_preapproval_id' });

    if (dbError) {
      console.error('Erro ao gravar assinatura:', dbError);
      return jsonResponse({ error: 'Assinatura criada no Mercado Pago mas falhou ao gravar localmente' }, 500);
    }

    // 5. Devolve a URL de checkout para o front-end redirecionar o usuário
    return jsonResponse({ init_point: mpData.init_point, preapproval_id: mpData.id });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: 'Erro inesperado', detalhe: String(err) }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
