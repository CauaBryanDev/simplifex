// Simplifex — Edge Function: mp-webhook
// Recebe notificações do Mercado Pago (configuradas no painel de
// Webhooks/IPN da sua aplicação) quando uma assinatura (preapproval) muda
// de status, e sincroniza a tabela `assinaturas` no Supabase.
//
// Configure no Mercado Pago a URL:
//   https://SEU-PROJETO.functions.supabase.co/mp-webhook
// Eventos: "Assinaturas" (preapproval) e, opcionalmente, "Pagamentos".
//
// Segredos necessários:
//   MP_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MP_ACCESS_TOKEN = Deno.env.get('MP_ACCESS_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MP_STATUS_MAP: Record<string, string> = {
  authorized: 'authorized',
  pending: 'pending',
  paused: 'paused',
  cancelled: 'cancelled',
  expired: 'expired',
};

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    // O Mercado Pago envia o tipo tanto via query string quanto no corpo, dependendo do evento.
    const topic = url.searchParams.get('type') || url.searchParams.get('topic');
    const body = req.method === 'POST' ? await safeJson(req) : null;
    const resourceId = url.searchParams.get('id') || body?.data?.id || body?.id;

    if (!resourceId) {
      // Confirma recebimento mesmo sem dados úteis, para o MP não reenviar em loop.
      return new Response('ok', { status: 200 });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    if (topic === 'preapproval' || body?.entity === 'preapproval') {
      // Busca o estado atual e definitivo da assinatura direto na API do MP
      const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${resourceId}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const preapproval = await mpRes.json();
      if (!mpRes.ok) {
        console.error('Erro ao buscar preapproval:', preapproval);
        return new Response('erro ao consultar MP', { status: 200 }); // 200 evita retentativa infinita por erro nosso
      }

      const novoStatus = MP_STATUS_MAP[preapproval.status] || 'pending';

      await supabaseAdmin
          .from('assinaturas')
          .update({
            status: novoStatus,
            data_inicio: preapproval.date_created,
            data_proxima_cobranca: preapproval.next_payment_date || null,
          })
          .eq('mp_preapproval_id', preapproval.id);

      console.log(`Assinatura ${preapproval.id} atualizada para status "${novoStatus}"`);
    }

    if (topic === 'payment') {
      const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${resourceId}`, {
        headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
      });
      const payment = await mpRes.json();
      if (!mpRes.ok) {
        console.error('Erro ao buscar pagamento:', payment);
        return new Response('erro ao consultar pagamento', { status: 200 });
      }

      console.log(`Pagamento ${payment.id} — status: ${payment.status} — valor: ${payment.transaction_amount}`);

      // Pagamento avulso (PIX) de um produto one_time/irpf_simulation.
      // Idempotência: o UPDATE só afeta a linha se ela ainda estiver
      // "pending" — se o webhook chegar duplicado, a segunda chamada não
      // encontra nenhuma linha "pending" para atualizar e não faz nada,
      // então nunca liberamos 2 utilizações para o mesmo pagamento.
      if (payment.status === 'approved') {
        const { data: atualizados, error: updError } = await supabaseAdmin
            .from('one_time_purchases')
            .update({ status: 'approved' })
            .eq('mp_payment_id', String(payment.id))
            .eq('status', 'pending')
            .select('id, user_id, product');

        if (updError) {
          console.error('Erro ao aprovar compra avulsa:', updError);
        } else if (atualizados && atualizados.length > 0) {
          console.log(`Compra avulsa ${atualizados[0].id} (produto ${atualizados[0].product}) aprovada — 1 utilização liberada.`);
        } else {
          console.log(`Webhook duplicado ou pagamento ${payment.id} já processado — nenhuma ação repetida.`);
        }
      } else if (['cancelled', 'rejected'].includes(payment.status)) {
        await supabaseAdmin
            .from('one_time_purchases')
            .update({ status: 'cancelled' })
            .eq('mp_payment_id', String(payment.id))
            .eq('status', 'pending');
      }
    }

    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('Erro no webhook:', err);
    // Retorna 200 mesmo em erro interno para evitar reenvio agressivo do MP;
    // o erro fica registrado nos logs da function para investigação manual.
    return new Response('erro interno registrado', { status: 200 });
  }
});

async function safeJson(req: Request) {
  try { return await req.json(); } catch { return null; }
}