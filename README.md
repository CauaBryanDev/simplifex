# Simplifex

Plataforma "plug-and-play" de automação fiscal para MEI e ME que vendem para vários estados/municípios: calcula **ICMS** (interno, interestadual e DIFAL), **ISS** e **retenções na fonte** (IRRF, INSS, PIS/COFINS/CSLL) em tempo real, sem depender de um contador no dia a dia.

Stack: **HTML + CSS + JavaScript puro** (sem framework/build step) no front-end, **Supabase** (Postgres + Auth + Edge Functions) como back-end, e **Mercado Pago (Preapproval API)** para assinaturas recorrentes.

---

## 1. Estrutura do projeto

```
simplifex/
├── index.html              # Landing page + planos
├── login.html
├── cadastro.html            # Cadastro + redireciona para checkout do plano
├── dashboard.html           # Painel: estatísticas, lançar transação, histórico
├── calculadora.html         # Simulador público (sem login)
├── assinatura.html          # Gerenciar plano / cancelar
├── assets/
│   ├── css/style.css        # Design system
│   └── js/
│       ├── config.js            # URLs/chaves públicas (editar aqui)
│       ├── supabaseClient.js
│       ├── auth.js               # signup/login/logout/guarda de rota
│       ├── calculator-engine.js  # Motor de cálculo fiscal (núcleo do produto)
│       ├── dashboard.js
│       └── checkout.js           # Chama as Edge Functions do Mercado Pago
└── supabase/
    ├── schema.sql            # Tabelas, RLS, triggers, RPC
    ├── seed.sql               # Alíquotas de referência (ICMS/ISS/retenções)
    └── functions/
        ├── create-preapproval/   # Cria assinatura recorrente no Mercado Pago
        ├── mp-webhook/            # Recebe notificações do Mercado Pago
        └── cancel-subscription/  # Cancela assinatura a pedido do usuário
```

## 2. Configurar o Supabase

1. Crie um projeto em [supabase.com](https://supabase.com).
2. No **SQL Editor**, rode nesta ordem:
   - `supabase/schema.sql`
   - `supabase/seed.sql`
3. Em **Project Settings → API**, copie a `Project URL` e a `anon public key`.
4. Cole esses valores em `assets/js/config.js`:
   ```js
   SUPABASE_URL: 'https://SEU-PROJETO.supabase.co',
   SUPABASE_ANON_KEY: 'sua-anon-key',
   ```

## 3. Configurar o Mercado Pago

1. Crie uma aplicação em [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers/panel).
2. Copie o **Access Token** (privado) e a **Public Key**.
3. Instale a CLI do Supabase e faça login (`supabase login`), depois:
   ```bash
   supabase link --project-ref SEU-PROJETO
   supabase secrets set MP_ACCESS_TOKEN=seu-access-token
   supabase secrets set APP_BASE_URL=https://seu-dominio.com
   supabase functions deploy create-preapproval
   supabase functions deploy cancel-subscription
   supabase functions deploy mp-webhook --no-verify-jwt
   ```
4. No painel do Mercado Pago, cadastre a **URL de Webhook**:
   `https://SEU-PROJETO.functions.supabase.co/mp-webhook`
   e assine o evento de **Assinaturas (preapproval)**.
5. Preencha em `assets/js/config.js`:
   ```js
   MERCADOPAGO_PUBLIC_KEY: 'sua-public-key',
   FN_CREATE_PREAPPROVAL: 'https://SEU-PROJETO.functions.supabase.co/create-preapproval',
   FN_CANCEL_SUBSCRIPTION: 'https://SEU-PROJETO.functions.supabase.co/cancel-subscription',
   ```

> O Access Token nunca fica no front-end — ele só existe dentro das Edge Functions (ambiente de servidor), configurado via `supabase secrets set`.

## 4. Rodar localmente

Como o front-end é HTML/CSS/JS puro (módulos ES), basta servir os arquivos estáticos:

```bash
cd simplifex
npx serve .
# ou
python3 -m http.server 3000
```

Abra `http://localhost:3000`.

## 5. Publicar

Qualquer host de arquivos estáticos funciona: **Vercel**, **Netlify**, **Cloudflare Pages** ou o próprio **Supabase Storage**. Não há passo de build — é subir a pasta como está.

## 6. Planos e preços

| Plano | Preço | Público |
|---|---|---|
| MEI | R$ 27,90/mês | Microempreendedores Individuais |
| ME | R$ 79,90/mês | MEI que estourou o teto / Microempresas do Simples |

Os preços e limites ficam na tabela `planos` (Postgres) e são espelhados no valor cobrado pelo Mercado Pago em `create-preapproval/index.ts` — se mudar o preço, atualize os dois lugares.

## 7. Sobre a precisão fiscal — leia isto

O motor de cálculo (`calculator-engine.js` + tabelas em `seed.sql`) aplica **regras gerais**:
- ICMS interestadual pela Resolução do Senado 22/1989 (4/7/12%, sem tratar exceções por NCM/produtos importados);
- DIFAL pela EC 87/2015 para venda a consumidor final fora do estado;
- ISS pela LC 116/2003, com alíquota por município (cadastre a alíquota exata do seu cliente — o seed traz só as capitais como exemplo);
- Retenções federais (IRRF/INSS/PIS-COFINS-CSLL) por tipo de serviço, regra geral da IN RFB 1.234/2012.

Isso **não substitui** um contador para: substituição tributária (ICMS-ST), benefícios fiscais locais, enquadramentos especiais de serviço na lista da LC 116/2003, ou apuração oficial de guias (DAS, DASN-SIMEI, DEFIS). Toda transação calculada grava uma `detalhe_json` com a memória de cálculo completa, para auditoria.

## 8. Próximos passos sugeridos

- Captura automática de vendas via **webhook de pagamentos** do Mercado Pago (não só de assinatura) para preencher `transacoes` sem lançamento manual.
- Tela de configuração para o usuário sobrescrever alíquotas de ICMS/ISS específicas do seu contrato.
- Exportação de relatório mensal (CSV/PDF) para envio ao contador.
- Alertas automáticos de proximidade do teto de faturamento do MEI (R$ 81.000/ano).
