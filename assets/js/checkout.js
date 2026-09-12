import { supabase } from './supabaseClient.js';
import { exigirSessao } from './auth.js';

/**
 * Inicia a assinatura: chama a Edge Function `create-preapproval`, que fala
 * com o Mercado Pago usando o Access Token secreto (nunca exposto aqui), e
 * redireciona o usuário para a tela de autorização do Mercado Pago.
 */
export async function assinarPlano(planoId, botaoEl) {
  const user = await exigirSessao();
  if (!user) return;

  const original = botaoEl?.textContent;
  if (botaoEl) { botaoEl.disabled = true; botaoEl.textContent = 'Preparando checkout…'; }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const resp = await fetch(window.SIMPLIFEX_CONFIG.FN_CREATE_PREAPPROVAL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ plano_id: planoId }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      // ASSINATURA_JA_EXISTE (item 13): backend recusou criar uma segunda
      // assinatura — mostramos a mensagem amigável e mandamos para a troca de plano.
      if (data.error === 'ASSINATURA_JA_EXISTE') {
        alert(data.message + '\n\nVocê será levado para a tela de troca de plano.');
        window.location.href = '/assinatura.html';
        return;
      }
      throw new Error(data.message || data.error || 'Falha ao iniciar assinatura');
    }

    // Redireciona para o checkout hospedado do Mercado Pago
    window.location.href = data.init_point;
  } catch (err) {
    alert('Não foi possível iniciar a assinatura: ' + err.message);
    if (botaoEl) { botaoEl.disabled = false; botaoEl.textContent = original; }
  }
}

export async function cancelarAssinatura() {
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(window.SIMPLIFEX_CONFIG.FN_CANCEL_SUBSCRIPTION, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${session.access_token}` },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Falha ao cancelar assinatura');
  return data;
}

// Expõe globalmente para uso em onclick="" nas páginas estáticas
window.SimplifexCheckout = { assinarPlano, cancelarAssinatura };