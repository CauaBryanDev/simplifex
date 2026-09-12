/**
 * Simplifex — Configuração pública do front-end.
 * NUNCA coloque aqui o Access Token do Mercado Pago nem a Service Role Key
 * do Supabase — essas ficam só nas Edge Functions (ambiente de servidor).
 */
window.SIMPLIFEX_CONFIG = {
  SUPABASE_URL: 'https://umtbatzuhjdlzaswaklr.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtdGJhdHp1aGpkbHphc3dha2xyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxNTkxMzEsImV4cCI6MjEwNDczNTEzMX0.BpITG3uoZDB1FHpZyx2778km6g1SlavJieMffR3r4kw',

  // Public Key do Mercado Pago (essa sim é pública, usada no SDK do front-end)
  MERCADOPAGO_PUBLIC_KEY: 'APP_USR-f0e252c5-e6ee-4f0b-b9a2-b46552e681f2',

  // URLs das Edge Functions do Supabase (após deploy)
  FN_CREATE_PREAPPROVAL: 'https://umtbatzuhjdlzaswaklr.functions.supabase.co/create-preapproval',
  FN_CANCEL_SUBSCRIPTION: 'https://umtbatzuhjdlzaswaklr.functions.supabase.co/cancel-subscription',
  FN_CHANGE_SUBSCRIPTION: 'https://umtbatzuhjdlzaswaklr.functions.supabase.co/change-subscription',
  FN_CREATE_PIX_PAYMENT: 'https://umtbatzuhjdlzaswaklr.functions.supabase.co/create-pix-payment',
};