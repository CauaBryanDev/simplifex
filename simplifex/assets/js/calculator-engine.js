/**
 * Simplifex — Motor de Cálculo Fiscal (v2)
 * ------------------------------------------------------------------
 * Calcula ICMS (próprio + DIFAL), ISS, retenções na fonte (IRRF/INSS) e
 * a estimativa federal (PIS, COFINS, IRPJ, CSLL) para TODO lançamento —
 * mercadoria ou serviço — usando as tabelas de alíquotas do Supabase.
 *
 * MUDANÇA IMPORTANTE (correção de bug): antes, lançamentos de usuários MEI
 * não calculavam ISS nem retenções (retornavam 0 direto). Isso fazia
 * "serviço" parecer quebrado. Agora TODO lançamento sempre calcula um valor
 * de referência — para MEI, o `detalhe` deixa explícito que é uma
 * ESTIMATIVA de organização financeira, já que o MEI recolhe via DAS fixo,
 * não por operação.
 *
 * IMPORTANTE — leia antes de usar em produção:
 * Este motor aplica REGRAS GERAIS (Resolução SF 22/1989, LC 116/2003,
 * IN RFB 1.234/2012, presunção de lucro para IRPJ/CSLL). Não substitui a
 * análise de um contador para: substituição tributária (ICMS-ST) por NCM,
 * benefícios fiscais locais, enquadramentos especiais de serviço, ou
 * apuração oficial (DAS, DASN-SIMEI, DEFIS).
 * ------------------------------------------------------------------
 */

import { supabase } from './supabaseClient.js';

export function paraCentavos(valorReais) {
  return Math.round(Number(valorReais) * 100);
}
export function paraReais(valorCentavos) {
  return ((valorCentavos || 0) / 100).toFixed(2);
}

let _cacheParametrosFederais = null;
async function getParametrosFederais() {
  if (_cacheParametrosFederais) return _cacheParametrosFederais;
  const { data, error } = await supabase.from('parametros_federais').select('chave, aliquota');
  if (error || !data) throw new Error('Não foi possível carregar parâmetros federais (PIS/COFINS/IRPJ/CSLL).');
  _cacheParametrosFederais = Object.fromEntries(data.map(r => [r.chave, Number(r.aliquota)]));
  return _cacheParametrosFederais;
}

/**
 * Calcula ICMS (próprio + DIFAL) de uma operação de MERCADORIA.
 * Sempre calcula — para MEI, o resultado é sinalizado como referência.
 */
export async function calcularMercadoria({
  valorCentavos, ufOrigem, ufDestino, consumidorFinal = true,
  contribuinteIcmsDestino = false, regimeTributario = 'MEI'
}) {
  const detalhe = { tipo: 'MERCADORIA', regras_aplicadas: [], estimativa: regimeTributario === 'MEI' };

  if (regimeTributario === 'MEI') {
    detalhe.regras_aplicadas.push(
      'MEI recolhe ICMS de forma unificada no DAS mensal fixo — o valor abaixo é uma ESTIMATIVA de referência para precificação, não uma cobrança adicional por operação.'
    );
  }

  const mesmoEstado = ufOrigem === ufDestino;
  let icmsProprioCentavos = 0;
  let icmsDifalCentavos = 0;

  if (!ufOrigem || !ufDestino) {
    detalhe.regras_aplicadas.push('UF de origem/destino não informada — ICMS não calculado.');
    return { icmsProprioCentavos, icmsDifalCentavos, detalhe };
  }

  if (mesmoEstado) {
    const { data, error } = await supabase
      .from('aliquotas_icms_interna')
      .select('aliquota')
      .eq('uf', ufOrigem)
      .single();
    if (error || !data) throw new Error(`Alíquota interna não encontrada para ${ufOrigem}`);

    icmsProprioCentavos = Math.round(valorCentavos * (data.aliquota / 100));
    detalhe.regras_aplicadas.push(`Operação interna em ${ufOrigem}: ICMS ${data.aliquota}%.`);
    detalhe.aliquota_interna = data.aliquota;
  } else {
    const { data: inter, error: e1 } = await supabase
      .from('aliquotas_icms_interestadual')
      .select('aliquota')
      .eq('uf_origem', ufOrigem)
      .eq('uf_destino', ufDestino)
      .single();
    if (e1 || !inter) throw new Error(`Alíquota interestadual não encontrada: ${ufOrigem} -> ${ufDestino}`);

    icmsProprioCentavos = Math.round(valorCentavos * (inter.aliquota / 100));
    detalhe.regras_aplicadas.push(
      `Operação interestadual ${ufOrigem} -> ${ufDestino}: ICMS próprio ${inter.aliquota}%.`
    );
    detalhe.aliquota_interestadual = inter.aliquota;

    if (consumidorFinal && !contribuinteIcmsDestino) {
      const { data: interna, error: e2 } = await supabase
        .from('aliquotas_icms_interna')
        .select('aliquota')
        .eq('uf', ufDestino)
        .single();
      if (e2 || !interna) throw new Error(`Alíquota interna de destino não encontrada para ${ufDestino}`);

      const diferencial = Math.max(0, interna.aliquota - inter.aliquota);
      icmsDifalCentavos = Math.round(valorCentavos * (diferencial / 100));
      detalhe.regras_aplicadas.push(
        `DIFAL (EC 87/2015): ${interna.aliquota}% (interna destino) − ${inter.aliquota}% (interestadual) = ${diferencial.toFixed(2)}%.`
      );
      detalhe.aliquota_difal = diferencial;
    } else if (contribuinteIcmsDestino) {
      detalhe.regras_aplicadas.push(
        'Destinatário é contribuinte de ICMS: DIFAL é partilhado conforme partilha vigente — confirme com seu contador.'
      );
    }
  }

  return { icmsProprioCentavos, icmsDifalCentavos, detalhe };
}

