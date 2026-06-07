# PNCP — Consulta de Licitações Públicas

Sistema de consulta de licitações públicas via API do PNCP, pronto para deploy no Vercel.

## Estrutura

```
pncp-vercel/
├── api/
│   └── proxy.js        ← Serverless function (proxy CORS para pncp.gov.br)
├── public/
│   └── index.html      ← Frontend completo
├── vercel.json         ← Configuração de rotas
└── README.md
```

## Deploy no Vercel

### Opção 1 — Via GitHub (recomendado)
1. Suba esta pasta para um repositório GitHub
2. Acesse [vercel.com](https://vercel.com) → "Add New Project"
3. Importe o repositório
4. Clique em **Deploy** — pronto!

### Opção 2 — Via CLI
```bash
npm i -g vercel
cd pncp-vercel
vercel
```

## Como funciona

- `public/index.html` chama `/api/pncp/...` (rota relativa)
- `vercel.json` redireciona `/api/pncp/*` → `api/proxy.js`
- `api/proxy.js` repassa para `https://pncp.gov.br` (sem CORS)
- Municípios carregam via API pública do IBGE (sem proxy necessário)

## Funcionalidades

- 🔍 Busca por palavra-chave
- 🗺️ Filtros: UF → Município (carregamento dinâmico via IBGE)
- 📊 Dashboard com totais, valores e bullets qualitativos
- 📋 Cards de resultado com status coloridos
- 🔄 Timeline de status no modal (Publicada → Propostas → Julgamento → Homologada → Encerrada)
- 💬 Bullets qualitativos contextuais por licitação
- 📄 Paginação completa
