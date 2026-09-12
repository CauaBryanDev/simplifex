import { supabase } from './supabaseClient.js';
import { exigirSessao, perfilAtual, sair, assinaturaAtiva } from './auth.js';
import { calcularEGravarTransacao, paraCentavos, paraReais } from './calculator-engine.js';

let perfil = null;
let planoAtivo = null; // { plano_id, limite_transacoes_mes, data_proxima_cobranca } | null

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

async function init() {
  const user = await exigirSessao();
  if (!user) return;

  perfil = await perfilAtual();
  document.getElementById('user-nome').textContent = perfil?.nome_completo || user.email;
  document.getElementById('btn-sair')?.addEventListener('click', sair);

  preencherSelectsUF();
  await carregarBadgePlano();

  // O painel/fluxo de caixa (estatísticas, lançamento e histórico de
  // transações) é exclusivo de quem tem assinatura ativa — sem isso, mostra
  // uma tela de "assine para continuar" em vez do conteúdo.
  planoAtivo = await assinaturaAtiva();
  const areaLiberada = document.getElementById('painel-conteudo');
  const areaBloqueada = document.getElementById('painel-bloqueado');

  if (!planoAtivo) {
    if (areaLiberada) areaLiberada.style.display = 'none';
    if (areaBloqueada) areaBloqueada.style.display = '';
    return;
  }
  if (areaLiberada) areaLiberada.style.display = '';
  if (areaBloqueada) areaBloqueada.style.display = 'none';

  await carregarEstatisticas();
  await carregarTransacoes();
  await atualizarAvisoLimite();

  document.getElementById('form-transacao')?.addEventListener('submit', onSubmitTransacao);
  document.getElementById('tipo-transacao')?.addEventListener('change', alternarCamposTipo);
  alternarCamposTipo();
}

function preencherSelectsUF() {
  document.querySelectorAll('select[data-uf]').forEach(sel => {
    UFS.forEach(uf => {
      const opt = document.createElement('option');
      opt.value = uf; opt.textContent = uf;
      sel.appendChild(opt);
    });
  });
}

function alternarCamposTipo() {
  const tipo = document.getElementById('tipo-transacao')?.value;
  document.querySelectorAll('[data-campo="mercadoria"]').forEach(el => el.style.display = tipo === 'MERCADORIA' ? '' : 'none');
  document.querySelectorAll('[data-campo="servico"]').forEach(el => el.style.display = tipo === 'SERVICO' ? '' : 'none');
}

async function carregarBadgePlano() {
  const { data } = await supabase
    .from('assinaturas')
    .select('plano_id, status')
    .eq('user_id', perfil.id)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  const badge = document.getElementById('plan-badge');
  if (!badge) return;
  if (data && data.status === 'authorized') {
    badge.textContent = data.plano_id === 'mei' ? 'Plano MEI — ativo' : 'Plano ME — ativo';
    badge.classList.add('tag-seal');
  } else if (data && data.status === 'pending') {
    badge.textContent = 'Assinatura pendente de confirmação';
    badge.classList.add('tag-gold');
  } else {
    badge.textContent = 'Sem assinatura ativa';
    badge.classList.add('tag-stamp');
  }
}

/**
 * Mostra um aviso quando o plano MEI (limite de 200 transações/mês) está
 * perto do teto, incentivando o upgrade para o plano ME (ilimitado) —
 * conforme descrito na própria página de planos.
 */
async function atualizarAvisoLimite() {
  const avisoEl = document.getElementById('aviso-limite-plano');
  if (!avisoEl) return;

  if (!planoAtivo || planoAtivo.limite_transacoes_mes == null) {
    avisoEl.style.display = 'none';
    return;
  }

  const inicioMes = new Date();
  inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);
  const { count } = await supabase
    .from('transacoes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', perfil.id)
    .gte('criado_em', inicioMes.toISOString());

  const usadas = count || 0;
  const limite = planoAtivo.limite_transacoes_mes;
  const restantes = Math.max(0, limite - usadas);

  if (restantes === 0) {
    avisoEl.textContent = `Você atingiu o limite de ${limite} transações/mês do plano MEI. Faça upgrade para o plano ME (ilimitado) na aba Assinatura para continuar lançando.`;
    avisoEl.className = 'form-error';
    avisoEl.style.display = 'block';
  } else if (usadas >= limite * 0.9) {
    avisoEl.textContent = `Você já usou ${usadas} de ${limite} transações do plano MEI neste mês (restam ${restantes}). Considere o upgrade para o plano ME se for continuar crescendo.`;
    avisoEl.className = 'form-success';
    avisoEl.style.display = 'block';
  } else {
    avisoEl.style.display = 'none';
  }
}

