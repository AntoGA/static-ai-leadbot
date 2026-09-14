(() => {
  'use strict';
  if (window.__staticAiLeadbotLoaded) return;
  window.__staticAiLeadbotLoaded = true;
  const script = document.currentScript;
  if (!script?.src) return;
  const defaultBase = new URL(script.src, location.href).origin;
  let apiBase = defaultBase;
  try { apiBase = new URL(script.dataset.apiBase || defaultBase).origin; } catch { return; }
  const accent = /^#[0-9a-f]{6}$/i.test(script.dataset.accent || '') ? script.dataset.accent : '#2457d6';
  const side = script.dataset.position === 'left' ? 'left' : 'right';
  const title = (script.dataset.title || 'Помощник компании').slice(0, 80);
  const greeting = (script.dataset.greeting || 'Здравствуйте! Чем могу помочь? Можно задать вопрос или оставить заявку.').slice(0, 300);
  const cta = (script.dataset.cta || 'Оставить заявку').slice(0, 50);
  const host = document.createElement('div');
  host.id = 'static-ai-leadbot';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
:host{all:initial;--accent:${accent};font-family:Arial,sans-serif;color:#172033}*{box-sizing:border-box}.toggle{position:fixed;${side}:20px;bottom:20px;z-index:2147483646;width:62px;height:62px;border:0;border-radius:50%;background:var(--accent);color:#fff;font-size:26px;cursor:pointer;box-shadow:0 10px 30px #17255455}.panel{position:fixed;${side}:20px;bottom:94px;z-index:2147483647;display:none;flex-direction:column;width:min(390px,calc(100vw - 24px));height:min(650px,calc(100dvh - 112px));background:#fff;border:1px solid #dce2ec;border-radius:19px;overflow:hidden;box-shadow:0 18px 55px #17255444}.panel.open{display:flex}.head{padding:16px 18px;background:#172554;color:#fff}.head b{display:block;font-size:17px}.head small{color:#d9e2f4}.tabs{display:flex;border-bottom:1px solid #e5e9f0}.tabs button{flex:1;padding:11px;border:0;background:#fff;cursor:pointer}.tabs button.active{color:var(--accent);box-shadow:inset 0 -2px var(--accent)}.view{display:none;min-height:0;flex:1}.view.active{display:flex;flex-direction:column}.messages{flex:1;overflow:auto;padding:14px;background:#f7f9fc}.msg{max-width:88%;margin:0 0 10px;padding:10px 12px;border-radius:13px;background:#e9eef6;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.45}.msg.user{margin-left:auto;background:var(--accent);color:#fff}.msg.error{background:#fff0f0;color:#8c2222}.compose{display:flex;gap:8px;padding:11px;border-top:1px solid #e5e9f0}.compose textarea{flex:1;resize:none;min-height:44px;max-height:90px}textarea,input{width:100%;padding:10px 11px;border:1px solid #ccd4e0;border-radius:9px;font:14px Arial,sans-serif}.send,.primary{border:0;border-radius:9px;background:var(--accent);color:#fff;padding:10px 15px;cursor:pointer}.send:disabled,.primary:disabled{opacity:.55}.lead{padding:15px;overflow:auto;gap:10px}.lead label{display:block;font-size:13px}.lead label span{display:block;margin-bottom:5px}.consent{display:flex!important;gap:8px;line-height:1.35}.consent input{width:auto}.note,.status{font-size:11px;color:#667085;line-height:1.4}.status{min-height:16px}.trap{position:absolute!important;left:-10000px!important;width:1px!important;height:1px!important}.links a{font-size:11px;color:#52627a;margin-right:10px}.close{float:right;border:0;background:transparent;color:white;font-size:22px;cursor:pointer}@media(max-width:520px){.panel{${side}:12px;bottom:84px;height:calc(100dvh - 100px)}.toggle{${side}:12px;bottom:12px}}
</style>
<button class="toggle" aria-label="Открыть чат" aria-expanded="false">💬</button>
<section class="panel" role="dialog" aria-label="Чат с компанией">
  <header class="head"><button class="close" aria-label="Закрыть">×</button><b class="title"></b><small>AI-чат и форма заявки</small></header>
  <nav class="tabs"><button class="tab active" data-view="chat">Чат</button><button class="tab" data-view="lead">${escapeHtml(cta)}</button></nav>
  <section class="view active" data-panel="chat"><div class="messages" aria-live="polite"></div><div class="status chat-status" aria-live="polite"></div><form class="compose"><textarea maxlength="3000" required aria-label="Сообщение" placeholder="Введите сообщение…"></textarea><button class="send" aria-label="Отправить">➤</button></form></section>
  <form class="view lead" data-panel="lead"><label><span>Имя *</span><input name="name" maxlength="80" minlength="2" autocomplete="name" required></label><label><span>Телефон, email или Telegram *</span><input name="contact" maxlength="160" minlength="3" autocomplete="tel" required></label><label><span>Комментарий</span><textarea name="comment" maxlength="1000" rows="4"></textarea></label><label class="trap" aria-hidden="true">Сайт<input name="website" tabindex="-1" autocomplete="off"></label><label class="consent"><input name="consent" type="checkbox" required><span>Согласен на передачу указанных данных компании для обработки заявки.</span></label><p class="note">История AI-чата в заявку не включается. Не отправляйте чувствительные сведения.</p><div class="links"><a class="privacy" hidden target="_blank" rel="noopener">Политика</a><a class="contact" hidden target="_blank" rel="noopener">Связаться иначе</a></div><button class="primary">Отправить заявку</button><div class="status lead-status" aria-live="polite"></div></form>
</section>`;
  document.body.append(host);

  function escapeHtml(value) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  const one = selector => root.querySelector(selector);
  const all = selector => [...root.querySelectorAll(selector)];
  const panel = one('.panel');
  const toggle = one('.toggle');
  one('.title').textContent = title;
  const messages = one('.messages');
  const history = [];
  let chatBusy = false;
  let openedAt = Date.now();
  function addMessage(text, type = '') {
    const node = document.createElement('div'); node.className = `msg ${type}`; node.textContent = text;
    messages.append(node); while (messages.children.length > 60) messages.firstElementChild.remove(); messages.scrollTop = messages.scrollHeight;
  }
  function open(value = true) { panel.classList.toggle('open', value); toggle.setAttribute('aria-expanded', String(value)); if (value) one('.compose textarea').focus(); }
  toggle.addEventListener('click', () => open(!panel.classList.contains('open')));
  one('.close').addEventListener('click', () => open(false));
  addMessage(greeting);
  all('.tab').forEach(tab => tab.addEventListener('click', () => {
    all('.tab').forEach(item => item.classList.toggle('active', item === tab));
    all('.view').forEach(view => view.classList.toggle('active', view.dataset.panel === tab.dataset.view));
    if (tab.dataset.view === 'lead') openedAt = Date.now();
  }));
  fetch(`${apiBase}/api/config`).then(response => response.ok ? response.json() : Promise.reject()).then(config => {
    if (!script.dataset.title && typeof config.companyName === 'string') one('.title').textContent = config.companyName;
    for (const [selector, key] of [['.privacy', 'privacyUrl'], ['.contact', 'contactUrl']]) {
      try { const url = new URL(config[key]); if (url.protocol === 'https:') { const link = one(selector); link.href = url.href; link.hidden = false; } } catch {}
    }
  }).catch(() => {});

  one('.compose').addEventListener('submit', async event => {
    event.preventDefault(); const input = one('.compose textarea'); const text = input.value.trim();
    if (!text || chatBusy) return;
    const previous = history.slice(-10); while (previous.reduce((sum, item) => sum + item.content.length, text.length) > 18000 && previous.length) previous.splice(0, 2);
    const outgoing = [...previous, { role: 'user', content: text }];
    addMessage(text, 'user'); input.value = ''; chatBusy = true; input.disabled = true; one('.send').disabled = true; one('.chat-status').textContent = 'Готовлю ответ…';
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(`${apiBase}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: outgoing }), signal: controller.signal });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Ошибка сервера.');
      addMessage(data.answer); history.push({ role: 'user', content: text }, { role: 'assistant', content: data.answer }); if (history.length > 10) history.splice(0, history.length - 10);
    } catch (error) { addMessage(error.name === 'AbortError' ? 'Время ожидания истекло.' : error.message, 'error'); input.value = text; }
    finally { clearTimeout(timer); chatBusy = false; input.disabled = false; one('.send').disabled = false; one('.chat-status').textContent = ''; input.focus(); }
  });

  one('.lead').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('.primary'); const status = one('.lead-status');
    if (button.disabled) return;
    const values = new FormData(form); const params = new URLSearchParams(location.search); const utm = {};
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) if (params.get(key)) utm[key] = params.get(key).slice(0, 120);
    const payload = { name: values.get('name'), contact: values.get('contact'), comment: values.get('comment'), website: values.get('website'), consent: values.get('consent') === 'on', pageUrl: location.protocol === 'https:' ? location.href : '', openedAt, utm };
    button.disabled = true; status.textContent = 'Отправляем…';
    try {
      const response = await fetch(`${apiBase}/api/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Не удалось отправить заявку.');
      form.reset(); openedAt = Date.now(); status.textContent = `Заявка отправлена. Номер: ${data.leadId}`;
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
})();
