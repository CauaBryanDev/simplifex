import { supabase } from './supabaseClient.js';
import { exigirSessao } from './auth.js';

export const LIMITE_TRANSACOES_MEI = 200;
export const TETO_ANUAL_MEI_CENTAVOS = 8100000; // R$ 81.000,00/ano — teto de faturamento do MEI

/** Busca a assinatura REALMENTE ativa (paga e confirmada) do usuário, ou null. */
export async function obterAssinaturaAtiva(userId) {
    const { data } = await supabase
        .from('assinaturas')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'authorized')
        .order('criado_em', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data || null;
}

/**
 * Exige sessão + assinatura ativa. Se não houver uma das duas, redireciona
 * para a página certa e retorna null (a página que chamou deve parar a
 * própria execução quando receber null).
 */
export async function exigirAssinaturaAtiva(motivo = 'painel') {
    const user = await exigirSessao();
    if (!user) return null; // exigirSessao já redirecionou para /login.html

    const assinatura = await obterAssinaturaAtiva(user.id);
    if (!assinatura) {
        window.location.href = `/assinatura.html?bloqueado=${encodeURIComponent(motivo)}`;
        return null;
    }
    return { user, assinatura };
}

/** Conta quantas transações ATIVAS o usuário já lançou no mês corrente. */
export async function contarTransacoesDoMes(userId) {
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);
    const { count } = await supabase
        .from('transacoes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('ativo', true)
        .gte('criado_em', inicioMes.toISOString());
    return count || 0;
}

/** Soma o faturamento (transações ativas) do ANO corrente — para o alerta de teto do MEI. */
export async function faturamentoDoAno(userId) {
    const inicioAno = new Date(new Date().getFullYear(), 0, 1);
    const { data } = await supabase
        .from('transacoes')
        .select('valor_centavos')
        .eq('user_id', userId)
        .eq('ativo', true)
        .gte('criado_em', inicioAno.toISOString());
    return (data || []).reduce((s, t) => s + t.valor_centavos, 0);
}