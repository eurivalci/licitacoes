// api/monitor.js — Monitoramento ativo (cron) de palavras-chave no PNCP por e-mail.
//
// A cada execução agendada (ver vercel.json), consulta o PNCP para cada
// palavra-chave configurada e envia um e-mail com as licitações encontradas.
// Se houver Upstash Redis configurado, envia SOMENTE as novas desde a última
// verificação (dedup por número de controle). Sem Redis, envia o resumo atual.
//
// Variáveis de ambiente (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY       (obrigatória)  chave da Resend para envio de e-mail
//   MONITOR_EMAIL_TO     (obrigatória)  destinatário (ex.: voce@empresa.com)
//   MONITOR_EMAIL_FROM   (obrigatória)  remetente verificado na Resend (ex.: alertas@seudominio.com)
//   MONITOR_KEYWORDS     (obrigatória)  termos separados por vírgula (ex.: "febraban,merenda escolar")
//   MONITOR_UF           (opcional)     filtra por UF (ex.: "CE")
//   MONITOR_STATUS       (opcional)     padrão "recebendo_proposta"
//   CRON_SECRET          (opcional)     se definido, exige Authorization: Bearer <secret>
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (opcional) p/ enviar só novidades
//
// Agendamento: configurado em vercel.json (ex.: diariamente às 09:00 BRT = 12:00 UTC).

const PNCP_SEARCH = "https://pncp.gov.br/api/search/";

function envList(v) { return (v || "").split(",").map((s) => s.trim()).filter(Boolean); }

async function pncpSearch(q, uf, status) {
  const qs = new URLSearchParams();
  qs.set("q", q);
  qs.set("tipos_documento", "edital");
  qs.set("ordenacao", "-data");
  qs.set("pagina", "1");
  qs.set("tam_pagina", "20");
  if (uf) qs.set("ufs", uf);
  if (status) qs.set("status", status);
  const res = await fetch(PNCP_SEARCH + "?" + qs.toString(), { headers: { Accept: "application/json", "User-Agent": "painel-monitor/1.0" } });
  if (!res.ok) throw new Error("PNCP HTTP " + res.status);
  const data = await res.json();
  const items = (data && (data.items || data.data || data.results)) || [];
  return items.map((it) => {
    const cnpj = it.orgao_cnpj || "", ano = it.ano || "", seq = it.numero_sequencial || "";
    const num = it.numero_controle_pncp || (cnpj && ano && seq ? cnpj + "-1-" + String(seq).padStart(6, "0") + "/" + ano : (it.item_url || JSON.stringify(it).slice(0, 40)));
    return {
      num: num,
      objeto: it.description || it.title || "Objeto não informado",
      orgao: it.orgao_nome || "",
      municipio: it.municipio_nome || "", uf: it.uf || "",
      modalidade: it.modalidade_licitacao_nome || "",
      valor: it.valor_global != null ? it.valor_global : null,
      url: it.item_url ? ("https://pncp.gov.br" + it.item_url) : "https://pncp.gov.br/app/editais"
    };
  });
}

// ---- Upstash Redis (opcional) p/ dedup ----
async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL, tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return null;
  const res = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  if (!res.ok) return null;
  const j = await res.json();
  return j.result;
}
async function filterNew(keyword, items) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return { novos: items, dedup: false };
  const key = "monitor:seen:" + keyword.toLowerCase().replace(/\s+/g, "_");
  const novos = [];
  for (const it of items) {
    const added = await redis(["SADD", key, it.num]); // 1 = novo, 0 = já existia
    if (added === 1) novos.push(it);
  }
  await redis(["EXPIRE", key, "7776000"]); // expira em ~90 dias
  return { novos: novos, dedup: true };
}

function brl(v) { return v == null ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

function buildEmail(blocks, dedup) {
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#1a2230;">' +
    '<h2 style="color:#0b8a7a;">Painel de Licitações — ' + (dedup ? "novas oportunidades" : "resumo de oportunidades") + '</h2>' +
    '<p style="color:#566;">Monitoramento automático do PNCP. Gerado em ' + new Date().toLocaleString("pt-BR") + '.</p>';
  let totalItems = 0;
  blocks.forEach((b) => {
    html += '<h3 style="margin-top:24px;border-bottom:2px solid #0b8a7a;padding-bottom:6px;">🔎 ' + esc(b.keyword) + ' <span style="color:#889;font-weight:normal;font-size:13px;">(' + b.items.length + ')</span></h3>';
    if (!b.items.length) { html += '<p style="color:#889;">Nenhuma novidade.</p>'; return; }
    b.items.forEach((it) => {
      totalItems++;
      html += '<div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin:10px 0;">' +
        '<div style="font-weight:bold;">' + esc(it.objeto.slice(0, 160)) + '</div>' +
        '<div style="color:#566;font-size:13px;margin-top:5px;">' + esc(it.orgao) + ' · ' + esc(it.municipio) + '/' + esc(it.uf) + ' · ' + esc(it.modalidade) + '</div>' +
        '<div style="margin-top:6px;"><span style="color:#b8860b;font-weight:bold;">' + brl(it.valor) + '</span> · <a href="' + esc(it.url) + '" style="color:#0b8a7a;">Ver no PNCP</a></div>' +
      '</div>';
    });
  });
  html += '<p style="color:#aab;font-size:12px;margin-top:24px;">Você recebe este e-mail porque configurou o monitoramento no Painel de Licitações.</p></div>';
  return { html: html, totalItems: totalItems };
}

async function sendEmail(html, subject) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.MONITOR_EMAIL_FROM, to: envList(process.env.MONITOR_EMAIL_TO), subject: subject, html: html })
  });
  if (!res.ok) throw new Error("Resend HTTP " + res.status + " — " + (await res.text()).slice(0, 200));
  return res.json();
}

module.exports = async function handler(req, res) {
  // Proteção opcional do cron
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || "";
    if (auth !== "Bearer " + process.env.CRON_SECRET) { res.statusCode = 401; return res.json({ error: "Não autorizado." }); }
  }
  const keywords = envList(process.env.MONITOR_KEYWORDS);
  if (!process.env.RESEND_API_KEY || !process.env.MONITOR_EMAIL_TO || !process.env.MONITOR_EMAIL_FROM || !keywords.length) {
    res.statusCode = 500;
    return res.json({ error: "Configuração incompleta. Defina RESEND_API_KEY, MONITOR_EMAIL_TO, MONITOR_EMAIL_FROM e MONITOR_KEYWORDS." });
  }
  const uf = process.env.MONITOR_UF || "";
  const status = process.env.MONITOR_STATUS || "recebendo_proposta";

  try {
    const blocks = [];
    let dedupUsed = false;
    for (const kw of keywords) {
      let items = [];
      try { items = await pncpSearch(kw, uf, status); } catch (e) { items = []; }
      const r = await filterNew(kw, items);
      dedupUsed = dedupUsed || r.dedup;
      blocks.push({ keyword: kw, items: r.novos });
    }
    const built = buildEmail(blocks, dedupUsed);
    if (built.totalItems === 0) {
      res.statusCode = 200;
      return res.json({ ok: true, enviado: false, motivo: "Sem novidades para notificar." });
    }
    const subject = "Licitações: " + built.totalItems + " " + (dedupUsed ? "novas oportunidades" : "oportunidades abertas");
    await sendEmail(built.html, subject);
    res.statusCode = 200;
    return res.json({ ok: true, enviado: true, itens: built.totalItems, dedup: dedupUsed });
  } catch (e) {
    res.statusCode = 500;
    return res.json({ error: "Falha no monitoramento.", detail: String(e && e.message || e) });
  }
};
