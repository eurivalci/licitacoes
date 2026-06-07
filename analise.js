// api/analise.js — Função serverless (Vercel) de Análise de Risco de licitações por IA.
//
// Recebe os PDFs do processo (base64) + o contexto da contratação e pede ao
// Claude um laudo estruturado em JSON: resumo, riscos, exigências de
// habilitação, prazos, garantias, critério de julgamento e checklist de docs.
//
// SEGURANÇA: a chave da Anthropic vem de variável de ambiente no servidor
// (ANTHROPIC_API_KEY) — NUNCA do navegador.
//
// Deploy (Vercel):
//   1. Coloque este arquivo em `api/analise.js`.
//   2. Em Project Settings → Environment Variables, adicione:
//        ANTHROPIC_API_KEY = sk-ant-...           (obrigatória)
//        ANALISE_MODEL     = claude-sonnet-4-6     (opcional; padrão abaixo)
//   3. A URL final (https://seu-app.vercel.app/api/analise) vai no campo
//      "Endpoint de Análise IA" do painel (⚙).
//
// Limite: o corpo da requisição em funções serverless costuma ser ~4,5 MB,
// então o painel limita os PDFs a ~3,5 MB no total. Para editais maiores,
// aumente o limite da função ou envie apenas o edital principal.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = process.env.ANALISE_MODEL || "claude-sonnet-4-6";
const MAX_FILES = 8;

const SYSTEM_PROMPT =
  "Você é um especialista sênior em licitações públicas brasileiras, regido pela Lei 14.133/2021. " +
  "Analise os documentos do processo (edital, termo de referência, anexos) junto com o contexto fornecido, " +
  "sob a ótica de uma empresa que avalia se vale a pena e é viável participar. " +
  "Responda EXCLUSIVAMENTE com um objeto JSON válido (sem markdown, sem cercas de código, sem texto fora do JSON), " +
  "exatamente nesta estrutura:\n" +
  "{\n" +
  '  "score": número de 0 a 100 (risco geral de participação/contratual; quanto maior, mais arriscado),\n' +
  '  "nivel": "Baixo" | "Médio" | "Alto",\n' +
  '  "resumo": "2-3 frases objetivas sobre o objeto e o veredito geral",\n' +
  '  "riscos": [{ "ponto": "...", "severidade": "alta|media|baixa", "recomendacao": "..." }],\n' +
  '  "habilitacao": [{ "item": "Jurídica|Fiscal|Trabalhista|Técnica|Econômico-financeira", "exigencia": "o que é exigido", "criticidade": "alta|media|baixa" }],\n' +
  '  "prazos": [{ "label": "evento", "data": "data/prazo", "obs": "observação" }],\n' +
  '  "garantias": "exigências de garantia (proposta/execução), se houver",\n' +
  '  "julgamento": "critério de julgamento (menor preço, técnica e preço, etc.)",\n' +
  '  "documentos": ["lista de documentos necessários para participar"],\n' +
  '  "recomendacaoFinal": "recomendação prática e direta"\n' +
  "}\n" +
  "Seja específico, cite valores e cláusulas quando possível. Aponte cláusulas restritivas, exigências incomuns, " +
  "prazos apertados e penalidades. Se algum dado não constar nos documentos, registre como não identificado em vez de inventar. " +
  "Todo o conteúdo em português do Brasil.";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; return res.json({ error: "Use POST." }); }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.statusCode = 500; return res.json({ error: "ANTHROPIC_API_KEY não configurada no servidor." }); }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") { res.statusCode = 400; return res.json({ error: "Corpo JSON inválido." }); }

  const contexto = body.contexto || {};
  const arquivos = Array.isArray(body.arquivos) ? body.arquivos.slice(0, MAX_FILES) : [];
  if (!arquivos.length) { res.statusCode = 400; return res.json({ error: "Envie ao menos um PDF do processo." }); }

  // Monta o conteúdo: documentos (PDF base64) + instrução com o contexto.
  const content = [];
  for (const a of arquivos) {
    if (!a || !a.dados) continue;
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: a.dados },
      title: String(a.nome || "documento.pdf").slice(0, 120)
    });
  }
  content.push({
    type: "text",
    text:
      "CONTEXTO DA CONTRATAÇÃO (dados do PNCP):\n" +
      "Objeto: " + (contexto.objeto || "—") + "\n" +
      "Modalidade: " + (contexto.modalidade || "—") + "\n" +
      "Órgão: " + (contexto.orgao || "—") + "\n" +
      "Município/UF: " + (contexto.municipio || "—") + "/" + (contexto.uf || "—") + "\n" +
      "Valor estimado: " + (contexto.valorEstimado != null ? "R$ " + contexto.valorEstimado : "—") + "\n" +
      "Nº de controle PNCP: " + (contexto.numeroControle || "—") + "\n" +
      "Abertura de propostas: " + (contexto.dataAbertura || "—") + "\n" +
      "Encerramento de propostas: " + (contexto.dataEncerramento || "—") + "\n\n" +
      "Analise os documentos anexados e gere o laudo no formato JSON especificado."
  });

  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 60000);
    const upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: content }]
      }),
      signal: ac.signal
    });
    clearTimeout(to);

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.statusCode = 502;
      return res.json({ error: "Erro na API Anthropic (" + upstream.status + ").", detail: errText.slice(0, 500) });
    }

    const data = await upstream.json();
    const texto = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    // Extrai o JSON (remove eventuais cercas de código).
    let jsonStr = texto.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    const first = jsonStr.indexOf("{");
    const last = jsonStr.lastIndexOf("}");
    if (first >= 0 && last > first) jsonStr = jsonStr.slice(first, last + 1);

    let analise;
    try { analise = JSON.parse(jsonStr); }
    catch (e) {
      res.statusCode = 200;
      return res.json({ ok: false, error: "A IA respondeu fora do formato esperado.", bruto: texto.slice(0, 1500) });
    }

    res.statusCode = 200;
    return res.json({ ok: true, analise: analise, modelo: DEFAULT_MODEL });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    res.statusCode = aborted ? 504 : 500;
    return res.json({ error: aborted ? "Timeout na análise (documento muito grande?)." : "Falha ao analisar.", detail: String(e && e.message || e) });
  }
};