/**
 * Calcula o ISS de uma operação de SERVIÇO. Sempre calcula — para MEI, o
 * resultado é sinalizado como estimativa (correção do bug anterior, que
 * retornava 0 direto e fazia parecer que serviço não calculava nada).
 */
export async function calcularServico({
  valorCentavos, municipioPrestacao, ufPrestacao, regimeTributario = 'MEI'
}) {
  const detalhe = { tipo: 'SERVICO', regras_aplicadas: [], estimativa: regimeTributario === 'MEI' };

  if (regimeTributario === 'MEI') {
    detalhe.regras_aplicadas.push(
      'MEI recolhe ISS de forma unificada no DAS mensal fixo — o valor abaixo é uma ESTIMATIVA de referência.'
    );
  }

  if (!municipioPrestacao || !ufPrestacao) {
    detalhe.regras_aplicadas.push('Município/UF de prestação não informados — ISS não calculado.');
    return { issCentavos: 0, detalhe };
  }

  const { data, error } = await supabase
    .from('aliquotas_iss')
    .select('aliquota')
    .eq('municipio', municipioPrestacao)
    .eq('uf', ufPrestacao)
    .single();

  if (error || !data) {
    detalhe.regras_aplicadas.push(
      `Município "${municipioPrestacao}/${ufPrestacao}" não cadastrado — usando alíquota padrão de 5% (teto da LC 116/2003).`
    );
    const issCentavos = Math.round(valorCentavos * 0.05);
    return { issCentavos, detalhe };
  }

  const issCentavos = Math.round(valorCentavos * (data.aliquota / 100));
  detalhe.regras_aplicadas.push(`ISS de ${municipioPrestacao}/${ufPrestacao}: ${data.aliquota}%.`);
  detalhe.aliquota_iss = data.aliquota;
  return { issCentavos, detalhe };
}

/**
 * Retenções na fonte (IRRF/INSS) — só se aplicam a serviço prestado a PJ
 * tomadora fora do Simples. Continuam retornando 0 quando não há tipo de
 * serviço informado ou o valor é abaixo do mínimo — isso é regra tributária
 * real, não bug. Para MEI, sinalizamos como estimativa também.
 */
export async function calcularRetencoes({ valorCentavos, tipoServico, regimeTributario = 'MEI' }) {
  const detalhe = { regras_aplicadas: [], estimativa: regimeTributario === 'MEI' };

  if (!tipoServico) {
    detalhe.regras_aplicadas.push('Tipo de serviço não informado — nenhuma retenção calculada.');
    return { irrfCentavos: 0, inssCentavos: 0, detalhe };
  }

  const { data, error } = await supabase
    .from('regras_retencao_servico')
    .select('*')
    .eq('tipo_servico', tipoServico)
    .single();

  if (error || !data) {
    detalhe.regras_aplicadas.push(`Regra de retenção não encontrada para "${tipoServico}".`);
    return { irrfCentavos: 0, inssCentavos: 0, detalhe };
  }

  if (valorCentavos < data.valor_minimo_retencao_centavos) {
    detalhe.regras_aplicadas.push(
      `Valor abaixo do mínimo de retenção (R$ ${paraReais(data.valor_minimo_retencao_centavos)}) — sem retenção.`
    );
    return { irrfCentavos: 0, inssCentavos: 0, detalhe };
  }

  if (regimeTributario === 'MEI') {
    detalhe.regras_aplicadas.push('MEI, em regra, não sofre retenção federal — valor abaixo é apenas referência.');
  }

  const irrfCentavos = Math.round(valorCentavos * (data.irrf_pct / 100));
  const inssCentavos = Math.round(valorCentavos * (data.inss_pct / 100));

  detalhe.regras_aplicadas.push(
    `${tipoServico}: IRRF ${data.irrf_pct}%, INSS ${data.inss_pct}%. ${data.observacao || ''}`
  );

  return { irrfCentavos, inssCentavos, detalhe };
}

/**
 * Estimativa federal (PIS, COFINS, IRPJ, CSLL) — sempre calculada, com base
 * em presunção de lucro simplificada (referência Lucro Presumido). Isto é
 * o "Imposto federal estimado" que aparece no detalhamento do Dashboard.
 */
