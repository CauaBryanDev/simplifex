-- ============================================================================
-- SIMPLIFEX — Schema Supabase (PostgreSQL)
-- Rode este arquivo no SQL Editor do Supabase (ou via `supabase db push`)
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ----------------------------------------------------------------------------
-- 1. PLANOS (catálogo estático de assinatura)
-- ----------------------------------------------------------------------------
create table if not exists public.planos (
  id text primary key,                 -- 'mei' | 'me'
  nome text not null,
  preco_centavos integer not null,     -- em centavos, evita ponto flutuante
  limite_transacoes_mes integer,       -- null = ilimitado
  descricao text,
  criado_em timestamptz not null default now()
);

insert into public.planos (id, nome, preco_centavos, limite_transacoes_mes, descricao) values
  ('mei', 'Simplifex MEI', 2790, 200,  'Para Microempreendedores Individuais'),
  ('me',  'Simplifex ME',  7990, null, 'Para Microempresas (MEI que estourou o teto)')
on conflict (id) do update set
  nome = excluded.nome,
  preco_centavos = excluded.preco_centavos,
  limite_transacoes_mes = excluded.limite_transacoes_mes,
  descricao = excluded.descricao;

-- ----------------------------------------------------------------------------
-- 2. PERFIS (1:1 com auth.users)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nome_completo text,
  razao_social text,
  cnpj text unique,
  regime_tributario text check (regime_tributario in ('MEI','ME','SIMPLES_NACIONAL')) default 'MEI',
  cnae_principal text,
  uf text,
  municipio text,
  telefone text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 3. ASSINATURAS (vínculo com Mercado Pago)
