# Changelog — Correções e novos recursos (esta entrega)

Todas as mudanças foram feitas **em cima do projeto que você enviou** — nada foi recriado do zero. Sua configuração real (`config.js` com as chaves do seu projeto Supabase `umtbatzuhjdlzaswaklr` e sua Public Key do Mercado Pago) foi preservada.

## 1. Bug corrigido (causa raiz confirmada)

Em `assets/js/calculator-engine.js`, `calcularServico()` e `calcularRetencoes()` retornavam `{ ...: 0 }` direto quando `regime_tributario === 'MEI'` (o padrão de todo cadastro). Como `calcularMercadoria()` já tinha sido parcialmente alterada para sempre calcular, mercadoria "funcionava" e serviço parecia quebrado. Corrigido: **todo lançamento agora sempre calcula um valor real**, e para MEI o campo `detalhe.estimativa = true` sinaliza que é referência (já que o MEI paga via DAS fixo).

## 2. Arquivos alterados

| Arquivo | O que mudou |
|---|---|
| `assets/js/calculator-engine.js` | Reescrito: nunca mais retorna zero por causa do regime; adiciona `calcularFederais()` (PIS/COFINS/IRPJ/CSLL); usa a nova RPC `registrar_calculo_imposto_v2` |
| `assets/js/dashboard.js` | Reescrito: sem paywall; adiciona lucro, valor líquido, total por categoria, detalhamento de impostos, 3 gráficos (Chart.js), editar/excluir lançamento (soft delete), modal de detalhamento por lançamento |
| `dashboard.html` | Novos cards de estatística, 3 `<canvas>` para os gráficos, modal de detalhamento, botões Ver/Editar/Excluir na tabela, CDN do Chart.js |
| `assinatura.html` | Reescrito como "Meu Plano": troca de plano sem duplicidade, aviso de diferença, histórico de alterações, desabilita o botão do plano já ativo |
| `cadastro.html` | Removido o redirecionamento forçado para pagamento — agora vai direto para o Dashboard (gratuito), conforme item 1 |
| `assets/js/checkout.js` | Trata o novo erro `ASSINATURA_JA_EXISTE` e redireciona para "Meu plano" em vez de deixar o usuário tentar assinar de novo |
| `assets/js/config.js` | Adicionadas as URLs das 2 novas Edge Functions |

## 3. Arquivos novos

| Arquivo | Função |
|---|---|
| `supabase/migrations/002_features.sql` | Toda a mudança de banco desta entrega (ver seção 4) |
| `assets/js/pix-checkout.js` | Cliente para pagamento PIX avulso e troca de plano |
| `recursos.html` | Compra avulsa (R$ 1,90 via PIX) — libera exportação de relatório CSV do mês |
| `irpf.html` | Simulador de IRPF pago por uso (R$ 1,00 via PIX) |
| `supabase/functions/change-subscription/index.ts` | Upgrade/downgrade de plano sem criar segunda assinatura |
| `supabase/functions/create-pix-payment/index.ts` | Gera cobrança PIX avulsa com preço decidido no servidor |

## 4. Banco de dados — rodar `supabase/migrations/002_features.sql`

Não mexe nas tabelas antigas além de `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (não apaga dados). Cria:

- `transacoes.ativo` (soft delete) e `transacoes.atualizado_em`
- `impostos_calculados.pis_centavos / cofins_centavos / irpj_centavos / csll_centavos`
- `parametros_federais` (alíquotas de PIS/COFINS/IRPJ/CSLL, editáveis)
- `one_time_purchases` (pagamentos avulsos PIX)
- `precos_produtos` (preço de cada produto avulso, decidido no servidor)
- `assinatura_historico` (auditoria de troca de plano)
- **Índice único parcial** em `assinaturas(user_id) WHERE status IN ('pending','authorized','paused')` — trava de banco contra assinatura duplicada, mesmo se alguém chamar a API direto
- Funções: `registrar_calculo_imposto_v2`, `excluir_transacao` (soft delete), `usar_utilizacao` (consome 1 crédito de forma atômica, evita corrida)

**Como rodar:** SQL Editor do Supabase → colar o arquivo inteiro → Run.

## 5. Edge Functions — o que fazer

```bash
supabase functions deploy create-preapproval   # alterada: agora bloqueia 2ª assinatura
supabase functions deploy mp-webhook --no-verify-jwt   # alterada: também processa pagamentos PIX avulsos
supabase functions deploy change-subscription   # nova
supabase functions deploy create-pix-payment    # nova
```

`cancel-subscription` não mudou, não precisa reimplantar.

## 6. Segredos — nenhum novo necessário

As duas funções novas usam os **mesmos segredos** já configurados: `MP_ACCESS_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Nada a adicionar.

## 7. Itens do pedido e como foram resolvidos

| # | Item | Como foi resolvido |
|---|---|---|
| 1 | Painel gratuito | Já não havia paywall no dashboard original; removido o redirecionamento forçado para pagamento no cadastro |
| 2/3 | Cálculo de impostos (mercadoria e serviço) | Bug corrigido — ver seção 1 |
| 4 | Detalhamento (ISS/ICMS/PIS/COFINS/IRPJ/CSLL) | Modal por lançamento + card de detalhamento do período no Dashboard |
| 5 | 3 gráficos de pizza | Implementados com Chart.js, alimentados pelos dados reais do período |
| 6 | Editar/excluir lançamento | Editar reaproveita o formulário; excluir é soft delete (`ativo=false`), ambos recalculam tudo |
| 7 | Uso único R$ 1,90 PIX | `recursos.html` + `create-pix-payment` + webhook idempotente |
| 8 | Simulador IRPF R$ 1,00 | `irpf.html`, mesmo mecanismo de pagamento avulso |
| 9–13 | Upgrade/downgrade sem duplicidade | `change-subscription` atualiza a MESMA assinatura no Mercado Pago (não cria uma 2ª) + índice único no banco |
| 10 | Cobrança da diferença | **Decisão de engenharia, documentada no código:** a API de Preapproval do Mercado Pago não permite cobrar a diferença prorata imediatamente sem guardar o cartão tokenizado do assinante (implicação de PCI). Por isso, o novo valor vale a partir do próximo ciclo — nunca há cobrança duplicada no mesmo mês. Se você precisar de cobrança imediata da diferença, isso exige um fluxo adicional de tokenização de cartão que não estava no escopo original do projeto — posso implementar como próximo passo se for prioridade. |
| 11 | Manter data de cobrança | Consequência direta de atualizar a mesma assinatura em vez de criar outra |
| 12 | Histórico de troca | Tabela `assinatura_historico` + tela em "Meu plano" |
| 14 | Área "Meu Plano" | `assinatura.html` reescrita |
| 16 | Preço decidido no servidor | `precos_produtos` no banco; a Edge Function ignora qualquer preço vindo do navegador |
| 17 | Dashboard sempre busca do banco | Nenhum valor fica em cache além da sessão da página; toda ação (criar/editar/excluir/pagar) recarrega do banco |

## 8. O que eu não alterei (conforme pedido)

Autenticação, cadastro/login, estrutura de tabelas originais (`profiles`, `planos`, `aliquotas_*`), e a integração original com Mercado Pago (`create-preapproval`/`cancel-subscription`) continuam com a mesma base — só adicionei a checagem de duplicidade.
