/**
 * Simplifex — Configuração pública do front-end.
 * NUNCA coloque aqui o Access Token do Mercado Pago nem a Service Role Key
 * do Supabase — essas ficam só nas Edge Functions (ambiente de servidor).
 */
window.SIMPLIFEX_CONFIG = {
  SUPABASE_URL: 'https://SEU-PROJETO.supabase.co',
  SUPABASE_ANON_KEY: 'SUA_ANON_KEY_AQUI',

  // Public Key do Mercado Pago (essa sim é pública, usada no SDK do front-end)
  MERCADOPAGO_PUBLIC_KEY: 'SUA_PUBLIC_KEY_AQUI',

  // URLs das Edge Functions do Supabase (após deploy)
  FN_CREATE_PREAPPROVAL: 'https://SEU-PROJETO.functions.supabase.co/create-preapproval',
  FN_CANCEL_SUBSCRIPTION: 'https://SEU-PROJETO.functions.supabase.co/cancel-subscription',
};
