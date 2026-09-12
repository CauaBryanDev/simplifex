// Simplifex — Edge Function: change-subscription
// Faz upgrade/downgrade de plano SEM criar uma segunda assinatura: atualiza
// o valor (`transaction_amount`) da MESMA assinatura (preapproval) já ativa
// no Mercado Pago. Isso, por natureza da API do Mercado Pago, preserva a
// data de próxima cobrança (item 11) e elimina o risco de dupla assinatura
// (itens 9 e 13), porque é o mesmo objeto de assinatura, só com valor novo.
//
// LIMITAÇÃO CONHECIDA (documentada de propósito): a API de Preapproval do
// Mercado Pago não expõe cobrança imediata e prorata de diferença sem
// reutilizar o cartão tokenizado do assinante (o que exigiria armazenar
// card_token_id, com implicações de PCI). Por isso, a regra adotada aqui é:
// a diferença de valor passa a valer a partir da PRÓXIMA cobrança — nunca
// cobramos duas vezes no mesmo ciclo. Isso é registrado no histórico para
// transparência total com o usuário.
//
// Segredos necessários: MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MP_ACCESS_TOKEN = Deno.env.get('MP_ACCESS_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const PLANOS_PRECO_CENTAVOS: Record<string, number> = { mei: 2790, me: 7990 };

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

    const { novo_plano_id } = await req.json();
    if (!novo_plano_id || !PLANOS_PRECO_CENTAVOS[novo_plano_id]) {
      return jsonResponse({ error: 'novo_plano_id inválido. Use "mei" ou "me".' }, 400);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1. Busca a assinatura viva do usuário (pending/authorized/paused)
    const { data: atual, error: findError } = await supabaseAdmin
        .from('assinaturas')
        .select('*')
        .eq('user_id', user.id)
        .in('status', ['authorized', 'pending', 'paused'])
        .order('criado_em', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (findError) return jsonResponse({ error: 'Erro ao consultar assinatura atual' }, 500);

    if (!atual) {
      return jsonResponse({
        error: 'Você ainda não tem uma assinatura ativa. Use "Assinar plano" em vez de "Alterar plano".',
      }, 409);
    }

    if (atual.plano_id === novo_plano_id) {
      return jsonResponse({ error: `Você já está no plano ${novo_plano_id.toUpperCase()}.` }, 409);
    }

    const novoValor = PLANOS_PRECO_CENTAVOS[novo_plano_id] / 100;

    // 2. Atualiza o VALOR da mesma assinatura no Mercado Pago (mesmo preapproval_id)
    const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${atual.mp_preapproval_id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auto_recurring: { transaction_amount: novoValor, currency_id: 'BRL' },
      }),
    });
    const mpData = await mpRes.json();
    if (!mpRes.ok) {
      console.error('Erro ao atualizar preapproval:', mpData);
      return jsonResponse({ error: 'Falha ao atualizar assinatura no Mercado Pago', detalhe: mpData }, 502);
    }

    const diferencaCentavos = PLANOS_PRECO_CENTAVOS[novo_plano_id] - PLANOS_PRECO_CENTAVOS[atual.plano_id];

    // 3. Atualiza a assinatura local (mesma linha — não cria uma nova)
    const { error: updateError } = await supabaseAdmin
        .from('assinaturas')
        .update({ plano_id: novo_plano_id })
        .eq('id', atual.id);
    if (updateError) return jsonResponse({ error: 'Falha ao gravar novo plano localmente' }, 500);

    // 4. Registra no histórico, para auditoria e suporte
    await supabaseAdmin.from('assinatura_historico').insert({
      user_id: user.id,
      plano_anterior: atual.plano_id,
      plano_novo: novo_plano_id,
      valor_diferenca_centavos: diferencaCentavos,
      proxima_cobranca: atual.data_proxima_cobranca,
    });

    return jsonResponse({
      ok: true,
      plano_anterior: atual.plano_id,
      plano_novo: novo_plano_id,
      diferenca_centavos: diferencaCentavos,
      proxima_cobranca: atual.data_proxima_cobranca,
      aviso: 'O novo valor passa a valer a partir da próxima cobrança — a data do ciclo foi mantida.',
    });
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