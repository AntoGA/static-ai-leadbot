import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC = new Map([
  ['/', ['demo.html', 'text/html; charset=utf-8']],
  ['/demo.html', ['demo.html', 'text/html; charset=utf-8']],
  ['/widget.js', ['widget.js', 'text/javascript; charset=utf-8']]
]);

function integer(value, fallback, min = 0, max = 100000) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}
function clean(value, max) {
  return typeof value === 'string' ? value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max) : '';
}
function httpsUrl(value, max = 1000) {
  try {
    const url = new URL(clean(value, max));
    return url.protocol === 'https:' ? url.href.slice(0, max) : '';
  } catch { return ''; }
}
function normalizedOrigin(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.hostname === 'localhost') && url.origin === value.replace(/\/$/, '') ? url.origin : '';
  } catch { return ''; }
}
function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw Object.assign(new Error('Запрос слишком большой.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Некорректный JSON.'), { status: 400 }); }
}

export function validateMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 11 || value.length % 2 !== 1) return null;
  let total = 0;
  const output = [];
  for (let index = 0; index < value.length; index++) {
    const message = value[index];
    const role = index % 2 ? 'assistant' : 'user';
    if (!message || message.role !== role || typeof message.content !== 'string') return null;
    const content = clean(message.content, role === 'user' ? 3000 : 8000);
    if (!content || content !== message.content.trim()) return null;
    total += content.length;
    if (total > 18000) return null;
    output.push({ role, content });
  }
  return output;
}

export function validateLead(value) {
  if (!value || value.consent !== true || clean(value.website, 1)) return null;
  const name = clean(value.name, 80);
  const contact = clean(value.contact, 160);
  const comment = clean(value.comment, 1000);
  const pageUrl = httpsUrl(value.pageUrl, 1000);
  const openedAt = Number(value.openedAt);
  if (name.length < 2 || contact.length < 3 || !Number.isFinite(openedAt)) return null;
  const age = Date.now() - openedAt;
  if (age < 1200 || age > 24 * 60 * 60 * 1000) return null;
  const utm = {};
  if (value.utm && typeof value.utm === 'object' && !Array.isArray(value.utm)) {
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      const item = clean(value.utm[key], 120);
      if (item) utm[key] = item;
    }
  }
  return { name, contact, comment, pageUrl, utm };
}

function telegramText(lead, company, id) {
  const rows = [`Новая заявка • ${company}`, `ID: ${id}`, `Имя: ${lead.name}`, `Контакт: ${lead.contact}`];
  if (lead.comment) rows.push(`Комментарий: ${lead.comment}`);
  if (lead.pageUrl) rows.push(`Страница: ${lead.pageUrl}`);
  for (const [key, value] of Object.entries(lead.utm)) rows.push(`${key}: ${value}`);
  rows.push(`Время UTC: ${new Date().toISOString()}`);
  return rows.join('\n').slice(0, 4000);
}