export async function calcularFederais({ valorCentavos, tipo }) {
  const params = await getParametrosFederais();
  const detalhe = { regras_aplicadas: [] };

  const pisCentavos = Math.round(valorCentavos * (params.PIS / 100));
  const cofinsCentavos = Math.round(valorCentavos * (params.COFINS / 100));

  const irpjPct = tipo === 'MERCADORIA' ? params.IRPJ_MERCADORIA : params.IRPJ;
  const csllPct = tipo === 'MERCADORIA' ? params.CSLL_MERCADORIA : params.CSLL;
  const irpjCentavos = Math.round(valorCentavos * (irpjPct / 100));
  const csllCentavos = Math.round(valorCentavos * (csllPct / 100));

  detalhe.regras_aplicadas.push(
    `Estimativa federal (Lucro Presumido): PIS ${params.PIS}%, COFINS ${params.COFINS}%, IRPJ ${irpjPct}%, CSLL ${csllPct}%.`
  );

  return { pisCentavos, cofinsCentavos, irpjCentavos, csllCentavos, detalhe };
}

/**
 * Orquestra o cálculo completo de uma transação (mercadoria OU serviço,
 * verificando o tipo) e grava via RPC v2, sempre com valores reais.
 */
export async function calcularEGravarTransacao(transacao, perfil) {
  const regime = perfil?.regime_tributario || 'MEI';
  let resultado = {
    icmsProprioCentavos: 0, icmsDifalCentavos: 0, issCentavos: 0,
    irrfCentavos: 0, inssCentavos: 0, pisCentavos: 0, cofinsCentavos: 0,
    irpjCentavos: 0, csllCentavos: 0,
  };
  const detalheCompleto = { transacao_tipo: transacao.tipo, partes: [] };

  // O TIPO do lançamento decide qual regra tributária roda — mercadoria
  // nunca usa a regra de serviço, e vice-versa.
  if (transacao.tipo === 'MERCADORIA') {
    const r = await calcularMercadoria({
      valorCentavos: transacao.valor_centavos,
      ufOrigem: transacao.uf_origem,
      ufDestino: transacao.uf_destino,
      consumidorFinal: transacao.consumidor_final,
      contribuinteIcmsDestino: transacao.contribuinte_icms_destino,
      regimeTributario: regime,
    });
    resultado.icmsProprioCentavos = r.icmsProprioCentavos;
    resultado.icmsDifalCentavos = r.icmsDifalCentavos;
    detalheCompleto.partes.push(r.detalhe);
  } else if (transacao.tipo === 'SERVICO') {
    const rIss = await calcularServico({
      valorCentavos: transacao.valor_centavos,
      municipioPrestacao: transacao.municipio_prestacao,
      ufPrestacao: transacao.uf_origem,
      regimeTributario: regime,
    });
    resultado.issCentavos = rIss.issCentavos;
    detalheCompleto.partes.push(rIss.detalhe);

    const rRet = await calcularRetencoes({
      valorCentavos: transacao.valor_centavos,
      tipoServico: transacao.tipo_servico,
      regimeTributario: regime,
    });
    resultado.irrfCentavos = rRet.irrfCentavos;
    resultado.inssCentavos = rRet.inssCentavos;
    detalheCompleto.partes.push(rRet.detalhe);
  } else {
    throw new Error(`Tipo de lançamento desconhecido: "${transacao.tipo}". Use MERCADORIA ou SERVICO.`);
  }

  // Estimativa federal roda para os dois tipos.
  const rFed = await calcularFederais({ valorCentavos: transacao.valor_centavos, tipo: transacao.tipo });
  resultado.pisCentavos = rFed.pisCentavos;
  resultado.cofinsCentavos = rFed.cofinsCentavos;
  resultado.irpjCentavos = rFed.irpjCentavos;
  resultado.csllCentavos = rFed.csllCentavos;
  detalheCompleto.partes.push(rFed.detalhe);

  const { error } = await supabase.rpc('registrar_calculo_imposto_v2', {
    p_transacao_id: transacao.id,
    p_icms_proprio: resultado.icmsProprioCentavos,
    p_icms_difal: resultado.icmsDifalCentavos,
    p_iss: resultado.issCentavos,
    p_irrf: resultado.irrfCentavos,
    p_inss: resultado.inssCentavos,
    p_pis: resultado.pisCentavos,
    p_cofins: resultado.cofinsCentavos,
    p_irpj: resultado.irpjCentavos,
    p_csll: resultado.csllCentavos,
    p_detalhe: detalheCompleto,
  });
  if (error) throw error;

  const total = resultado.icmsProprioCentavos + resultado.icmsDifalCentavos + resultado.issCentavos
    + resultado.irrfCentavos + resultado.inssCentavos + resultado.pisCentavos
    + resultado.cofinsCentavos + resultado.irpjCentavos + resultado.csllCentavos;

  return { ...resultado, totalCentavos: total, detalhe: detalheCompleto };
}
