-- ============================================================================
-- SIMPLIFEX — Migration 002: dashboard gratuito, impostos detalhados,
-- edição/exclusão de lançamentos, pagamentos avulsos PIX e troca de plano.
-- Rode este arquivo INTEIRO no SQL Editor do Supabase, depois do schema.sql
-- e seed.sql originais. É aditivo: não apaga nem recria tabelas existentes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. LANÇAMENTOS: soft delete + edição rastreável
-- ----------------------------------------------------------------------------
alter table public.transacoes
  add column if not exists ativo boolean not null default true,
  add column if not exists atualizado_em timestamptz not null default now();

drop trigger if exists trg_transacoes_updated on public.transacoes;
create trigger trg_transacoes_updated before update on public.transacoes
  for each row execute procedure public.set_atualizado_em();

-- Índice para as consultas do dashboard (só lançamentos ativos, por período)
create index if not exists idx_transacoes_user_ativo
  on public.transacoes (user_id, ativo, criado_em desc);

-- ----------------------------------------------------------------------------
-- 2. IMPOSTOS DETALHADOS: separa PIS, COFINS, IRPJ e CSLL
-- (antes só existia um campo somado "pis_cofins_csll_centavos")
-- ----------------------------------------------------------------------------
alter table public.impostos_calculados
  add column if not exists pis_centavos integer not null default 0,
  add column if not exists cofins_centavos integer not null default 0,
  add column if not exists irpj_centavos integer not null default 0,
  add column if not exists csll_centavos integer not null default 0;
-- Mantemos a coluna antiga (pis_cofins_csll_centavos) por compatibilidade;
-- ela deixa de ser usada a partir desta migration.

-- ----------------------------------------------------------------------------
-- 3. Parâmetros federais de referência (PIS/COFINS/IRPJ/CSLL) — configuráveis,
--    não são "verdade absoluta": servem de estimativa para ME/Simples.
-- ----------------------------------------------------------------------------
create table if not exists public.parametros_federais (
  chave text primary key,
  aliquota numeric(6,3) not null,
  descricao text
);

insert into public.parametros_federais (chave, aliquota, descricao) values
  ('PIS', 0.65, 'PIS cumulativo — referência Lucro Presumido'),
  ('COFINS', 3.00, 'COFINS cumulativo — referência Lucro Presumido'),
  ('IRPJ', 4.80, 'IRPJ estimado sobre serviços — 32% de presunção x 15%'),
  ('CSLL', 2.88, 'CSLL estimado sobre serviços — 32% de presunção x 9%'),
  ('IRPJ_MERCADORIA', 1.20, 'IRPJ estimado sobre mercadorias — 8% de presunção x 15%'),
  ('CSLL_MERCADORIA', 1.08, 'CSLL estimado sobre mercadorias — 12% de presunção x 9%')
on conflict (chave) do nothing;

alter table public.parametros_federais enable row level security;
create policy "parametros_leitura_publica" on public.parametros_federais for select using (true);

-- ----------------------------------------------------------------------------
-- 4. RPC v2: grava o cálculo já com PIS/COFINS/IRPJ/CSLL separados
-- ----------------------------------------------------------------------------
create or replace function public.registrar_calculo_imposto_v2(
  p_transacao_id uuid,
  p_icms_proprio integer,
  p_icms_difal integer,
  p_iss integer,
  p_irrf integer,
  p_inss integer,
  p_pis integer,
  p_cofins integer,
  p_irpj integer,
  p_csll integer,
  p_detalhe jsonb
) returns void as $$
declare
  v_total integer;
  v_valor integer;
  v_owner uuid;
begin
  select user_id, valor_centavos into v_owner, v_valor from public.transacoes where id = p_transacao_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'Transação não encontrada ou não pertence ao usuário autenticado';
  end if;

  v_total := coalesce(p_icms_proprio,0) + coalesce(p_icms_difal,0) + coalesce(p_iss,0)
             + coalesce(p_irrf,0) + coalesce(p_inss,0) + coalesce(p_pis,0)
             + coalesce(p_cofins,0) + coalesce(p_irpj,0) + coalesce(p_csll,0);

  insert into public.impostos_calculados (
    transacao_id, icms_proprio_centavos, icms_difal_centavos, iss_centavos,
    irrf_centavos, inss_centavos, pis_centavos, cofins_centavos, irpj_centavos, csll_centavos,
    total_impostos_centavos, aliquota_efetiva_pct, detalhe_json
  ) values (
    p_transacao_id, p_icms_proprio, p_icms_difal, p_iss,
    p_irrf, p_inss, p_pis, p_cofins, p_irpj, p_csll,
    v_total,
    case when v_valor > 0 then round((v_total::numeric / v_valor) * 100, 3) else 0 end,
    p_detalhe
  )
  on conflict (transacao_id) do update set
    icms_proprio_centavos = excluded.icms_proprio_centavos,
    icms_difal_centavos = excluded.icms_difal_centavos,
    iss_centavos = excluded.iss_centavos,
    irrf_centavos = excluded.irrf_centavos,
    inss_centavos = excluded.inss_centavos,
    pis_centavos = excluded.pis_centavos,
    cofins_centavos = excluded.cofins_centavos,
    irpj_centavos = excluded.irpj_centavos,
    csll_centavos = excluded.csll_centavos,
    total_impostos_centavos = excluded.total_impostos_centavos,
    aliquota_efetiva_pct = excluded.aliquota_efetiva_pct,
    detalhe_json = excluded.detalhe_json,
    calculado_em = now();

  update public.transacoes set status = 'calculada' where id = p_transacao_id;
