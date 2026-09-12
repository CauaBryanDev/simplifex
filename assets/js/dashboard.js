import { supabase } from './supabaseClient.js';
import { exigirSessao, perfilAtual, sair } from './auth.js';
import { calcularEGravarTransacao, paraCentavos, paraReais } from './calculator-engine.js';

let perfil = null;
let transacaoEmEdicao = null; // id da transação sendo editada, ou null = criando nova
let chartComposicao = null, chartImpostos = null, chartFaturamento = null;

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

async function init() {
  // O Dashboard é gratuito para todo usuário autenticado — não há verificação
  // de assinatura aqui. A monetização fica só nas telas de recursos pagos
  // (recursos.html, irpf.html) e no gerenciamento de plano (assinatura.html).
  const user = await exigirSessao();
  if (!user) return;

  perfil = await perfilAtual();
  document.getElementById('user-nome').textContent = perfil?.nome_completo || user.email;

  preencherSelectsUF();
  await carregarBadgePlano();
  await carregarTudo();

  document.getElementById('btn-sair')?.addEventListener('click', sair);
  document.getElementById('form-transacao')?.addEventListener('submit', onSubmitTransacao);
  document.getElementById('tipo-transacao')?.addEventListener('change', alternarCamposTipo);
  document.getElementById('btn-cancelar-edicao')?.addEventListener('click', cancelarEdicao);
  document.getElementById('modal-detalhe-fechar')?.addEventListener('click', fecharModalDetalhe);
  alternarCamposTipo();
}

async function carregarTudo() {
  const transacoes = await buscarTransacoesDoMes();
  renderizarEstatisticas(transacoes);
  renderizarTabela(transacoes);
  renderizarGraficos(transacoes);
}

