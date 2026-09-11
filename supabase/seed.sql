-- ============================================================================
-- SIMPLIFEX — Seed de alíquotas de referência
-- IMPORTANTE: valores de regra geral (Resolução SF 22/1989 e LC 116/2003).
-- Revise/ajuste por produto (NCM) e município conforme sua operação real.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ICMS interna por UF (alíquota "cheia" do estado, regra geral — varia por NCM)
-- ----------------------------------------------------------------------------
insert into public.aliquotas_icms_interna (uf, aliquota) values
('AC',19),('AL',19),('AP',18),('AM',20),('BA',19),('CE',18),('DF',18),('ES',17),
('GO',17),('MA',20),('MT',17),('MS',17),('MG',18),('PA',19),('PB',18),('PR',19.5),
('PE',18),('PI',21),('RJ',20),('RN',18),('RS',17),('RO',19.5),('RR',20),('SC',17),
('SP',18),('SE',19),('TO',18)
on conflict (uf) do update set aliquota = excluded.aliquota;

-- ----------------------------------------------------------------------------
-- ICMS interestadual (regra geral Resolução SF 22/1989):
--   Origem Sul/Sudeste (exceto ES) -> Norte/Nordeste/Centro-Oeste/ES = 7%
--   Demais operações interestaduais = 12%
--   Produtos importados/conteúdo import. > 40% = 4% (não tratado aqui, ver NCM)
-- ----------------------------------------------------------------------------
do $$
declare
  sul_sudeste char(2)[] := array['SP','RJ','MG','PR','SC','RS'];
  norte_nordeste_co_es char(2)[] := array['AC','AL','AP','AM','BA','CE','DF','ES','GO',
                                            'MA','MT','MS','PA','PB','PE','PI','RN','RO','RR','SE','TO'];
  todas char(2)[] := array['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
                             'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
  o char(2); d char(2);
begin
  foreach o in array todas loop
    foreach d in array todas loop
      if o <> d then
        insert into public.aliquotas_icms_interestadual (uf_origem, uf_destino, aliquota, observacao)
        values (
          o, d,
          case
            when o = any(sul_sudeste) and d = any(norte_nordeste_co_es) then 7.00
            else 12.00
          end,
          'Regra geral Resolução SF 22/1989 — não considera exceções por NCM/importados'
        )
        on conflict (uf_origem, uf_destino) do update set aliquota = excluded.aliquota;
      end if;
    end loop;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- ISS — capitais (alíquota do prestador, regra geral entre o piso de 2% (CF/LC116)
-- e o teto de 5%). AJUSTE conforme a lei municipal do seu cliente.
-- ----------------------------------------------------------------------------
insert into public.aliquotas_iss (municipio, uf, aliquota) values
('São Paulo','SP',5.00),
('Rio de Janeiro','RJ',5.00),
('Belo Horizonte','MG',5.00),
('Curitiba','PR',5.00),
('Porto Alegre','RS',4.50),
('Florianópolis','SC',5.00),
('Salvador','BA',5.00),
('Recife','PE',5.00),
('Fortaleza','CE',5.00),
('Brasília','DF',5.00),
('Goiânia','GO',5.00),
('Campinas','SP',5.00),
('Ribeirão das Neves','MG',3.00),
('Manaus','AM',5.00),
('Vitória','ES',5.00)
on conflict (municipio, uf) do update set aliquota = excluded.aliquota;

-- ----------------------------------------------------------------------------
-- Retenções na fonte por tipo de serviço (regra geral — Lei 9.711/98, IN RFB
-- 1.234/2012, Lei 10.833/2003). Retenção federal (IRRF/PIS/COFINS/CSLL) só se
-- aplica, em regra, quando o TOMADOR é pessoa jurídica de direito privado que
-- não seja optante do Simples e o valor supera o mínimo de R$ 10,00/serviço.
-- ----------------------------------------------------------------------------
insert into public.regras_retencao_servico (tipo_servico, irrf_pct, inss_pct, pis_cofins_csll_pct, valor_minimo_retencao_centavos, observacao) values
('LIMPEZA_CONSERVACAO', 1.00, 11.00, 4.65, 1000, 'Cessão de mão de obra — retenção de INSS de 11% sobre a NF'),
('VIGILANCIA_SEGURANCA', 1.00, 11.00, 4.65, 1000, 'Cessão de mão de obra — retenção de INSS de 11% sobre a NF'),
('CONSTRUCAO_CIVIL', 1.50, 11.00, 4.65, 1000, 'Empreitada com cessão de mão de obra'),
('CONSULTORIA', 1.50, 0.00, 4.65, 1000, 'Serviço profissional — sem cessão de mão de obra'),
('TECNOLOGIA_TI', 1.50, 0.00, 4.65, 1000, 'Desenvolvimento/suporte de TI'),
('TRANSPORTE', 1.00, 0.00, 4.65, 1000, 'Transporte de cargas/valores'),
('OUTROS_SERVICOS', 1.50, 0.00, 4.65, 1000, 'Fallback genérico — confirme com contador para NCM/serviço específico')
on conflict (tipo_servico) do update set
  irrf_pct = excluded.irrf_pct,
  inss_pct = excluded.inss_pct,
  pis_cofins_csll_pct = excluded.pis_cofins_csll_pct,
  valor_minimo_retencao_centavos = excluded.valor_minimo_retencao_centavos,
  observacao = excluded.observacao;

-- NOTA: MEI, em regra, NÃO sofre a maioria dessas retenções federais e não é
-- contribuinte normal de ICMS/ISS (recolhe via DAS fixo). Este motor calcula
-- o imposto "cheio" como referência de precificação e para empresas ME que já
-- saíram do Simples/MEI; a interface sinaliza isso ao usuário MEI.
