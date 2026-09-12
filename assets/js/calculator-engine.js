/**
 * Simplifex — Motor de Cálculo Fiscal
 * ------------------------------------------------------------------
 * Calcula ICMS (próprio + DIFAL), ISS e retenções na fonte (IRRF, INSS,
 * PIS/COFINS/CSLL) a partir das tabelas de alíquotas do Supabase.
 *
 * IMPORTANTE — leia antes de usar em produção:
 * Este motor aplica REGRAS GERAIS (Resolução SF 22/1989, LC 116/2003,
 * IN RFB 1.234/2012). Ele não substitui a análise de um contador para:
 *  - Substituição tributária (ICMS-ST) por NCM;
 *  - Benefícios fiscais/isenções específicas do seu estado ou município;
 *  - Enquadramentos especiais de serviço na lista da LC 116/2003;
 *  - Empresas fora do Simples Nacional.
 * Os valores retornados incluem `detalhe` com a memória de cálculo completa,
 * para auditoria.
 * ------------------------------------------------------------------
 */

import { supabase } from './supabaseClient.js';

/** Converte reais (float) para centavos (int) evitando erro de ponto flutuante. */
export function paraCentavos(valorReais) {
  return Math.round(Number(valorReais) * 100);
}
export function paraReais(valorCentavos) {
  return (valorCentavos / 100).toFixed(2);
}

/**
 * Calcula os impostos de uma operação de MERCADORIA (ICMS + DIFAL quando aplicável).
 *
 * @param {Object} p
 * @param {number} p.valorCentavos - valor da operação em centavos
 * @param {string} p.ufOrigem - UF do vendedor
 * @param {string} p.ufDestino - UF do comprador
 * @param {boolean} p.consumidorFinal - se o comprador é consumidor final (não revenda)
 * @param {boolean} p.contribuinteIcmsDestino - se o comprador é contribuinte de ICMS
 * @param {string} p.regimeTributario - 'MEI' | 'ME' | 'SIMPLES_NACIONAL'
 */
export async function calcularMercadoria({
                                           valorCentavos, ufOrigem, ufDestino, consumidorFinal = true,
                                           contribuinteIcmsDestino = false, regimeTributario = 'MEI'
                                         }) {
  const detalhe = { tipo: 'MERCADORIA', regras_aplicadas: [] };

  if (regimeTributario === 'MEI') {
    detalhe.regras_aplicadas.push(
        'MEI recolhe ICMS de forma unificada no DAS mensal fixo — o valor abaixo é uma REFERÊNCIA para precificação e organização financeira, não uma cobrança adicional por operação.'
    );
  }

  const mesmoEstado = ufOrigem === ufDestino;

  let icmsProprioCentavos = 0;
  let icmsDifalCentavos = 0;

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

    // DIFAL (EC 87/2015): só se o destinatário é consumidor final não-contribuinte
    // (ou contribuinte, com partilha — aqui tratamos o caso comum de e-commerce B2C).
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
          `DIFAL (EC 87/2015): ${interna.aliquota}% (interna destino) − ${inter.aliquota}% (interestadual) = ${diferencial.toFixed(2)}% sobre o valor, devido integralmente à UF de destino.`
      );
      detalhe.aliquota_difal = diferencial;
    } else if (contribuinteIcmsDestino) {
      detalhe.regras_aplicadas.push(
          'Destinatário é contribuinte de ICMS: DIFAL é partilhado conforme partilha vigente — calcule com seu contador para este caso.'
      );
    }
  }

  return { icmsProprioCentavos, icmsDifalCentavos, detalhe };
}

/**
 * Calcula o ISS de uma operação de SERVIÇO.
 */
