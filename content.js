/* Discord Self Message Cleaner – floating panel injected into Discord */
(function () {
  'use strict';

  const HOST_ID = 'dsc-cleaner-host';
  const API_BASE = 'https://discord.com/api/v10';
  const EPOCH = 1420070400000n;
  const DEFAULTS = { limit: 100, delayMs: 1600 };

  /* ── state ── */
  const st = {
    running: false, deleted: 0, stopRequested: false,
    deleting: false, previewed: [], previewCtx: null,
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ── token extraction ── */
  function extractToken() {
    try {
      const chunks = window.webpackChunkdiscord_app;
      if (Array.isArray(chunks)) {
        let tok = null;
        chunks.push([[Symbol()], {}, req => {
          for (const id of Object.keys(req.m || {})) {
            try {
              for (const m of [req(id), req(id)?.default]) {
                if (m && typeof m.getToken === 'function') {
                  const t = m.getToken();
                  if (t && t.length > 20) { tok = t; return; }
                }
              }
            } catch (_) { /* skip */ }
          }
        }]);
        if (tok) return tok;
      }
    } catch (_) { /* skip */ }
    try {
      const t = window.localStorage.getItem('token');
      if (t) return t.replace(/^"|"$/g, '');
    } catch (_) { /* skip */ }
    return null;
  }

  /* ── snowflake helpers ── */
  const sfTime = id => new Date(Number((BigInt(id) >> 22n) + EPOCH));
  const tsToSf = d => String((BigInt(d.getTime()) - EPOCH) << 22n);

  /* ── Discord API ── */
  async function apiFetch(token, path, opts = {}, attempt = 0) {
    const res = await fetch(API_BASE + path, {
      ...opts,
      headers: { Authorization: token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      const wait = Math.ceil(Number(j.retry_after || 1) * 1000);
      if (attempt < 3) { await sleep(wait + 250); return apiFetch(token, path, opts, attempt + 1); }
      throw new Error('触发限速，请稍后重试。');
    }
    if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`API ${res.status}: ${b.slice(0, 120)}`); }
    return res.status === 204 ? null : res.json();
  }

  async function collectMessages(token, opts, meId, setStatus) {
    const msgs = [];
    let before = opts.before ? tsToSf(opts.before) : null;
    let go = true;
    while (go && msgs.length < opts.limit) {
      const p = new URLSearchParams({ limit: '100' });
      if (before) p.set('before', before);
      const batch = await apiFetch(token, `/channels/${opts.channelId}/messages?${p}`);
      if (!Array.isArray(batch) || !batch.length) break;
      for (const m of batch) {
        const t = new Date(m.timestamp || sfTime(m.id));
        if (opts.after && t < opts.after) { go = false; break; }
        if (m.author?.id === meId) {
          const inRange = (!opts.after || t >= opts.after) && (!opts.before || t <= opts.before);
          if (inRange) { msgs.push(m); if (msgs.length >= opts.limit) break; }
        }
      }
      before = batch[batch.length - 1].id;
      setStatus('预览中', `已找到 ${msgs.length} 条自己的消息…`);
      await sleep(250);
    }
    return msgs;
  }

  /* ── UI-mode delete (DOM clicking) ── */
  const vis = el => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const candidates = () => Array.from(document.querySelectorAll('[id^="chat-messages-"]')).filter(n => n instanceof HTMLElement).filter(vis);
  const isOwn = msg => {
    if (msg.querySelector('img[class*="avatar"]')) return true;
    return Array.from(msg.querySelectorAll('[role="button"],button')).some(b =>
      /delete|删除/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')));
  };
  const findBtn = (msg, re) => Array.from(msg.querySelectorAll('[role="button"],button')).find(b => re.test(b.getAttribute('aria-label') || b.textContent || ''));
  const findMenuItem = re => Array.from(document.querySelectorAll('[role="menuitem"],[role="button"],button')).find(i => re.test((i.getAttribute('aria-label') || '') + ' ' + (i.textContent || '')));
  const click = el => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); el.click(); };

  async function uiDeleteOne(msg) {
    msg.scrollIntoView({ block: 'center' }); await sleep(180); click(msg); await sleep(180);
    const more = findBtn(msg, /more|更多/i); if (!more) return false;
    click(more); await sleep(260);
    const del = findMenuItem(/delete message|删除消息|delete|删除/i);
    if (!del) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return false; }
    click(del); await sleep(360);
    const confirm = findMenuItem(/^delete$|^删除$/i); if (!confirm) return false;
    click(confirm); return true;
  }

  async function runUiMode(opts, setStatus) {
    st.running = true; st.stopRequested = false; st.deleted = 0;
    setStatus('运行中', '正在扫描当前频道…');
    while (!st.stopRequested && st.deleted < opts.limit) {
      const msgs = candidates().filter(isOwn).reverse();
      let pass = 0;
      for (const m of msgs) {
        if (st.stopRequested || st.deleted >= opts.limit) break;
        if (await uiDeleteOne(m)) { st.deleted++; pass++; setStatus('运行中', `已删除 ${st.deleted} 条。`); await sleep(opts.delayMs); }
      }
      if (!pass) {
        if (!opts.autoScroll) break;
        const list = document.querySelector('[data-list-id="chat-messages"]');
        (list || window).scrollBy({ top: -(list ? list.clientHeight : window.innerHeight) * 0.85, behavior: 'smooth' });
        await sleep(1300);
      }
    }
    const stopped = st.stopRequested;
    st.running = false; st.stopRequested = false;
    setStatus(stopped ? '已停止' : '完成', `本轮删除 ${st.deleted} 条。`);
  }

  /* ── CSS ── */
  const CSS = `
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#panel{position:fixed;bottom:24px;right:24px;width:360px;max-height:80vh;background:#1e1f22;border:1px solid #2b2d31;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.65);display:flex;flex-direction:column;z-index:2147483647;overflow:hidden;color:#dbdee1;font-size:13px}
#panel.hidden{display:none}
.ph{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;background:#2b2d31;cursor:grab;flex-shrink:0;border-bottom:1px solid #111214}
.ph:active{cursor:grabbing}
.pt{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;color:#f2f3f5}
.pt svg{width:18px;height:18px;fill:none;stroke:#5865f2;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.xbtn{background:none;border:none;color:#80848e;cursor:pointer;padding:3px 5px;border-radius:6px;font-size:16px;line-height:1;display:flex;align-items:center}
.xbtn:hover{color:#f2f3f5;background:#3c3f45}
.pb{overflow-y:auto;flex:1;padding:10px;display:flex;flex-direction:column;gap:8px}
.pb::-webkit-scrollbar{width:4px}
.pb::-webkit-scrollbar-thumb{background:#3c3f45;border-radius:4px}
.fl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#80848e;margin-bottom:2px}
.fr{display:flex;gap:6px;align-items:center}
input[type=text],input[type=password],input[type=number],input[type=datetime-local]{flex:1;background:#2b2d31;border:1px solid #111214;border-radius:8px;padding:6px 10px;color:#dbdee1;font-size:13px;font-family:inherit;outline:none;min-width:0;transition:border-color .15s}
input:focus{border-color:#5865f2}
input::placeholder{color:#4e5058}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
button{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:6px 11px;border:none;border-radius:8px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;transition:filter .15s;white-space:nowrap}
button:hover:not(:disabled){filter:brightness(1.12)}
button:disabled{opacity:.45;cursor:not-allowed}
button svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.bp{background:#5865f2;color:#fff}
.bs{background:#3c3f45;color:#dbdee1}
.bd{background:#ed4245;color:#fff}
.bw{background:#2b2d31;color:#80848e;border:1px solid #3c3f45}
.bsm{padding:5px 9px;font-size:11px}
.g2b{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.g3b{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}
.ck{display:flex;align-items:flex-start;gap:7px;padding:7px 9px;background:#2b2d31;border-radius:8px}
.ck input[type=checkbox]{width:15px;height:15px;margin-top:1px;flex-shrink:0;accent-color:#5865f2;cursor:pointer}
.ck label{font-size:11px;color:#b5bac1;line-height:1.45;cursor:pointer}
.sb{background:#2b2d31;border-radius:8px;padding:8px 10px}
.st{font-weight:700;font-size:12px;color:#f2f3f5;margin-bottom:2px}
.sd{font-size:11px;color:#80848e;line-height:1.4;word-break:break-all}
.rh{display:flex;justify-content:space-between;align-items:center}
.rc{background:#3c3f45;border-radius:999px;padding:1px 7px;font-size:11px;color:#dbdee1}
.rl{max-height:130px;overflow-y:auto;background:#2b2d31;border-radius:8px;margin-top:4px}
.rl::-webkit-scrollbar{width:4px}
.rl::-webkit-scrollbar-thumb{background:#3c3f45;border-radius:4px}
.ri{padding:5px 9px;border-bottom:1px solid #111214;font-size:11px;line-height:1.4;color:#b5bac1;word-break:break-all}
.ri:last-child{border-bottom:none}
.rt{color:#5865f2;font-size:10px;margin-right:3px}
.div{height:1px;background:#2b2d31;flex-shrink:0}
`;

  /* ── HTML ── */
  const HTML = `
<div id="panel" class="hidden">
  <div class="ph" id="drag">
    <div class="pt">
      <svg viewBox="0 0 24 24"><path d="M7.5 4.5h9l-.6 2H8.1l-.6-2Z"/><path d="M9 8h6l-.5 10.5a1.8 1.8 0 0 1-1.8 1.7h-1.4a1.8 1.8 0 0 1-1.8-1.7L9 8Z"/><path d="M10.8 10.5v7M13.2 10.5v7"/></svg>
      消息清理器
    </div>
    <button class="xbtn" id="close">✕</button>
  </div>
  <div class="pb">
    <div>
      <div class="fl">Discord Token</div>
      <div class="fr">
        <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="点「自动」或手动粘贴">
        <button class="bs bsm" id="auto-tok">
          <svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14.93-4M20 12a8 8 0 0 1-14.93 4"/><path d="M18 4v4h-4M6 20v-4H2"/></svg>
          自动
        </button>
      </div>
    </div>
    <div>
      <div class="fl">服务器 ID</div>
      <div class="fr">
        <input id="guildId" type="text" inputmode="numeric" autocomplete="off" placeholder="服务器 ID">
        <button class="bs bsm" id="fill-cur">
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          当前
        </button>
      </div>
    </div>
    <div>
      <div class="fl">频道 ID</div>
      <input id="channelId" type="text" inputmode="numeric" autocomplete="off" placeholder="频道 ID">
    </div>
    <div class="g2">
      <div><div class="fl">最多删除</div><input id="limit" type="number" min="1" max="5000" value="100"></div>
      <div><div class="fl">间隔(ms)</div><input id="delay" type="number" min="800" max="30000" step="100" value="1600"></div>
    </div>
    <div class="g2">
      <div><div class="fl">起始时间</div><input id="after" type="datetime-local"></div>
      <div><div class="fl">结束时间</div><input id="before" type="datetime-local"></div>
    </div>
    <div class="ck">
      <input type="checkbox" id="disclaimer">
      <label for="disclaimer">我确认只删除自己的消息，删除不可恢复。</label>
    </div>
    <div class="div"></div>
    <div class="g2b">
      <button class="bp" id="preview-btn">
        <svg viewBox="0 0 24 24"><path d="M4 12s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>
        预览
      </button>
      <button class="bd" id="delete-btn" disabled>
        <svg viewBox="0 0 24 24"><path d="M7.5 4.5h9M9 8h6l-.5 10.5a1.8 1.8 0 0 1-1.8 1.7h-1.4a1.8 1.8 0 0 1-1.8-1.7L9 8ZM10.8 10.5v7M13.2 10.5v7"/></svg>
        删除预览
      </button>
    </div>
    <div class="g2b">
      <button class="bw" id="ui-start">
        <svg viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5-10-6.5Z"/></svg>
        免Token删除
      </button>
      <button class="bw" id="ui-stop">
        <svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>
        停止
      </button>
    </div>
    <div class="sb">
      <div class="st" id="state">待机</div>
      <div class="sd" id="details">打开 Discord 后 token 将自动填入，填好 ID 后点预览。</div>
    </div>
    <div>
      <div class="rh">
        <span class="fl" style="margin:0">预览结果</span>
        <span class="rc" id="count">0 条</span>
      </div>
      <ol class="rl" id="messages"></ol>
    </div>
  </div>
</div>`;

  /* ── inject panel ── */
  function inject() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    const wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    shadow.appendChild(wrap);
    initPanel(shadow);
  }

  /* ── panel logic ── */
  function initPanel(root) {
    const $ = id => root.getElementById(id);
    const panel = $('panel');

    /* helpers */
    function setStatus(s, d) { $('state').textContent = s; $('details').textContent = d; }

    function readOpts() {
      const guildId = $('guildId').value.trim();
      const channelId = $('channelId').value.trim();
      if (!/^\d{15,25}$/.test(guildId)) throw new Error('服务器 ID 格式不对。');
      if (!/^\d{15,25}$/.test(channelId)) throw new Error('频道 ID 格式不对。');
      if (!$('disclaimer').checked) throw new Error('请先勾选免责声明。');
      const limit = Math.min(Math.max(Number($('limit').value) || 100, 1), 5000);
      const delayMs = Math.min(Math.max(Number($('delay').value) || 1600, 800), 30000);
      const after = $('after').value ? new Date($('after').value) : null;
      const before = $('before').value ? new Date($('before').value) : null;
      if (after && before && after >= before) throw new Error('起始时间必须早于结束时间。');
      return { guildId, channelId, limit, delayMs, after, before };
    }

    function getToken() {
      const t = $('token').value.trim();
      if (!t) throw new Error('请先填入或自动获取 token。');
      return t;
    }

    function renderMessages(msgs) {
      st.previewed = msgs;
      $('count').textContent = msgs.length + ' 条';
      const ol = $('messages');
      ol.textContent = '';
      const frag = document.createDocumentFragment();
      for (const m of msgs.slice(0, 50)) {
        const li = document.createElement('li');
        li.className = 'ri';
        const time = new Date(m.timestamp || sfTime(m.id)).toLocaleString();
        const txt = (m.content?.trim() || '[无文本]').slice(0, 80);
        li.innerHTML = `<span class="rt">${time}</span>${txt}`;
        frag.appendChild(li);
      }
      if (msgs.length > 50) {
        const li = document.createElement('li');
        li.className = 'ri';
        li.textContent = `…还有 ${msgs.length - 50} 条未展示`;
        frag.appendChild(li);
      }
      ol.appendChild(frag);
      $('delete-btn').disabled = msgs.length === 0;
    }

    /* save/restore */
    async function save() {
      await chrome.storage.local.set({ cleanerOpts: {
        guildId: $('guildId').value, channelId: $('channelId').value,
        limit: $('limit').value, delayMs: $('delay').value,
        after: $('after').value, before: $('before').value,
      }});
    }
    async function restore() {
      const { cleanerOpts: o = {} } = await chrome.storage.local.get('cleanerOpts');
      if (o.guildId) $('guildId').value = o.guildId;
      if (o.channelId) $('channelId').value = o.channelId;
      if (o.limit) $('limit').value = o.limit;
      if (o.delayMs) $('delay').value = o.delayMs;
      if (o.after) $('after').value = o.after;
      if (o.before) $('before').value = o.before;
    }

    /* auto token */
    function tryAutoToken() {
      const tok = extractToken();
      if (tok) { $('token').value = tok; setStatus('已自动获取 Token', '可直接填 ID 后点预览。'); }
    }

    /* drag */
    const drag = $('drag');
    let ox = 0, oy = 0, dragging = false;
    drag.addEventListener('mousedown', e => {
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left; oy = e.clientY - rect.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.left = (e.clientX - ox) + 'px';
      panel.style.top = (e.clientY - oy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    /* toggle */
    function toggle() {
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) tryAutoToken();
    }
    $('close').addEventListener('click', () => panel.classList.add('hidden'));

    /* fill current */
    $('fill-cur').addEventListener('click', () => {
      const m = location.pathname.match(/\/channels\/(\d{15,25})\/(\d{15,25})/);
      if (!m) { setStatus('无法填充', '当前不是频道页面。'); return; }
      $('guildId').value = m[1]; $('channelId').value = m[2];
      save().catch(() => {});
      setStatus('已填充', '已从当前 URL 读取 ID。');
    });

    /* auto token button */
    $('auto-tok').addEventListener('click', () => {
      const tok = extractToken();
      if (tok) { $('token').value = tok; setStatus('Token 已获取', '可直接点预览。'); }
      else setStatus('获取失败', '请手动粘贴 token。');
    });

    /* preview */
    $('preview-btn').addEventListener('click', async () => {
      $('preview-btn').disabled = true;
      renderMessages([]);
      try {
        const token = getToken();
        const opts = readOpts();
        await save();
        setStatus('校验中', '正在验证账号和频道…');
        const me = await apiFetch(token, '/users/@me');
        const ch = await apiFetch(token, `/channels/${opts.channelId}`);
        if (String(ch.guild_id || '') !== opts.guildId) throw new Error('频道不属于该服务器。');
        setStatus('预览中', `账号 ${me.username}，频道 ${ch.name || opts.channelId}`);
        const msgs = await collectMessages(token, opts, me.id, setStatus);
        st.previewCtx = { opts, meId: me.id };
        renderMessages(msgs);
        setStatus('预览完成', `找到 ${msgs.length} 条可删除消息。`);
      } catch (e) { setStatus('失败', e.message); }
      finally { $('preview-btn').disabled = false; }
    });

    /* delete previewed */
    $('delete-btn').addEventListener('click', async () => {
      if (st.deleting) return;
      if (!st.previewCtx || !st.previewed.length) { setStatus('请先预览', ''); return; }
      if (!confirm(`将删除 ${st.previewed.length} 条消息，删除不可恢复，确认继续？`)) return;
      st.deleting = true;
      $('preview-btn').disabled = true; $('delete-btn').disabled = true;
      let done = 0;
      try {
        const token = getToken();
        for (const m of st.previewed) {
          await apiFetch(token, `/channels/${st.previewCtx.opts.channelId}/messages/${m.id}`, { method: 'DELETE' });
          done++;
          setStatus('删除中', `已删除 ${done}/${st.previewed.length} 条。`);
          await sleep(st.previewCtx.opts.delayMs);
        }
        renderMessages([]);
        st.previewCtx = null;
        setStatus('完成', `已删除 ${done} 条消息。`);
      } catch (e) { setStatus('失败', e.message); }
      finally { st.deleting = false; $('preview-btn').disabled = false; }
    });

    /* UI mode */
    $('ui-start').addEventListener('click', async () => {
      if (st.running) { setStatus('已在运行', '如需停止请点「停止」。'); return; }
      const limit = Math.min(Math.max(Number($('limit').value) || 100, 1), 500);
      const delayMs = Math.min(Math.max(Number($('delay').value) || 1600, 800), 10000);
      runUiMode({ limit, delayMs, autoScroll: true }, setStatus);
    });
    $('ui-stop').addEventListener('click', () => { st.stopRequested = true; setStatus('正在停止…', ''); });

    /* init */
    restore().catch(() => {});
    tryAutoToken();

    /* expose toggle to message listener */
    root._toggle = toggle;
  }

  /* ── message listener ── */
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === 'TOGGLE_PANEL') {
      const host = document.getElementById(HOST_ID);
      if (host?.shadowRoot?._toggle) {
        host.shadowRoot._toggle();
      } else {
        inject();
        setTimeout(() => {
          const h = document.getElementById(HOST_ID);
          if (h?.shadowRoot?._toggle) h.shadowRoot._toggle();
        }, 100);
      }
      respond({ ok: true });
      return false;
    }
    return false;
  });

  /* ── boot ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
