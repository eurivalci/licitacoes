// api/proxy.js — Serverless function no Vercel
// Faz o papel do proxy local, mas rodando na nuvem.
// Todas as requisições para /api/pncp/* são redirecionadas para pncp.gov.br

export default async function handler(req, res) {
  // CORS — permite chamadas do browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Reconstrói o path original removendo o prefixo /api/pncp
  const originalPath = req.url.replace(/^\/api\/pncp/, '');
  const targetUrl = `https://pncp.gov.br${originalPath}`;

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PNCP-Vercel/1.0)',
        'Accept': 'application/json',
      },
    });

    const contentType = response.headers.get('content-type') || 'application/json';
    const body = await response.text();

    res.status(response.status)
       .setHeader('Content-Type', contentType)
       .setHeader('Access-Control-Allow-Origin', '*')
       .send(body);

  } catch (error) {
    res.status(502).json({ error: 'Proxy error', message: error.message });
  }
}
