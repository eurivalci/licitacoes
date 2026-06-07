// api/pncp.js — Proxy serverless (Vercel) para a API pública do PNCP.
// Resolve o bloqueio de CORS: o navegador chama este endpoint (mesma origem
// do front, ou com CORS liberado) e ele repassa para pncp.gov.br no servidor.
//
// Uso pelo painel:  GET /api/pncp?path=/consulta/v1/contratacoes/publicacao?dataInicial=...
// Segurança:
//   - Só repassa para o host pncp.gov.br (proteção anti-SSRF).
//   - Só método GET.
//   - Normaliza o path para começar com /consulta ou /pncp.
//
// Deploy: coloque este arquivo em `api/pncp.js` na raiz de um projeto Vercel
// e faça o deploy. A URL final (ex.: https://seu-app.vercel.app/api/pncp)
// vai no campo "URL base do proxy" do painel (⚙).

const PNCP_ORIGIN = "https://pncp.gov.br/api";
const ALLOWED_PREFIXES = ["/consulta/", "/pncp/", "/search"];
const ALLOWED_HOST = "pncp.gov.br";

module.exports = async function handler(req, res) {
  // CORS — libera o front (ajuste o origin para o seu domínio em produção).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.json({ error: "Método não permitido. Use GET." });
  }

  let rawPath = req.query && req.query.path;
  if (Array.isArray(rawPath)) rawPath = rawPath[0];
  if (!rawPath || typeof rawPath !== "string") {
    res.statusCode = 400;
    return res.json({ error: "Parâmetro 'path' obrigatório. Ex.: ?path=/consulta/v1/contratacoes/publicacao?...." });
  }

  // Normaliza: garante barra inicial e bloqueia tentativas de escapar do host.
  if (!rawPath.startsWith("/")) rawPath = "/" + rawPath;

  const target = PNCP_ORIGIN + rawPath;

  // Proteção anti-SSRF: valida host e prefixo do caminho do PNCP.
  let parsed;
  try {
    parsed = new URL(target);
  } catch (e) {
    res.statusCode = 400;
    return res.json({ error: "Path inválido." });
  }
  if (parsed.hostname !== ALLOWED_HOST) {
    res.statusCode = 403;
    return res.json({ error: "Host não autorizado." });
  }
  const pathOnly = parsed.pathname.replace(/^\/api/, "");
  const allowed = ALLOWED_PREFIXES.some((p) => pathOnly.startsWith(p));
  if (!allowed) {
    res.statusCode = 403;
    return res.json({ error: "Rota não autorizada. Apenas /consulta e /pncp." });
  }

  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 20000);
    const upstream = await fetch(target, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "painel-licitacoes/1.0" },
      signal: ac.signal
    });
    clearTimeout(to);

    // Cache de borda: alivia a origem e acelera o front.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

    if (upstream.status === 204) {
      res.statusCode = 204;
      return res.end();
    }

    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    return res.end(text);
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    res.statusCode = aborted ? 504 : 502;
    return res.json({ error: aborted ? "Timeout ao consultar o PNCP." : "Falha ao consultar o PNCP.", detail: String(e && e.message || e) });
  }
};