export function createApp({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const port = integer(env.PORT, 3000, 1, 65535);
  const ownOrigin = normalizedOrigin(env.PUBLIC_ORIGIN || `http://localhost:${port}`);
  const origins = new Set([ownOrigin, ...(env.ALLOWED_ORIGINS || '').split(',').map(item => normalizedOrigin(item.trim()))].filter(Boolean));
  const proxyHops = integer(env.TRUST_PROXY_HOPS, 0, 0, 10);
  const chatMax = integer(env.CHAT_RATE_PER_MINUTE, 10, 1, 1000);
  const leadMax = integer(env.LEAD_RATE_PER_HOUR, 5, 1, 1000);
  const globalMax = integer(env.GLOBAL_AI_PER_HOUR, 300, 1, 100000);
  const concurrentMax = integer(env.MAX_CONCURRENT_AI, 5, 1, 100);
  const duplicateMs = integer(env.LEAD_DUPLICATE_MINUTES, 10, 1, 1440) * 60000;
  const buckets = new Map();
  const duplicates = new Map();
  let globalAI = { count: 0, end: 0 };
  let activeAI = 0;

  function clientIp(req) {
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(item => item.trim()).filter(Boolean);
    chain.push(req.socket.remoteAddress || 'unknown');
    return chain[Math.max(0, chain.length - 1 - proxyHops)];
  }
  function limited(key, max, duration) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.end <= now) bucket = { count: 0, end: now + duration };
    bucket.count++;
    buckets.set(key, bucket);
    return bucket.count > max ? Math.max(1, Math.ceil((bucket.end - now) / 1000)) : 0;
  }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.end <= now) buckets.delete(key);
    for (const [key, value] of duplicates) if (value <= now) duplicates.delete(key);
  }, 60000).unref();

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const pathname = new URL(req.url, 'http://localhost').pathname;
    try {
      if (pathname === '/api/chat' || pathname === '/api/leads') {
        const origin = req.headers.origin;
        if (origin && !origins.has(origin)) return json(res, 403, { error: 'Источник запроса не разрешён.' });
        if (origin) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.writeHead(204); return res.end();
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'Используйте POST.' }, { Allow: 'POST, OPTIONS' });
        if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'Требуется application/json.' });
        if (Number(req.headers['content-length']) > 64 * 1024) return json(res, 413, { error: 'Запрос слишком большой.' });
        const ip = clientIp(req);
        const isLead = pathname === '/api/leads';
        const retry = limited(`${isLead ? 'lead' : 'chat'}:${ip}`, isLead ? leadMax : chatMax, isLead ? 3600000 : 60000);
        if (retry) return json(res, 429, { error: 'Слишком много запросов. Попробуйте позже.' }, { 'Retry-After': String(retry) });
        const body = await readJson(req);

        if (isLead) {
          const lead = validateLead(body);
          if (!lead) return json(res, 400, { error: 'Проверьте поля формы и согласие.' });
          if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json(res, 503, { error: 'Приём заявок ещё не настроен.' });
          const fingerprint = createHash('sha256').update(`${ip}\0${lead.name.toLowerCase()}\0${lead.contact.toLowerCase()}\0${lead.comment}`).digest('hex');
          if ((duplicates.get(fingerprint) || 0) > Date.now()) return json(res, 409, { error: 'Такая заявка уже была отправлена.' });
          const id = randomUUID();
          const payload = { chat_id: env.TELEGRAM_CHAT_ID, text: telegramText(lead, clean(env.COMPANY_NAME, 100) || 'Компания', id), disable_web_page_preview: true };
          const thread = integer(env.TELEGRAM_MESSAGE_THREAD_ID, 0, 1, 2147483647);
          if (thread) payload.message_thread_id = thread;
          let telegram;
          try {
            telegram = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
            });
          } catch {
            return json(res, 502, { error: 'Не удалось отправить заявку. Попробуйте ещё раз.' });
          }
          if (!telegram.ok) {
            await telegram.body?.cancel();
            return json(res, 502, { error: 'Telegram не подтвердил отправку заявки.' });
          }
          const telegramBody = await telegram.json().catch(() => null);
          if (telegramBody?.ok !== true) return json(res, 502, { error: 'Telegram не подтвердил отправку заявки.' });
          duplicates.set(fingerprint, Date.now() + duplicateMs);
          return json(res, 201, { ok: true, leadId: id });
        }

        const messages = validateMessages(body?.messages);
        if (!messages) return json(res, 400, { error: 'Некорректная или слишком длинная история.' });
        if (!env.OPENAI_API_KEY) return json(res, 503, { error: 'AI-чат ещё не настроен.' });
        const now = Date.now();
        if (globalAI.end <= now) globalAI = { count: 0, end: now + 3600000 };
        if (globalAI.count >= globalMax || activeAI >= concurrentMax) return json(res, 503, { error: 'Чат временно занят.' });
        globalAI.count++; activeAI++;
        try {
          const response = await fetchImpl(`${(env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST', signal: AbortSignal.timeout(30000), headers: {
              'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}`
            }, body: JSON.stringify({
              model: env.AI_MODEL || 'gpt-4o-mini', temperature: 0.3, max_tokens: 700,
              messages: [{ role: 'system', content: clean(env.AI_SYSTEM_PROMPT, 8000) || 'Ты русскоязычный помощник компании. Отвечай кратко. Не выдумывай факты.' }, ...messages]
            })
          });
          if (!response.ok) {
            await response.body?.cancel();
            return json(res, 502, { error: 'AI-провайдер не подтвердил запрос.' });
          }
          const data = await response.json();
          const answer = clean(data?.choices?.[0]?.message?.content, 8000);
          return answer ? json(res, 200, { answer }) : json(res, 502, { error: 'Получен пустой ответ AI.' });
        } catch (error) {
          return json(res, error.name === 'TimeoutError' ? 504 : 502, { error: error.name === 'TimeoutError' ? 'Время ожидания истекло.' : 'Не удалось связаться с AI.' });
        } finally { activeAI--; }
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Метод не поддерживается.' });
      if (pathname === '/healthz') return json(res, 200, { status: 'ok' });
      if (pathname === '/api/config') return json(res, 200, {
        companyName: clean(env.COMPANY_NAME, 100) || 'Помощник компании', privacyUrl: httpsUrl(env.PRIVACY_URL), contactUrl: httpsUrl(env.CONTACT_URL)
      });
      const asset = STATIC.get(pathname);
      if (!asset) return json(res, 404, { error: 'Не найдено.' });
      const content = await readFile(path.join(ROOT, 'public', asset[0]));
      if (asset[0] === 'demo.html') res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': asset[0] === 'widget.js' ? 'public, max-age=300' : 'no-cache', 'Access-Control-Allow-Origin': asset[0] === 'widget.js' ? '*' : ownOrigin || '' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: error.status ? error.message : 'Внутренняя ошибка сервера.' });
    }
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 15000;
  server.on('close', () => clearInterval(sweep));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = integer(process.env.PORT, 3000, 1, 65535);
  const server = createApp();
  server.listen(port, '0.0.0.0', () => console.log(`Static AI Leadbot listening on ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