function preencherSelectsUF() {
  document.querySelectorAll('select[data-uf]').forEach(sel => {
    if (sel.dataset.preenchido) return;
    UFS.forEach(uf => {
      const opt = document.createElement('option');
      opt.value = uf; opt.textContent = uf;
      sel.appendChild(opt);
    });
    sel.dataset.preenchido = '1';
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
    badge.textContent = 'Painel gratuito — sem assinatura';
    badge.classList.add('tag-gold');
  }
}

/** Busca todos os lançamentos ATIVOS do mês corrente, já com os impostos calculados. */
async function buscarTransacoesDoMes() {
  const inicioMes = new Date();
  inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
      .from('transacoes')
      .select('*, impostos_calculados(*)')
      .eq('user_id', perfil.id)
      .eq('ativo', true)
      .gte('criado_em', inicioMes.toISOString())
      .order('criado_em', { ascending: false });

  if (error) { console.error(error); return []; }
  return (data || []).map(t => ({ ...t, _imp: Array.isArray(t.impostos_calculados) ? t.impostos_calculados[0] : t.impostos_calculados }));
}

function somaImpostos(imp) {
  if (!imp) return 0;
  return (imp.icms_proprio_centavos || 0) + (imp.icms_difal_centavos || 0) + (imp.iss_centavos || 0)
      + (imp.irrf_centavos || 0) + (imp.inss_centavos || 0) + (imp.pis_centavos || 0)
      + (imp.cofins_centavos || 0) + (imp.irpj_centavos || 0) + (imp.csll_centavos || 0);
}

function renderizarEstatisticas(transacoes) {
  const qtd = transacoes.length;
  const faturamento = transacoes.reduce((s, t) => s + t.valor_centavos, 0);
  const impostos = transacoes.reduce((s, t) => s + somaImpostos(t._imp), 0);
  const lucro = faturamento - impostos; // lucro estimado após impostos (não desconta despesas — ver nota na tela)
  const totalServicos = transacoes.filter(t => t.tipo === 'SERVICO').reduce((s, t) => s + t.valor_centavos, 0);
  const totalMercadorias = transacoes.filter(t => t.tipo === 'MERCADORIA').reduce((s, t) => s + t.valor_centavos, 0);

  setText('stat-qtd', qtd);
  setText('stat-faturamento', `R$ ${paraReais(faturamento)}`);
  setText('stat-impostos', `R$ ${paraReais(impostos)}`);
  setText('stat-lucro', `R$ ${paraReais(lucro)}`);
  setText('stat-aliquota', faturamento > 0 ? `${((impostos / faturamento) * 100).toFixed(1)}%` : '0.0%');
  setText('stat-total-servicos', `R$ ${paraReais(totalServicos)}`);
  setText('stat-total-mercadorias', `R$ ${paraReais(totalMercadorias)}`);
  setText('stat-valor-liquido', `R$ ${paraReais(lucro)}`);

  // Detalhamento agregado do período (usado também no modal "ver mais")
  const detalhado = {
    ISS: transacoes.reduce((s, t) => s + (t._imp?.iss_centavos || 0), 0),
    ICMS: transacoes.reduce((s, t) => s + (t._imp?.icms_proprio_centavos || 0) + (t._imp?.icms_difal_centavos || 0), 0),
    PIS: transacoes.reduce((s, t) => s + (t._imp?.pis_centavos || 0), 0),
    COFINS: transacoes.reduce((s, t) => s + (t._imp?.cofins_centavos || 0), 0),
    IRPJ: transacoes.reduce((s, t) => s + (t._imp?.irpj_centavos || 0), 0),
    CSLL: transacoes.reduce((s, t) => s + (t._imp?.csll_centavos || 0), 0),
    IRRF: transacoes.reduce((s, t) => s + (t._imp?.irrf_centavos || 0), 0),
    INSS: transacoes.reduce((s, t) => s + (t._imp?.inss_centavos || 0), 0),
  };
  renderizarDetalhamentoPeriodo(detalhado, impostos);
}

function renderizarDetalhamentoPeriodo(detalhado, total) {
  const container = document.getElementById('detalhamento-periodo');
  if (!container) return;
  const linhas = Object.entries(detalhado)
      .filter(([, valor]) => valor > 0)
      .map(([nome, valor]) => `
      <div class="receipt-row"><span>${nome}</span><span>R$ ${paraReais(valor)}</span></div>
    `).join('');

  container.innerHTML = linhas
      ? linhas + `<div class="receipt-row total"><span>Total</span><span>R$ ${paraReais(total)}</span></div>`
      : `<p style="color:var(--ink-soft);margin:0;">Nenhum imposto aplicável nos lançamentos deste mês ainda.</p>`;
}

function renderizarTabela(transacoes) {
  const tbody = document.getElementById('tabela-transacoes-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (transacoes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--ink-soft);padding:32px;">Nenhuma transação lançada ainda. Use o formulário acima para registrar a primeira.</td></tr>`;
    return;
  }

  for (const t of transacoes) {
    const imp = t._imp;
    const totalImp = somaImpostos(imp);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(t.criado_em).toLocaleDateString('pt-BR')}</td>
      <td>${t.tipo === 'MERCADORIA' ? 'Mercadoria' : 'Serviço'}</td>
      <td>${escapeHtml(t.descricao || '—')}</td>
      <td>R$ ${paraReais(t.valor_centavos)}</td>
      <td>${imp ? `R$ ${paraReais(totalImp)}` : '<span class="tag tag-gold">calculando…</span>'}</td>
      <td>${statusTag(t.status)}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost" data-acao="detalhar" data-id="${t.id}" style="padding:4px 10px;font-size:0.78rem;">Ver</button>
        <button class="btn btn-ghost" data-acao="editar" data-id="${t.id}" style="padding:4px 10px;font-size:0.78rem;">Editar</button>
        <button class="btn btn-stamp" data-acao="excluir" data-id="${t.id}" style="padding:4px 10px;font-size:0.78rem;">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('button[data-acao]').forEach(btn => {
    btn.addEventListener('click', () => onAcaoLinha(btn.dataset.acao, btn.dataset.id, transacoes));
  });
}

function statusTag(status) {
  if (status === 'calculada') return '<span class="tag tag-seal">Calculada</span>';
  if (status === 'erro') return '<span class="tag tag-stamp">Erro</span>';
  return '<span class="tag tag-gold">Registrada</span>';
}

async function onAcaoLinha(acao, id, transacoesCache) {
  const t = transacoesCache.find(x => x.id === id);
  if (!t) return;

  if (acao === 'detalhar') abrirModalDetalhe(t);
  if (acao === 'editar') iniciarEdicao(t);
  if (acao === 'excluir') await excluirTransacao(t);
}

// ---------------------------------------------------------------------------
// Modal de detalhamento de impostos por lançamento
// ---------------------------------------------------------------------------
function abrirModalDetalhe(t) {
  const modal = document.getElementById('modal-detalhe');
  const corpo = document.getElementById('modal-detalhe-corpo');
  if (!modal || !corpo) return;
  const imp = t._imp;

  const linhasImposto = [
    ['ICMS próprio', imp?.icms_proprio_centavos],
    ['ICMS DIFAL', imp?.icms_difal_centavos],
    ['ISS', imp?.iss_centavos],
    ['IRRF (retenção)', imp?.irrf_centavos],
    ['INSS (retenção)', imp?.inss_centavos],
    ['PIS', imp?.pis_centavos],
    ['COFINS', imp?.cofins_centavos],
    ['IRPJ', imp?.irpj_centavos],
    ['CSLL', imp?.csll_centavos],
  ].filter(([, v]) => v > 0);

  const memoria = (imp?.detalhe_json?.partes || [])
      .flatMap(p => p.regras_aplicadas || [])
      .map(r => `<li>${escapeHtml(r)}</li>`).join('');

  corpo.innerHTML = `
    <p style="margin-bottom:8px;"><strong>${escapeHtml(t.descricao || (t.tipo === 'MERCADORIA' ? 'Venda de mercadoria' : 'Prestação de serviço'))}</strong></p>
    <p style="margin-bottom:16px;color:var(--ink-soft);">Base de cálculo: R$ ${paraReais(t.valor_centavos)} · Alíquota efetiva: ${imp?.aliquota_efetiva_pct ?? 0}%</p>
    <div class="receipt" style="transform:none;">
      ${linhasImposto.map(([nome, valor]) => `<div class="receipt-row"><span>${nome}</span><span>R$ ${paraReais(valor)}</span></div>`).join('') || '<p style="margin:0;color:var(--ink-soft);">Nenhum imposto incidiu sobre este lançamento.</p>'}
      ${linhasImposto.length ? `<div class="receipt-row total"><span>Total</span><span>R$ ${paraReais(somaImpostos(imp))}</span></div>` : ''}
    </div>
    <p style="margin:16px 0 4px;font-weight:600;font-size:0.88rem;">Memória de cálculo</p>
    <ul style="font-size:0.85rem;color:var(--ink-soft);padding-left:18px;">${memoria || '<li>Sem detalhes registrados.</li>'}</ul>
    <p class="disclaimer">Valores estimados pelo Simplifex com base em regras gerais — não é uma apuração fiscal oficial.</p>
  `;
  modal.style.display = 'flex';
}
function fecharModalDetalhe() {
  const modal = document.getElementById('modal-detalhe');
  if (modal) modal.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Editar lançamento
// ---------------------------------------------------------------------------
function iniciarEdicao(t) {
  transacaoEmEdicao = t.id;
  const form = document.getElementById('form-transacao');
  form.tipo.value = t.tipo;
  alternarCamposTipo();
  form.valor.value = (t.valor_centavos / 100).toFixed(2);
  form.descricao.value = t.descricao || '';

  if (t.tipo === 'MERCADORIA') {
    form.uf_origem.value = t.uf_origem || '';
    form.uf_destino.value = t.uf_destino || '';
    form.consumidor_final.checked = !!t.consumidor_final;
    form.contribuinte_icms_destino.checked = !!t.contribuinte_icms_destino;
  } else {
    form.uf_prestacao.value = t.uf_origem || '';
    form.municipio_prestacao.value = t.municipio_prestacao || '';
    form.tipo_servico.value = t.tipo_servico || 'CONSULTORIA';
  }

  document.getElementById('form-transacao-titulo').textContent = 'Editar lançamento';
  document.getElementById('btn-salvar-transacao').textContent = 'Salvar alterações e recalcular';
  document.getElementById('btn-cancelar-edicao').style.display = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelarEdicao() {
  transacaoEmEdicao = null;
  document.getElementById('form-transacao').reset();
  alternarCamposTipo();
  document.getElementById('form-transacao-titulo').textContent = 'Lançar transação';
  document.getElementById('btn-salvar-transacao').textContent = 'Calcular e lançar';
  document.getElementById('btn-cancelar-edicao').style.display = 'none';
}

// ---------------------------------------------------------------------------
// Excluir (soft delete) lançamento
// ---------------------------------------------------------------------------
async function excluirTransacao(t) {
  if (!confirm(`Excluir o lançamento "${t.descricao || t.tipo}" de R$ ${paraReais(t.valor_centavos)}? Essa ação não pode ser desfeita pela interface.`)) return;
  try {
    const { error } = await supabase.rpc('excluir_transacao', { p_transacao_id: t.id });
    if (error) throw error;
    if (transacaoEmEdicao === t.id) cancelarEdicao();
    await carregarTudo();
  } catch (err) {
    alert('Erro ao excluir: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Criar/editar lançamento (o TIPO decide a regra tributária usada)
// ---------------------------------------------------------------------------
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
    payload.municipio_prestacao = null;
    payload.tipo_servico = null;
  } else {
    payload.uf_origem = form.uf_prestacao.value;
    payload.municipio_prestacao = form.municipio_prestacao.value;
    payload.tipo_servico = form.tipo_servico.value;
    payload.uf_destino = null;
  }

  try {
    let transacao;
    if (transacaoEmEdicao) {
      const { data, error } = await supabase
          .from('transacoes')
          .update(payload)
          .eq('id', transacaoEmEdicao)
          .select()
          .single();
      if (error) throw error;
      transacao = data;
    } else {
      const { data, error } = await supabase
          .from('transacoes')
          .insert(payload)
          .select()
          .single();
      if (error) throw error;
      transacao = data;
    }

    const resultado = await calcularEGravarTransacao(transacao, perfil);

    sucessoEl.textContent = `${transacaoEmEdicao ? 'Atualizado' : 'Calculado'}: total de impostos R$ ${paraReais(resultado.totalCentavos)} sobre R$ ${form.valor.value}.`;
    sucessoEl.style.display = 'block';
    cancelarEdicao();
    await carregarTudo();
  } catch (err) {
    erroEl.textContent = 'Erro ao calcular: ' + err.message;
    erroEl.style.display = 'block';
  }
}

// ---------------------------------------------------------------------------
// Gráficos (Chart.js, carregado via CDN no dashboard.html)
// ---------------------------------------------------------------------------
function renderizarGraficos(transacoes) {
  if (typeof Chart === 'undefined') return; // Chart.js não carregou (ex: offline)

  const faturamento = transacoes.reduce((s, t) => s + t.valor_centavos, 0);
  const impostos = transacoes.reduce((s, t) => s + somaImpostos(t._imp), 0);
  const lucro = Math.max(0, faturamento - impostos);

  // Gráfico 1 — Faturamento x Lucro x Impostos (composição, não soma dupla)
  const ctx1 = document.getElementById('chart-composicao');
  if (ctx1) {
    chartComposicao?.destroy();
    chartComposicao = new Chart(ctx1, {
      type: 'pie',
      data: {
        labels: ['Lucro (após impostos)', 'Impostos'],
        datasets: [{ data: [lucro / 100, impostos / 100], backgroundColor: ['#2E6F4C', '#B5482F'] }],
      },
      options: { plugins: { legend: { position: 'bottom' } } },
    });
  }

  // Gráfico 2 — Composição dos impostos (só categorias com valor > 0)
  const somaPor = campo => transacoes.reduce((s, t) => s + (t._imp?.[campo] || 0), 0);
  const categorias = [
    ['ISS', somaPor('iss_centavos')],
    ['ICMS', somaPor('icms_proprio_centavos') + somaPor('icms_difal_centavos')],
    ['PIS', somaPor('pis_centavos')],
    ['COFINS', somaPor('cofins_centavos')],
    ['IRPJ', somaPor('irpj_centavos')],
    ['CSLL', somaPor('csll_centavos')],
    ['IRRF', somaPor('irrf_centavos')],
    ['INSS', somaPor('inss_centavos')],
  ].filter(([, v]) => v > 0);

  const ctx2 = document.getElementById('chart-impostos');
  if (ctx2) {
    chartImpostos?.destroy();
    if (categorias.length > 0) {
      chartImpostos = new Chart(ctx2, {
        type: 'pie',
        data: {
          labels: categorias.map(c => c[0]),
          datasets: [{ data: categorias.map(c => c[1] / 100), backgroundColor: ['#2E6F4C','#B5482F','#C99A3F','#1C2B3A','#33475C','#8E3521','#D8D0BC','#6f8f7d'] }],
        },
        options: { plugins: { legend: { position: 'bottom' } } },
      });
    }
  }

  // Gráfico 3 — Faturamento por categoria (mercadoria x serviço)
  const totalServicos = transacoes.filter(t => t.tipo === 'SERVICO').reduce((s, t) => s + t.valor_centavos, 0);
  const totalMercadorias = transacoes.filter(t => t.tipo === 'MERCADORIA').reduce((s, t) => s + t.valor_centavos, 0);
  const ctx3 = document.getElementById('chart-faturamento');
  if (ctx3) {
    chartFaturamento?.destroy();
    chartFaturamento = new Chart(ctx3, {
      type: 'pie',
      data: {
        labels: ['Mercadorias', 'Serviços'],
        datasets: [{ data: [totalMercadorias / 100, totalServicos / 100], backgroundColor: ['#C99A3F', '#1C2B3A'] }],
      },
      options: { plugins: { legend: { position: 'bottom' } } },
    });
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