async function carregarEstatisticas() {
  const inicioMes = new Date();
  inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);

  const { data: transacoes } = await supabase
    .from('transacoes')
    .select('id, valor_centavos, criado_em, impostos_calculados(total_impostos_centavos)')
    .eq('user_id', perfil.id)
    .gte('criado_em', inicioMes.toISOString());

  const qtd = transacoes?.length || 0;
  const faturamento = (transacoes || []).reduce((s, t) => s + t.valor_centavos, 0);
  const impostos = (transacoes || []).reduce((s, t) => s + (t.impostos_calculados?.[0]?.total_impostos_centavos || t.impostos_calculados?.total_impostos_centavos || 0), 0);

  setText('stat-qtd', qtd);
  setText('stat-faturamento', `R$ ${paraReais(faturamento)}`);
  setText('stat-impostos', `R$ ${paraReais(impostos)}`);
  setText('stat-aliquota', faturamento > 0 ? `${((impostos / faturamento) * 100).toFixed(1)}%` : '—');
}

async function carregarTransacoes() {
  const { data, error } = await supabase
    .from('transacoes')
    .select('*, impostos_calculados(*)')
    .eq('user_id', perfil.id)
    .order('criado_em', { ascending: false })
    .limit(25);

  const tbody = document.getElementById('tabela-transacoes-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (error || !data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--ink-soft);padding:32px;">Nenhuma transação lançada ainda. Use o formulário acima para registrar a primeira.</td></tr>`;
    return;
  }

  for (const t of data) {
    const imp = Array.isArray(t.impostos_calculados) ? t.impostos_calculados[0] : t.impostos_calculados;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(t.criado_em).toLocaleDateString('pt-BR')}</td>
      <td>${t.tipo === 'MERCADORIA' ? 'Mercadoria' : 'Serviço'}</td>
      <td>${escapeHtml(t.descricao || '—')}</td>
      <td>R$ ${paraReais(t.valor_centavos)}</td>
      <td>${imp ? `R$ ${paraReais(imp.total_impostos_centavos)}` : '<span class="tag tag-gold">calculando…</span>'}</td>
      <td>${statusTag(t.status)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function statusTag(status) {
  if (status === 'calculada') return '<span class="tag tag-seal">Calculada</span>';
  if (status === 'erro') return '<span class="tag tag-stamp">Erro</span>';
  return '<span class="tag tag-gold">Registrada</span>';
}

async function onSubmitTransacao(ev) {
  ev.preventDefault();
  const form = ev.target;
  const erroEl = document.getElementById('form-transacao-erro');
  const sucessoEl = document.getElementById('form-transacao-sucesso');
  erroEl.style.display = 'none'; sucessoEl.style.display = 'none';

  const tipo = form.tipo.value;
  const valorCentavos = paraCentavos(form.valor.value);

  const payload = {
    user_id: perfil.id,
    tipo,
    descricao: form.descricao.value,
    valor_centavos: valorCentavos,
    meio_pagamento: 'manual',
  };

  if (tipo === 'MERCADORIA') {
    payload.uf_origem = form.uf_origem.value;
    payload.uf_destino = form.uf_destino.value;
    payload.consumidor_final = form.consumidor_final.checked;
    payload.contribuinte_icms_destino = form.contribuinte_icms_destino.checked;
  } else {
    payload.uf_origem = form.uf_prestacao.value;
    payload.municipio_prestacao = form.municipio_prestacao.value;
    payload.tipo_servico = form.tipo_servico.value;
  }

  try {
    const { data: transacao, error } = await supabase
      .from('transacoes')
      .insert(payload)
      .select()
      .single();
    // O banco (trigger checar_limite_plano) recusa o insert se não houver
    // assinatura ativa, ou se o teto de transações/mês do plano foi atingido.
    if (error) throw error;

    const resultado = await calcularEGravarTransacao(transacao, perfil);

    sucessoEl.textContent = `Calculado: total de impostos R$ ${paraReais(resultado.totalCentavos)} sobre R$ ${form.valor.value}.`;
    sucessoEl.style.display = 'block';
    form.reset();
    alternarCamposTipo();
    await carregarEstatisticas();
    await carregarTransacoes();
    await atualizarAvisoLimite();
  } catch (err) {
    erroEl.textContent = 'Erro ao calcular: ' + err.message;
    erroEl.style.display = 'block';
  }
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

init();
