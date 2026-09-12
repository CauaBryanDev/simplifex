import { supabase } from './supabaseClient.js';

/** Gera uma cobrança PIX avulsa para o produto informado ('one_time' | 'irpf_simulation'). */
export async function criarPagamentoPix(product) {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(window.SIMPLIFEX_CONFIG.FN_CREATE_PIX_PAYMENT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ product }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Falha ao gerar PIX');
  return data; // { payment_id, qr_code, qr_code_base64, ticket_url, status }
}

/** Verifica no banco se o pagamento já foi aprovado (chame em polling após gerar o PIX). */
export async function verificarPagamento(paymentId) {
  const { data, error } = await supabase
    .from('one_time_purchases')
    .select('status, used_at')
    .eq('mp_payment_id', String(paymentId))
    .single();
  if (error) return null;
  return data;
}

/** Quantas utilizações aprovadas e não usadas o usuário tem para um produto. */
export async function utilizacoesDisponiveis(product) {
  const { data, error } = await supabase
    .from('one_time_purchases')
    .select('id')
    .eq('product', product)
    .eq('status', 'approved')
    .is('used_at', null);
  if (error) return 0;
  return data.length;
}

/** Consome 1 utilização de forma atômica. Retorna o id consumido, ou null se não havia disponível. */
export async function consumirUtilizacao(product) {
  const { data, error } = await supabase.rpc('usar_utilizacao', { p_product: product });
  if (error) throw error;
  return data;
}

/** Troca de plano (upgrade/downgrade) sem criar assinatura duplicada. */
export async function trocarPlano(novoPlanoId) {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(window.SIMPLIFEX_CONFIG.FN_CHANGE_SUBSCRIPTION, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ novo_plano_id: novoPlanoId }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || data.error || 'Falha ao trocar de plano');
  return data;
}

window.SimplifexPix = { criarPagamentoPix, verificarPagamento, utilizacoesDisponiveis, consumirUtilizacao };
window.SimplifexPlano = { trocarPlano };