export async function calcularServico({
                                        valorCentavos, municipioPrestacao, ufPrestacao, regimeTributario = 'MEI'
                                      }) {
  const detalhe = { tipo: 'SERVICO', regras_aplicadas: [] };

  if (regimeTributario === 'MEI') {
    detalhe.regras_aplicadas.push(
        'MEI recolhe ISS de forma unificada no DAS mensal fixo — nenhum ISS por operação foi calculado.'
    );
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
        `Município "${municipioPrestacao}/${ufPrestacao}" não cadastrado — usando alíquota padrão de 5% (teto da LC 116/2003). Cadastre a alíquota exata do seu município em Configurações.`
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
 * Calcula retenções na fonte (IRRF, INSS, PIS/COFINS/CSLL) para serviços
 * prestados a pessoa jurídica tomadora não optante do Simples.
 */
export async function calcularRetencoes({ valorCentavos, tipoServico, regimeTributario = 'MEI' }) {
  const detalhe = { regras_aplicadas: [] };

  if (regimeTributario === 'MEI') {
    detalhe.regras_aplicadas.push('MEI, em regra, não sofre retenção federal na fonte por prestação de serviço.');
    return { irrfCentavos: 0, inssCentavos: 0, pisCofinsCsllCentavos: 0, detalhe };
  }

  if (!tipoServico) {
    detalhe.regras_aplicadas.push('Tipo de serviço não informado — nenhuma retenção calculada.');
    return { irrfCentavos: 0, inssCentavos: 0, pisCofinsCsllCentavos: 0, detalhe };
  }

  const { data, error } = await supabase
      .from('regras_retencao_servico')
      .select('*')
      .eq('tipo_servico', tipoServico)
      .single();

  if (error || !data) {
    detalhe.regras_aplicadas.push(`Regra de retenção não encontrada para "${tipoServico}".`);
    return { irrfCentavos: 0, inssCentavos: 0, pisCofinsCsllCentavos: 0, detalhe };
  }

  if (valorCentavos < data.valor_minimo_retencao_centavos) {
    detalhe.regras_aplicadas.push(
        `Valor abaixo do mínimo de retenção (R$ ${paraReais(data.valor_minimo_retencao_centavos)}) — sem retenção.`
    );
    return { irrfCentavos: 0, inssCentavos: 0, pisCofinsCsllCentavos: 0, detalhe };
  }

  const irrfCentavos = Math.round(valorCentavos * (data.irrf_pct / 100));
  const inssCentavos = Math.round(valorCentavos * (data.inss_pct / 100));
  const pisCofinsCsllCentavos = Math.round(valorCentavos * (data.pis_cofins_csll_pct / 100));

  detalhe.regras_aplicadas.push(
      `${tipoServico}: IRRF ${data.irrf_pct}%, INSS ${data.inss_pct}%, PIS/COFINS/CSLL ${data.pis_cofins_csll_pct}%. ${data.observacao || ''}`
  );

  return { irrfCentavos, inssCentavos, pisCofinsCsllCentavos, detalhe };
}

/**
 * Orquestra o cálculo completo de uma transação e grava o resultado no Supabase
 * via RPC `registrar_calculo_imposto` (transacional, respeitando RLS).
 */
export async function calcularEGravarTransacao(transacao, perfil) {
  const regime = perfil?.regime_tributario || 'MEI';
  let resultado = {
    icmsProprioCentavos: 0, icmsDifalCentavos: 0, issCentavos: 0,
    irrfCentavos: 0, inssCentavos: 0, pisCofinsCsllCentavos: 0,
  };
  const detalheCompleto = { transacao_tipo: transacao.tipo, partes: [] };

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
  } else {
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
    resultado.pisCofinsCsllCentavos = rRet.pisCofinsCsllCentavos;
    detalheCompleto.partes.push(rRet.detalhe);
  }

  const { error } = await supabase.rpc('registrar_calculo_imposto', {
    p_transacao_id: transacao.id,
    p_icms_proprio: resultado.icmsProprioCentavos,
    p_icms_difal: resultado.icmsDifalCentavos,
    p_iss: resultado.issCentavos,
    p_irrf: resultado.irrfCentavos,
    p_inss: resultado.inssCentavos,
    p_pis_cofins_csll: resultado.pisCofinsCsllCentavos,
    p_detalhe: detalheCompleto,
  });
  if (error) throw error;

  const total = Object.values(resultado).reduce((a, b) => a + b, 0);
  return { ...resultado, totalCentavos: total, detalhe: detalheCompleto };
}