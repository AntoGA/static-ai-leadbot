import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp, validateLead, validateMessages } from '../server.js';

const userTurn = { role: 'user', content: 'Расскажите об услуге' };
function validLead(overrides = {}) {
  return { name: 'Анна', contact: '@anna', comment: 'Перезвоните', website: '', consent: true, openedAt: Date.now() - 2000, pageUrl: 'https://site.example/path', utm: { utm_source: 'test' }, ...overrides };
}
async function fixture(t, fetchImpl, extraEnv = {}) {
  const calls = [];
  const app = createApp({ env: {
    PORT: '3000', PUBLIC_ORIGIN: 'https://backend.example', ALLOWED_ORIGINS: 'https://site.example',
    OPENAI_API_KEY: 'ai-test', TELEGRAM_BOT_TOKEN: 'telegram-test', TELEGRAM_CHAT_ID: '123', ...extraEnv
  }, fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  return { base: `http://127.0.0.1:${app.address().port}`, calls };
}

test('валидаторы отклоняют неверную структуру и honeypot', () => {
  assert.deepEqual(validateMessages([userTurn]), [userTurn]);
  assert.equal(validateMessages([{ role: 'assistant', content: 'нет' }]), null);
  assert.equal(validateLead(validLead({ website: 'spam' })), null);
  assert.equal(validateLead(validLead({ consent: false })), null);
  assert.equal(validateLead(validLead({ openedAt: Date.now() })), null);
  assert.equal(validateLead(validLead()).name, 'Анна');
});

test('healthcheck работает без секретов', async t => {
  const { base } = await fixture(t, async () => { throw new Error('unexpected'); });
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('запрещённый Origin получает 403', async t => {
  const { base, calls } = await fixture(t, async () => { throw new Error('unexpected'); });
  const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [userTurn] }) });
  assert.equal(response.status, 403); assert.equal(calls.length, 0);
});

test('чат возвращает ответ AI', async t => {
  const { base, calls } = await fixture(t, async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Ответ' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { Origin: 'https://site.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [userTurn] }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { answer: 'Ответ' });
  assert.match(calls[0][0], /chat\/completions$/);
});

test('лид отправляется в Telegram без истории чата', async t => {
  const { base, calls } = await fixture(t, async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const lead = validLead();
  const response = await fetch(`${base}/api/leads`, { method: 'POST', headers: { Origin: 'https://site.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...lead, messages: [{ role: 'user', content: 'Секретная переписка' }] }) });
  assert.equal(response.status, 201); const result = await response.json(); assert.equal(result.ok, true); assert.ok(result.leadId);
  assert.match(calls[0][0], /api\.telegram\.org\/bottelegram-test\/sendMessage$/);
  const telegramPayload = JSON.parse(calls[0][1].body);
  assert.match(telegramPayload.text, /Анна/); assert.doesNotMatch(telegramPayload.text, /Секретная переписка/);
});

test('неуспешный Telegram не подтверждает заявку', async t => {
  const { base } = await fixture(t, async () => new Response(JSON.stringify({ ok: false }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
  const response = await fetch(`${base}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validLead()) });
  assert.equal(response.status, 502); assert.equal((await response.json()).error, 'Telegram не подтвердил отправку заявки.');
});