end;
$$ language plpgsql security definer;

-- ----------------------------------------------------------------------------
-- 5. Soft delete de lançamento (mantém histórico, some do Dashboard)
-- ----------------------------------------------------------------------------
create or replace function public.excluir_transacao(p_transacao_id uuid)
returns void as $$
declare
  v_owner uuid;
begin
  select user_id into v_owner from public.transacoes where id = p_transacao_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'Transação não encontrada ou não pertence ao usuário autenticado';
  end if;
  update public.transacoes set ativo = false where id = p_transacao_id;
end;
$$ language plpgsql security definer;

-- ----------------------------------------------------------------------------
-- 6. PAGAMENTOS AVULSOS (PIX) — sem assinatura, 1 pagamento = 1 utilização
-- ----------------------------------------------------------------------------
create table if not exists public.one_time_purchases (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users (id) on delete cascade,
  product text not null check (product in ('one_time', 'irpf_simulation')),
  amount_centavos integer not null,
  status text not null default 'pending'
    check (status in ('pending','approved','cancelled','refunded')),
  mp_payment_id text unique,
  used_at timestamptz,
  criado_em timestamptz not null default now()
);

create index if not exists idx_one_time_purchases_user on public.one_time_purchases (user_id, product, status);

alter table public.one_time_purchases enable row level security;
create policy "one_time_purchases_dono_select" on public.one_time_purchases
  for select using (auth.uid() = user_id);
-- Inserção/atualização feita só pelas Edge Functions (service role) — sem policy de insert/update para o cliente.

-- Preço é decidido no SERVIDOR (edge function), nunca confiar no valor vindo do navegador.
create table if not exists public.precos_produtos (
  product text primary key,
  preco_centavos integer not null,
  descricao text
);
insert into public.precos_produtos (product, preco_centavos, descricao) values
  ('one_time', 190, 'Uso único — exportação de relatório mensal em PDF'),
  ('irpf_simulation', 100, 'Simulador de Imposto de Renda Pessoa Física — 1 uso')
on conflict (product) do update set preco_centavos = excluded.preco_centavos, descricao = excluded.descricao;
alter table public.precos_produtos enable row level security;
create policy "precos_produtos_leitura_publica" on public.precos_produtos for select using (true);

-- Consome 1 utilização de forma atômica (evita corrida/duplo uso)
create or replace function public.usar_utilizacao(p_product text)
returns uuid as $$
declare
  v_id uuid;
begin
  update public.one_time_purchases
  set used_at = now()
  where id = (
    select id from public.one_time_purchases
    where user_id = auth.uid()
      and product = p_product
      and status = 'approved'
      and used_at is null
    order by criado_em asc
    limit 1
  )
  returning id into v_id;

  return v_id; -- null se não havia utilização disponível
end;
$$ language plpgsql security definer;

-- ----------------------------------------------------------------------------
-- 7. HISTÓRICO DE TROCA DE PLANO + trava contra assinatura duplicada
-- ----------------------------------------------------------------------------
create table if not exists public.assinatura_historico (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plano_anterior text,
  plano_novo text not null references public.planos (id),
  valor_diferenca_centavos integer,
  data_alteracao timestamptz not null default now(),
  proxima_cobranca timestamptz
);

alter table public.assinatura_historico enable row level security;
create policy "assinatura_historico_dono_select" on public.assinatura_historico
  for select using (auth.uid() = user_id);

-- Impede duas assinaturas "vivas" (pending/authorized/paused) para o mesmo usuário.
-- Se já existir uma assinatura viva ao tentar inserir outra, o banco rejeita.
drop index if exists uq_assinatura_ativa_por_usuario;
create unique index uq_assinatura_ativa_por_usuario
  on public.assinaturas (user_id)
  where status in ('pending','authorized','paused');

-- ----------------------------------------------------------------------------
-- 8. Correção de dados existentes (garante que nada fique inconsistente após
--    a migration em contas já em uso)
-- ----------------------------------------------------------------------------
update public.transacoes set ativo = true where ativo is null;
