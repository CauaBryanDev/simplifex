// Simplifex — Edge Function: create-pix-payment
// Gera um pagamento único via PIX (Payments API do Mercado Pago, sem criar
// assinatura) para os produtos avulsos do sistema. O PREÇO é sempre lido da
// tabela `precos_produtos` no banco — o valor que vier do navegador é
// ignorado, exatamente para impedir que alguém manipule o preço pelo
// front-end (item 16 do escopo).
//
// Segredos necessários: MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

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

    const { product } = await req.json();
    if (!product || !['one_time', 'irpf_simulation'].includes(product)) {
      return jsonResponse({ error: 'product inválido. Use "one_time" ou "irpf_simulation".' }, 400);
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1. Preço vem SEMPRE do banco — nunca do corpo da requisição.
    const { data: precoRow, error: precoError } = await supabaseAdmin
        .from('precos_produtos')
        .select('preco_centavos, descricao')
        .eq('product', product)
        .single();
    if (precoError || !precoRow) return jsonResponse({ error: 'Produto não configurado' }, 500);

    const valorReais = precoRow.preco_centavos / 100;

    // 2. Cria o pagamento PIX na Payments API do Mercado Pago
    const idempotencyKey = `${user.id}-${product}-${Date.now()}`;
    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        transaction_amount: valorReais,
        description: precoRow.descricao || product,
        payment_method_id: 'pix',
        payer: { email: user.email },
        external_reference: `${user.id}:${product}`,
      }),
    });
    const mpData = await mpRes.json();
    if (!mpRes.ok) {
      console.error('Erro Mercado Pago (PIX):', mpData);
      return jsonResponse({ error: 'Falha ao gerar cobrança PIX', detalhe: mpData }, 502);
    }

    // 3. Grava o registro local — status "pending" até o webhook confirmar
    const { error: dbError } = await supabaseAdmin.from('one_time_purchases').insert({
      user_id: user.id,
      product,
      amount_centavos: precoRow.preco_centavos,
      status: 'pending',
      mp_payment_id: String(mpData.id),
    });
    if (dbError) {
      console.error('Erro ao gravar compra avulsa:', dbError);
      return jsonResponse({ error: 'Pagamento criado no Mercado Pago mas falhou ao gravar localmente' }, 500);
    }

    const txData = mpData.point_of_interaction?.transaction_data;
    return jsonResponse({
      payment_id: mpData.id,
      status: mpData.status,
      qr_code: txData?.qr_code,               // "copia e cola"
      qr_code_base64: txData?.qr_code_base64, // imagem do QR code, já em base64
      ticket_url: txData?.ticket_url,
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