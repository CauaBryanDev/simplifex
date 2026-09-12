import { supabase } from './supabaseClient.js';
import { exigirSessao, perfilAtual, sair } from './auth.js';
import { paraCentavos, paraReais } from './calculator-engine.js';

let perfil = null;
let movimentoEmEdicao = null;
let chartFluxo = null;

async function init() {
  const user = await exigirSessao();
  if (!user) return;
  perfil = await perfilAtual();
  document.getElementById('user-nome').textContent = perfil?.nome_completo || user.email;
  document.getElementById('btn-sair').addEventListener('click', sair);

  document.getElementById('data-movimento').value = new Date().toISOString().slice(0, 10);
  document.getElementById('form-movimento').addEventListener('submit', onSubmitMovimento);
  document.getElementById('btn-cancelar-edicao-mov').addEventListener('click', cancelarEdicao);
  document.getElementById('tipo-movimento').addEventListener('change', atualizarCategorias);
  atualizarCategorias();

  await carregarTudo();
}

function atualizarCategorias() {
  const tipo = document.getElementById('tipo-movimento').value;
  const sel = document.getElementById('categoria-movimento');
  const opcoes = tipo === 'entrada'
    ? [['aporte', 'Aporte / capital próprio'], ['outra_entrada', 'Outra entrada']]
    : [['retirada', 'Retirada / pró-labore'], ['despesa', 'Despesa operacional'], ['outra_saida', 'Outra saída']];
  sel.innerHTML = opcoes.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
}

async function carregarTudo() {
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('movimentos_caixa')
    .select('*')
    .eq('user_id', perfil.id)
    .eq('ativo', true)
    .gte('data_movimento', inicioMes.toISOString().slice(0, 10))
    .order('data_movimento', { ascending: true });

  if (error) { console.error(error); return; }
  renderizarStats(data || []);
  renderizarTabela(data || []);
  renderizarGraficoFluxo(data || []);
}

function renderizarStats(movs) {
  const entradas = movs.filter(m => m.tipo === 'entrada').reduce((s, m) => s + m.valor_centavos, 0);
  const saidas = movs.filter(m => m.tipo === 'saida').reduce((s, m) => s + m.valor_centavos, 0);
  const impostosReservados = movs.filter(m => m.categoria === 'imposto_reservado').reduce((s, m) => s + m.valor_centavos, 0);
  const saldo = entradas - saidas;

  setText('caixa-saldo', `R$ ${paraReais(saldo)}`);
  setText('caixa-entradas', `R$ ${paraReais(entradas)}`);
  setText('caixa-saidas', `R$ ${paraReais(saidas)}`);
  setText('caixa-impostos-reservados', `R$ ${paraReais(impostosReservados)}`);
}

function renderizarGraficoFluxo(movs) {
  if (typeof Chart === 'undefined') return;

  // Saldo acumulado dia a dia, do dia 1 até o último movimento do mês.
  const porDia = {};
  movs.forEach(m => {
    const sinal = m.tipo === 'entrada' ? 1 : -1;
    porDia[m.data_movimento] = (porDia[m.data_movimento] || 0) + sinal * m.valor_centavos;
  });
  const dias = Object.keys(porDia).sort();
  let acumulado = 0;
  const labels = [];
  const valores = [];
  dias.forEach(d => {
    acumulado += porDia[d];
    labels.push(new Date(d + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }));
    valores.push(acumulado / 100);
  });

  const ctx = document.getElementById('chart-fluxo-caixa');
  if (!ctx) return;
  chartFluxo?.destroy();
  chartFluxo = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Saldo acumulado (R$)',
        data: valores,
        borderColor: '#2E6F4C',
        backgroundColor: 'rgba(46,111,76,0.12)',
        fill: true,
        tension: 0.25,
        pointRadius: 3,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { ticks: { callback: v => `R$ ${v}` } } },
    },
  });
}

