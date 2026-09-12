-- ============================================================================
-- SIMPLIFEX — Migration 003: fluxo de caixa
-- Rode depois de 002_features.sql. Aditivo, não apaga nada.
-- ============================================================================

create table if not exists public.movimentos_caixa (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tipo text not null check (tipo in ('entrada', 'saida')),
  categoria text not null,               -- 'MERCADORIA','SERVICO','imposto_reservado','aporte','retirada','despesa','outra_entrada','outra_saida'
  descricao text,
  valor_centavos integer not null,
  origem text not null default 'manual' check (origem in ('manual', 'transacao', 'imposto')),
  transacao_id uuid references public.transacoes (id) on delete cascade,
  data_movimento date not null default current_date,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

create index if not exists idx_movimentos_caixa_user
  on public.movimentos_caixa (user_id, ativo, data_movimento);
create index if not exists idx_movimentos_caixa_transacao
  on public.movimentos_caixa (transacao_id);

alter table public.movimentos_caixa enable row level security;

-- Leitura: o dono vê tudo (manuais e automáticos)
create policy "movimentos_caixa_select" on public.movimentos_caixa
  for select using (auth.uid() = user_id);

-- Escrita pelo cliente: só em lançamentos MANUAIS — os automáticos (origem
-- 'transacao'/'imposto') só são criados/atualizados pelas triggers abaixo.
create policy "movimentos_caixa_insert_manual" on public.movimentos_caixa
  for insert with check (auth.uid() = user_id and origem = 'manual');
create policy "movimentos_caixa_update_manual" on public.movimentos_caixa
  for update using (auth.uid() = user_id and origem = 'manual') with check (auth.uid() = user_id and origem = 'manual');
create policy "movimentos_caixa_delete_manual" on public.movimentos_caixa
  for delete using (auth.uid() = user_id and origem = 'manual');

-- ----------------------------------------------------------------------------
-- Sincronização automática: toda venda/serviço lançado vira uma ENTRADA de
-- caixa; editar ou excluir (soft delete) o lançamento atualiza/desativa o
-- movimento correspondente — nunca fica dessincronizado.
-- ----------------------------------------------------------------------------
create or replace function public.sync_movimento_transacao()
returns trigger as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.movimentos_caixa
      (user_id, tipo, categoria, descricao, valor_centavos, origem, transacao_id, data_movimento, ativo)
    values
      (new.user_id, 'entrada', new.tipo, coalesce(new.descricao, initcap(lower(new.tipo))), new.valor_centavos, 'transacao', new.id, new.criado_em::date, new.ativo);
  elsif TG_OP = 'UPDATE' then
    update public.movimentos_caixa
      set valor_centavos = new.valor_centavos,
          descricao = coalesce(new.descricao, initcap(lower(new.tipo))),
          categoria = new.tipo
      where transacao_id = new.id and origem = 'transacao';

    -- Excluir (soft delete) ou reativar a transação reflete no caixa também
    -- (isso apaga/reativa a entrada da venda E a saída do imposto reservado).
    update public.movimentos_caixa
      set ativo = new.ativo
      where transacao_id = new.id;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_sync_movimento_transacao on public.transacoes;
create trigger trg_sync_movimento_transacao
  after insert or update on public.transacoes
  for each row execute procedure public.sync_movimento_transacao();

-- ----------------------------------------------------------------------------
-- Todo cálculo de imposto vira uma SAÍDA de caixa ("dinheiro a reservar para
-- pagar imposto"). Recalcular (editar o lançamento) atualiza o valor.
-- ----------------------------------------------------------------------------
create or replace function public.sync_movimento_imposto()
returns trigger as $$
begin
  delete from public.movimentos_caixa where transacao_id = new.transacao_id and origem = 'imposto';

  if new.total_impostos_centavos > 0 then
    insert into public.movimentos_caixa (user_id, tipo, categoria, descricao, valor_centavos, origem, transacao_id, data_movimento)
    select t.user_id, 'saida', 'imposto_reservado', 'Impostos estimados a reservar', new.total_impostos_centavos, 'imposto', new.transacao_id, t.criado_em::date
    from public.transacoes t
    where t.id = new.transacao_id;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_sync_movimento_imposto on public.impostos_calculados;
create trigger trg_sync_movimento_imposto
  after insert or update on public.impostos_calculados
  for each row execute procedure public.sync_movimento_imposto();

-- ----------------------------------------------------------------------------
-- Preenche o caixa com o histórico de quem já tinha lançamentos antes desta
-- migration (para o saldo não nascer errado em contas já em uso).
-- ----------------------------------------------------------------------------
insert into public.movimentos_caixa (user_id, tipo, categoria, descricao, valor_centavos, origem, transacao_id, data_movimento, ativo)
select t.user_id, 'entrada', t.tipo, coalesce(t.descricao, initcap(lower(t.tipo))), t.valor_centavos, 'transacao', t.id, t.criado_em::date, t.ativo
from public.transacoes t
where not exists (select 1 from public.movimentos_caixa m where m.transacao_id = t.id and m.origem = 'transacao');

insert into public.movimentos_caixa (user_id, tipo, categoria, descricao, valor_centavos, origem, transacao_id, data_movimento, ativo)
select t.user_id, 'saida', 'imposto_reservado', 'Impostos estimados a reservar', i.total_impostos_centavos, 'imposto', i.transacao_id, t.criado_em::date, t.ativo
from public.impostos_calculados i
join public.transacoes t on t.id = i.transacao_id
where i.total_impostos_centavos > 0
  and not exists (select 1 from public.movimentos_caixa m where m.transacao_id = i.transacao_id and m.origem = 'imposto');

-- Soft delete de movimento manual (edição fica a cargo de update direto pelo cliente, já liberado pela policy)
create or replace function public.excluir_movimento_caixa(p_id uuid)
returns void as $$
declare
  v_owner uuid;
  v_origem text;
begin
  select user_id, origem into v_owner, v_origem from public.movimentos_caixa where id = p_id;
  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'Movimento não encontrado ou não pertence ao usuário autenticado';
  end if;
  if v_origem <> 'manual' then
    raise exception 'Só é possível excluir movimentos lançados manualmente — este veio automaticamente de um lançamento.';
  end if;
  update public.movimentos_caixa set ativo = false where id = p_id;
end;
$$ language plpgsql security definer;