-- ----------------------------------------------------------------------------
create table if not exists public.assinaturas (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users (id) on delete cascade,
  plano_id text not null references public.planos (id),
  mp_preapproval_id text unique,        -- id da assinatura recorrente no Mercado Pago
  mp_payer_email text,
  status text not null default 'pending'
    check (status in ('pending','authorized','paused','cancelled','expired')),
  data_inicio timestamptz,
  data_proxima_cobranca timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create index if not exists idx_assinaturas_user on public.assinaturas (user_id);
create index if not exists idx_assinaturas_status on public.assinaturas (status);

-- ----------------------------------------------------------------------------
-- 4. TABELAS DE ALÍQUOTAS (dados configuráveis, não "verdade absoluta")
-- ----------------------------------------------------------------------------

-- ICMS interestadual por par de UF (regra geral simplificada: 4/7/12%)
create table if not exists public.aliquotas_icms_interestadual (
  uf_origem char(2) not null,
  uf_destino char(2) not null,
  aliquota numeric(5,2) not null,
  observacao text,
  primary key (uf_origem, uf_destino)
);

-- ICMS interno por UF (usado quando origem = destino, e para cálculo de DIFAL)
create table if not exists public.aliquotas_icms_interna (
  uf char(2) primary key,
  aliquota numeric(5,2) not null
);

-- ISS por município (alíquota do prestador — regra geral, LC 116/2003: 2% a 5%)
create table if not exists public.aliquotas_iss (
  municipio text not null,
  uf char(2) not null,
  aliquota numeric(5,2) not null,
  primary key (municipio, uf)
);

-- Regras de retenção na fonte por tipo de serviço (IRRF/INSS/PIS/COFINS/CSLL)
create table if not exists public.regras_retencao_servico (
  tipo_servico text primary key,       -- ex: 'LIMPEZA', 'CONSULTORIA', 'TI', 'CONSTRUCAO_CIVIL'
  irrf_pct numeric(5,2) default 0,
  inss_pct numeric(5,2) default 0,
  pis_cofins_csll_pct numeric(5,2) default 0,
  valor_minimo_retencao_centavos integer default 0,
  observacao text
);

-- ----------------------------------------------------------------------------
-- 5. TRANSAÇÕES (vendas/serviços lançados pelo usuário ou via integração de pagamento)
-- ----------------------------------------------------------------------------
create table if not exists public.transacoes (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tipo text not null check (tipo in ('MERCADORIA','SERVICO')),
  descricao text,
  valor_centavos integer not null,
  uf_origem char(2),
  uf_destino char(2),
  municipio_prestacao text,
  tipo_servico text references public.regras_retencao_servico (tipo_servico),
  consumidor_final boolean default true,      -- afeta cálculo de DIFAL (EC 87/2015)
  contribuinte_icms_destino boolean default false,
  meio_pagamento text,                        -- 'mercado_pago', 'pix', 'boleto', 'manual'
  mp_payment_id text,
  status text not null default 'registrada' check (status in ('registrada','calculada','erro')),
  criado_em timestamptz not null default now()
);

create index if not exists idx_transacoes_user on public.transacoes (user_id, criado_em desc);

-- ----------------------------------------------------------------------------
-- 6. IMPOSTOS CALCULADOS (resultado do motor de cálculo, 1:1 com transação)
-- ----------------------------------------------------------------------------
create table if not exists public.impostos_calculados (
  transacao_id uuid primary key references public.transacoes (id) on delete cascade,
  icms_proprio_centavos integer default 0,
  icms_difal_centavos integer default 0,
  iss_centavos integer default 0,
  irrf_centavos integer default 0,
  inss_centavos integer default 0,
  pis_cofins_csll_centavos integer default 0,
  total_impostos_centavos integer default 0,
  aliquota_efetiva_pct numeric(6,3),
  detalhe_json jsonb,                 -- memória de cálculo completa (auditável)
  calculado_em timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 7. TRIGGERS
-- ----------------------------------------------------------------------------

-- Cria profile automaticamente ao registrar usuário
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, nome_completo)
  values (new.id, new.raw_user_meta_data ->> 'nome_completo');
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- atualizado_em automático
create or replace function public.set_atualizado_em()
returns trigger as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
  for each row execute procedure public.set_atualizado_em();

drop trigger if exists trg_assinaturas_updated on public.assinaturas;
create trigger trg_assinaturas_updated before update on public.assinaturas
  for each row execute procedure public.set_atualizado_em();

-- ----------------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.assinaturas enable row level security;
alter table public.transacoes enable row level security;
alter table public.impostos_calculados enable row level security;
alter table public.planos enable row level security;
alter table public.aliquotas_icms_interestadual enable row level security;
alter table public.aliquotas_icms_interna enable row level security;
alter table public.aliquotas_iss enable row level security;
alter table public.regras_retencao_servico enable row level security;

-- Leitura pública das tabelas de referência (planos, alíquotas)
create policy "planos_leitura_publica" on public.planos for select using (true);
create policy "icms_inter_leitura_publica" on public.aliquotas_icms_interestadual for select using (true);
create policy "icms_interna_leitura_publica" on public.aliquotas_icms_interna for select using (true);
create policy "iss_leitura_publica" on public.aliquotas_iss for select using (true);
create policy "retencao_leitura_publica" on public.regras_retencao_servico for select using (true);

-- Usuário só vê/edita os próprios dados
create policy "profiles_dono" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "assinaturas_dono_select" on public.assinaturas
  for select using (auth.uid() = user_id);
-- Inserção/atualização de assinaturas é feita pela Edge Function (service role), não pelo cliente.

create policy "transacoes_dono" on public.transacoes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "impostos_dono" on public.impostos_calculados
  for select using (
    exists (select 1 from public.transacoes t where t.id = transacao_id and t.user_id = auth.uid())
  );
-- Inserção de impostos_calculados feita via RPC/edge function (security definer) após o cálculo.

-- ----------------------------------------------------------------------------
-- 9. RPC: grava o resultado do cálculo de forma atômica (chamado pelo client)
-- ----------------------------------------------------------------------------
create or replace function public.registrar_calculo_imposto(
  p_transacao_id uuid,
  p_icms_proprio integer,
  p_icms_difal integer,
  p_iss integer,
  p_irrf integer,
  p_inss integer,
  p_pis_cofins_csll integer,
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
             + coalesce(p_irrf,0) + coalesce(p_inss,0) + coalesce(p_pis_cofins_csll,0);

  insert into public.impostos_calculados (
    transacao_id, icms_proprio_centavos, icms_difal_centavos, iss_centavos,
    irrf_centavos, inss_centavos, pis_cofins_csll_centavos,
    total_impostos_centavos, aliquota_efetiva_pct, detalhe_json
  ) values (
    p_transacao_id, p_icms_proprio, p_icms_difal, p_iss,
    p_irrf, p_inss, p_pis_cofins_csll,
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
    pis_cofins_csll_centavos = excluded.pis_cofins_csll_centavos,
    total_impostos_centavos = excluded.total_impostos_centavos,
    aliquota_efetiva_pct = excluded.aliquota_efetiva_pct,
    detalhe_json = excluded.detalhe_json,
    calculado_em = now();

  update public.transacoes set status = 'calculada' where id = p_transacao_id;
end;
$$ language plpgsql security definer;