function renderizarTabela(movs) {
  const tbody = document.getElementById('tabela-caixa-body');
  if (movs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--ink-soft);padding:32px;">Nenhum movimento este mês ainda.</td></tr>`;
    return;
  }

  const CATEGORIAS_LABEL = {
    MERCADORIA: 'Venda de mercadoria', SERVICO: 'Prestação de serviço',
    imposto_reservado: 'Imposto reservado', aporte: 'Aporte', retirada: 'Retirada',
    despesa: 'Despesa', outra_entrada: 'Outra entrada', outra_saida: 'Outra saída',
  };

  tbody.innerHTML = [...movs].reverse().map(m => `
    <tr>
      <td>${new Date(m.data_movimento + 'T00:00:00').toLocaleDateString('pt-BR')}</td>
      <td>${m.tipo === 'entrada' ? '<span class="tag tag-seal">Entrada</span>' : '<span class="tag tag-stamp">Saída</span>'}</td>
      <td>${CATEGORIAS_LABEL[m.categoria] || m.categoria}</td>
      <td>${escapeHtml(m.descricao || '—')}</td>
      <td class="num">R$ ${paraReais(m.valor_centavos)}</td>
      <td>
        ${m.origem === 'manual'
          ? `<button class="btn btn-ghost" data-acao="editar" data-id="${m.id}" style="padding:4px 10px;font-size:0.78rem;">Editar</button>
             <button class="btn btn-stamp" data-acao="excluir" data-id="${m.id}" style="padding:4px 10px;font-size:0.78rem;">Excluir</button>`
          : `<span class="tag tag-gold">Automático</span>`}
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('button[data-acao]').forEach(btn => {
    btn.addEventListener('click', () => onAcao(btn.dataset.acao, btn.dataset.id, movs));
  });
}

function onAcao(acao, id, movsCache) {
  const m = movsCache.find(x => x.id === id);
  if (!m) return;
  if (acao === 'editar') iniciarEdicao(m);
  if (acao === 'excluir') excluirMovimento(m);
}

function iniciarEdicao(m) {
  movimentoEmEdicao = m.id;
  const form = document.getElementById('form-movimento');
  form.tipo.value = m.tipo;
  atualizarCategorias();
  form.categoria.value = m.categoria;
  form.descricao.value = m.descricao || '';
  form.valor.value = (m.valor_centavos / 100).toFixed(2);
  form.data.value = m.data_movimento;
  document.getElementById('btn-salvar-movimento').textContent = 'Salvar alteração';
  document.getElementById('btn-cancelar-edicao-mov').style.display = '';
  form.scrollIntoView({ behavior: 'smooth' });
}

function cancelarEdicao() {
  movimentoEmEdicao = null;
  document.getElementById('form-movimento').reset();
  document.getElementById('data-movimento').value = new Date().toISOString().slice(0, 10);
  atualizarCategorias();
  document.getElementById('btn-salvar-movimento').textContent = 'Lançar movimento';
  document.getElementById('btn-cancelar-edicao-mov').style.display = 'none';
}

async function excluirMovimento(m) {
  if (!confirm(`Excluir "${m.descricao || m.categoria}" de R$ ${paraReais(m.valor_centavos)}?`)) return;
  try {
    const { error } = await supabase.rpc('excluir_movimento_caixa', { p_id: m.id });
    if (error) throw error;
    if (movimentoEmEdicao === m.id) cancelarEdicao();
    await carregarTudo();
  } catch (err) {
    alert('Erro ao excluir: ' + err.message);
  }
}

async function onSubmitMovimento(ev) {
  ev.preventDefault();
  const form = ev.target;
  const erroEl = document.getElementById('form-movimento-erro');
  erroEl.style.display = 'none';

  const payload = {
    user_id: perfil.id,
    tipo: form.tipo.value,
    categoria: form.categoria.value,
    descricao: form.descricao.value,
    valor_centavos: paraCentavos(form.valor.value),
    data_movimento: form.data.value,
    origem: 'manual',
  };

  try {
    if (movimentoEmEdicao) {
      const { error } = await supabase.from('movimentos_caixa').update(payload).eq('id', movimentoEmEdicao);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('movimentos_caixa').insert(payload);
      if (error) throw error;
    }
    cancelarEdicao();
    await carregarTudo();
  } catch (err) {
    erroEl.textContent = 'Erro ao salvar: ' + err.message;
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
