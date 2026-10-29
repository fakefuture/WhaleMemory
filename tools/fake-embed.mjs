// tools/fake-embed.mjs — 玩具嵌入服务，只用于自测/离线验证 HTTP 链路。
// 不是真模型：把词散列到固定维度，共享词越多向量越接近。
// 用法：node tools/fake-embed.mjs [port]   默认 18080
// 同时提供 Ollama 风格 /api/embeddings 与 OpenAI 风格 /v1/embeddings。

import http from 'node:http';

const DIM = 8;
const port = Number(process.argv[2] || process.env.FAKE_EMBED_PORT || 18080);

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function embed(text) {
  const vec = new Array(DIM).fill(0);
  const s = String(text || '').toLowerCase();
  const tokens = s.match(/[a-z0-9_]+/g) || [];
  const cjk = s.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || [];
  for (const t of [...tokens, ...cjk]) vec[hash(t) % DIM] += 1;
  for (let i = 0; i + 1 < cjk.length; i += 1) vec[hash(cjk[i] + cjk[i + 1]) % DIM] += 1;
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((x) => Number((x / norm).toFixed(6)));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const text = payload.input ?? payload.prompt ?? '';
    const route = String(req.url).split('?')[0];
    // 精确匹配：/api/embed 是 /api/embeddings 的前缀，不能只用 startsWith。
    if (route === '/api/embed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: payload.model || 'fake', embeddings: [embed(text)] }));
      return;
    }
    if (route === '/api/embeddings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embedding: embed(text) }));
      return;
    }
    if (route === '/v1/embeddings') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: embed(text) }] }));
      return;
    }
    res.writeHead(404).end();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-embed listening on http://127.0.0.1:${port} (dim=${DIM})`);
});
