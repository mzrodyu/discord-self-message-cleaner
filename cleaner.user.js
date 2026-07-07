// ==UserScript==
// @name         Discord 自助冲水机 (Discord Self Message Cleaner)
// @namespace    http://tampermonkey.net/
// @version      0.5.0
// @description  自动获取Token，批量删除Discord历史消息，支持倒序和自定义限速。
// @author       mzrodyu / catie
// @match        https://discord.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=discord.com
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @license      MIT
// ==/UserScript==

/* Discord Self Message Cleaner – floating panel injected into Discord */
(function () {
  'use strict';

  const HOST_ID = 'dsc-cleaner-host';
  const API_BASE = 'https://discord.com/api/v10';
  const EPOCH = 1420070400000n;

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
    let res;
    try {
      res = await fetch(API_BASE + path, {
        ...opts,
        headers: { Authorization: token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
    } catch (e) {
      // 网络错误断线重连
      if (attempt < 5) { await sleep(3000); return apiFetch(token, path, opts, attempt + 1); }
      throw new Error(`网络请求失败: ${e.message}`);
    }
    
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      const wait = j.retry_after ? Math.ceil(Number(j.retry_after) * 1000) : (Math.pow(2, attempt) * 1000);
      if (attempt < 5) { await sleep(wait + 500); return apiFetch(token, path, opts, attempt + 1); }
      throw new Error('触发限速且重试次数耗尽。');
    }
    if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`API ${res.status}: ${b.slice(0, 120)}`); }
    return res.status === 204 ? null : res.json();
  }

  async function collectMessages(token, opts, meId, setStatus) {
    const msgs = [];
    let go = true;
    
    // SERVER MODE: Hybrid Search-then-Scan
    if (!opts.channelId && opts.guildId && opts.guildId !== '@me') {
      let offset = 0;
      while (go && msgs.length < opts.limit) {
        let p = new URLSearchParams({ author_id: meId, offset: String(offset) });
        if (opts.order === 'asc') p.set('sort_order', 'asc');
        else p.set('sort_order', 'desc');
        
        if (opts.after) p.set('min_id', tsToSf(opts.after));
        if (opts.before) p.set('max_id', tsToSf(opts.before));

        setStatus('全服检索中', `正通过高级搜索 API 扫描... 已找到 ${msgs.length} 条 (受接口限速，速度较慢)`);
        let res;
        try {
          res = await apiFetch(token, `/guilds/${opts.guildId}/messages/search?include_nsfw=true&${p}`);
        } catch(e) {
          throw new Error(`全服检索失败: ${e.message}`);
        }

        if (res && res.message === 'Indexing') {
          setStatus('索引中', 'Discord 正在为您建立全服索引，等待10秒后重试...');
          await sleep(10000);
          continue; // retry same offset
        }

        if (!res || !res.messages || res.messages.length === 0) break;
        
        for (const hit of res.messages) {
          // 'hit' is an array of messages representing context, we want the one that hit the search query
          const m = hit.find(msg => msg.hit === true) || hit.find(msg => msg.author?.id === meId) || hit[0];
          if (!m) continue;

          const t = new Date(m.timestamp || sfTime(m.id));
          const inRange = (!opts.after || t >= opts.after) && (!opts.before || t <= opts.before);
          
          if (inRange && m.author?.id === meId) {
             msgs.push(m);
             if (msgs.length >= opts.limit) { go = false; break; }
          }
        }
        
        if (res.messages.length < 25) break; // Reached end of search results
        offset += res.messages.length;
        await sleep(1200); // strict rate limit for search API
      }
      return msgs;
    }

    // CHANNEL MODE: Standard Message Iteration
    let boundary = null;
    
    if (opts.order === 'desc') {
        boundary = opts.before ? tsToSf(opts.before) : null;
    } else {
        boundary = opts.after ? tsToSf(opts.after) : '0';
    }

    while (go && msgs.length < opts.limit) {
      if (!opts.channelId) throw new Error("频道 ID 不能为空（除非指定具体的服务器 ID 开启全服清理）");
      
      const p = new URLSearchParams({ limit: '100' });
      if (boundary) p.set(opts.order === 'desc' ? 'before' : 'after', boundary);
      
      const batch = await apiFetch(token, `/channels/${opts.channelId}/messages?${p}`);
      if (!Array.isArray(batch) || !batch.length) break;

      for (const m of batch) {
        const t = new Date(m.timestamp || sfTime(m.id));
        
        if (opts.order === 'desc') {
            if (opts.after && t < opts.after) { go = false; break; }
        } else {
            if (opts.before && t > opts.before) { go = false; break; }
        }

        if (m.author?.id === meId) {
          const inRange = (!opts.after || t >= opts.after) && (!opts.before || t <= opts.before);
          if (inRange) { msgs.push(m); if (msgs.length >= opts.limit) break; }
        }
      }
      boundary = batch[batch.length - 1].id;
      setStatus('预览中', `扫描中... 已找到 ${msgs.length} 条。`);
      await sleep(100);
    }
    return msgs;
  }

  /* ── CSS ── */
  const CSS = `
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#panel{position:fixed;bottom:24px;right:24px;width:680px;height:580px;background:#1e1f22;border:1px solid #2b2d31;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.65);display:flex;flex-direction:column;z-index:2147483647;overflow:hidden;color:#dbdee1;font-size:13px}
#panel.hidden{display:none}
.panel-body{display:flex;flex:1;overflow:hidden;}
.sidebar{width:150px;background:#111214;display:flex;flex-direction:column;padding:12px 0;border-right:1px solid #111214;}
.tab-btn{padding:12px 16px;cursor:pointer;color:#949ba4;font-size:13px;font-weight:600;transition:all 0.2s;border-left:3px solid transparent;display:flex;align-items:center;gap:8px;}
.tab-btn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
.tab-btn:hover{background:#1e1f22;color:#dbdee1;}
.tab-btn.active{background:#1e1f22;color:#fff;border-left-color:#5865f2;}
.content{flex:1;display:flex;flex-direction:column;overflow:hidden;position:relative;background:#2b2d31;}
.tab-pane{display:none !important;flex-direction:column;flex:1;overflow-y:auto;padding:16px 20px;gap:12px;position:relative;}
.tab-pane.active{display:flex !important;}
.tab-pane::-webkit-scrollbar{width:6px}
.tab-pane::-webkit-scrollbar-thumb{background:#3c3f45;border-radius:6px}
.stat-card{background:#1e1f22;border-radius:8px;padding:24px;text-align:center;margin-bottom:15px;border:1px solid #111214;}
.stat-num{font-size:48px;font-weight:bold;color:#5865f2;margin:12px 0;}
.ph{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;background:#2b2d31;cursor:grab;flex-shrink:0;border-bottom:1px solid #111214}
.ph:active{cursor:grabbing}
.pt{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;color:#f2f3f5}
.pt svg{width:18px;height:18px;fill:none;stroke:#5865f2;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.xbtn{background:none;border:none;color:#80848e;cursor:pointer;padding:4px 6px;border-radius:6px;font-size:16px;line-height:1;display:flex;align-items:center}
.xbtn:hover{color:#f2f3f5;background:#3c3f45}
.pb{overflow-y:auto;flex:1;padding:12px 16px;display:flex;flex-direction:column;gap:12px;position:relative}
.pb::-webkit-scrollbar{width:6px}
.pb::-webkit-scrollbar-thumb{background:#3c3f45;border-radius:6px}
.fl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#80848e;margin-bottom:4px}
.fr{display:flex;gap:6px;align-items:center}
input[type=text],input[type=password],input[type=number],input[type=datetime-local]{flex:1;background:#2b2d31;border:1px solid #111214;border-radius:8px;padding:8px 10px;color:#dbdee1;font-size:13px;font-family:inherit;outline:none;min-width:0;transition:border-color .15s}
input:focus{border-color:#5865f2}
input::placeholder{color:#4e5058}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 12px;border:none;border-radius:8px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;transition:filter .15s;white-space:nowrap}
button:hover:not(:disabled){filter:brightness(1.15)}
button:disabled{opacity:.45;cursor:not-allowed}
button svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.bp{background:#5865f2;color:#fff}
.bs{background:#3c3f45;color:#dbdee1}
.bd{background:#ed4245;color:#fff}
.bw{background:#2b2d31;color:#80848e;border:1px solid #3c3f45}
.bsm{padding:6px 10px;font-size:12px}
.g2b{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ck{display:flex;align-items:flex-start;gap:8px;padding:10px;background:#2b2d31;border-radius:8px}
.ck input[type=checkbox]{width:16px;height:16px;margin-top:2px;flex-shrink:0;accent-color:#5865f2;cursor:pointer}
.ck label{font-size:12px;color:#dbdee1;line-height:1.45;cursor:pointer}
.radio-group{display:flex;gap:16px;align-items:center}
.radio-label{display:flex;align-items:center;gap:6px;font-size:13px;color:#dbdee1;cursor:pointer}
.radio-label input[type=radio]{margin:0;accent-color:#5865f2;width:14px;height:14px;cursor:pointer}
.sb{background:#2b2d31;border-radius:8px;padding:10px 12px;border-left:4px solid #5865f2}
.st{font-weight:700;font-size:13px;color:#f2f3f5;margin-bottom:4px}
.sd{font-size:12px;color:#b5bac1;line-height:1.4;word-break:break-all}
.rh{display:flex;justify-content:space-between;align-items:center}
.rc{background:#3c3f45;border-radius:999px;padding:2px 8px;font-size:11px;color:#dbdee1}
.rl{max-height:160px;overflow-y:auto;background:#2b2d31;border-radius:8px;margin-top:6px;list-style:none;padding:0;margin-bottom:0}
.rl::-webkit-scrollbar{width:6px}
.rl::-webkit-scrollbar-thumb{background:#3c3f45;border-radius:6px}
.ri{padding:8px 10px;border-bottom:1px solid #1e1f22;font-size:12px;line-height:1.4;color:#dbdee1;word-break:break-all}
.ri:last-child{border-bottom:none}
.rt{color:#5865f2;font-size:11px;margin-right:6px}
.div{height:1px;background:#2b2d31;flex-shrink:0}
.about{text-align:center;font-size:11px;color:#80848e;padding:10px 0;line-height:1.6}
.about a{color:#00a8fc;text-decoration:none}
.about a:hover{text-decoration:underline}

/* Picker Overlay */
#picker{position:absolute;top:0;left:0;right:0;bottom:0;background:#1e1f22;z-index:10;display:flex;flex-direction:column}
#picker.hidden{display:none}
.pkh{display:flex;align-items:center;padding:12px 16px;background:#2b2d31;border-bottom:1px solid #111214}
.pkh span{flex:1;text-align:center;font-weight:700;font-size:14px;color:#f2f3f5}
.pk-back{background:none;border:none;color:#dbdee1;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:4px;padding:4px}
.pk-back:hover{color:#fff}
.pk-list{flex:1;overflow-y:auto;padding:8px}
.pk-list::-webkit-scrollbar{width:6px}
.pk-list::-webkit-scrollbar-thumb{background:#3c3f45;border-radius:6px}
.pk-item{display:flex;align-items:center;gap:12px;padding:10px;border-radius:8px;cursor:pointer;color:#dbdee1;transition:background .15s}
.pk-item:hover{background:#2b2d31}
.pk-icon{width:36px;height:36px;border-radius:50%;background:#3c3f45;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;font-size:14px}
.pk-icon img{width:100%;height:100%;object-fit:cover}
.pk-name{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pk-type{font-size:12px;color:#80848e;margin-top:2px}
.pk-empty{text-align:center;padding:30px 20px;color:#80848e;font-size:13px}
`;

  /* ── HTML ── */
  const HTML = `
<div id="panel" class="hidden">
  <div class="ph" id="drag">
    <div class="pt">
      <svg viewBox="0 0 24 24"><path d="M7.5 4.5h9l-.6 2H8.1l-.6-2Z"/><path d="M9 8h6l-.5 10.5a1.8 1.8 0 0 1-1.8 1.7h-1.4a1.8 1.8 0 0 1-1.8-1.7L9 8Z"/><path d="M10.8 10.5v7M13.2 10.5v7"/></svg>
      Discord 消息清理器
    </div>
    <button class="xbtn" id="close">✕</button>
  </div>
  
  <div class="panel-body">
    <div class="sidebar">
      <div class="tab-btn active" data-tab="tab-basic">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
        基础清理
      </div>
      <div class="tab-btn" data-tab="tab-stats">
        <svg viewBox="0 0 24 24"><path d="M18 20V10M12 20V4M6 20v-6"></path></svg>
        发言统计
      </div>
      <div class="tab-btn" data-tab="tab-about">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4M12 8h.01"></path></svg>
        关于工具
      </div>
    </div>
    
    <div class="content">
      <div id="tab-basic" class="tab-pane active">
    <div>
      <div class="fl">Discord Token</div>
      <div class="fr">
        <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="自动填入或手动粘贴">
        <button class="bs bsm" id="auto-tok">
          <svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14.93-4M20 12a8 8 0 0 1-14.93 4"/><path d="M18 4v4h-4M6 20v-4H2"/></svg>自动
        </button>
      </div>
    </div>
    
    <div>
      <div class="fl">服务器 ID</div>
      <div class="fr">
        <input id="guildId" type="text" inputmode="numeric" autocomplete="off" placeholder="点击列表选择或手动填写">
        <button class="bs bsm" id="btn-picker">
          <svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18"/></svg>列表
        </button>
        <button class="bs bsm" id="fill-cur" title="填入当前页面ID">
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>当前
        </button>
      </div>
    </div>
    
    <div>
      <div class="fl">频道 ID</div>
      <input id="channelId" type="text" inputmode="numeric" autocomplete="off" placeholder="频道 ID">
    </div>

    <div>
      <div class="fl">清理方向</div>
      <div class="radio-group">
        <label class="radio-label">
          <input type="radio" name="order" value="desc" checked> 从新到老 (倒序排)
        </label>
        <label class="radio-label" title="优先删除历史遗留消息">
          <input type="radio" name="order" value="asc"> 从老到新 (顺着删)
        </label>
      </div>
    </div>
    
    <div class="g2">
      <div><div class="fl">最多删除</div><input id="limit" type="number" min="1" max="5000" value="100"></div>
      <div><div class="fl">间隔(ms)</div><input id="delay" type="number" min="100" max="30000" step="100" value="1600"></div>
    </div>
    
    <div class="g2">
      <div><div class="fl">起始时间</div><input id="after" type="datetime-local"></div>
      <div>
        <div class="fl" style="display:flex; justify-content:space-between;">
          <span>结束时间</span>
          <span id="set-now" style="color:#00a8fc; cursor:pointer; text-transform:none;">同步最新</span>
        </div>
        <input id="before" type="datetime-local">
      </div>
    </div>
    
    <div class="ck">
      <input type="checkbox" id="disclaimer">
      <label for="disclaimer">我确认只删除自己的消息，删除不可恢复。</label>
    </div>
    
    <div class="div"></div>
    
    <div class="g2b">
      <button class="bp" id="preview-btn">
        <svg viewBox="0 0 24 24"><path d="M4 12s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>预览
      </button>
      <button class="bd" id="delete-btn" disabled>
        <svg viewBox="0 0 24 24"><path d="M7.5 4.5h9M9 8h6l-.5 10.5a1.8 1.8 0 0 1-1.8 1.7h-1.4a1.8 1.8 0 0 1-1.8-1.7L9 8ZM10.8 10.5v7M13.2 10.5v7"/></svg>删除预览
      </button>
    </div>
    
    <div class="sb">
      <div class="st" id="state">待机</div>
      <div class="sd" id="details">加载完成后自动提取 token，可点击「列表」选择频道。</div>
    </div>
    
    <div>
      <div class="rh">
        <span class="fl" style="margin:0">预览结果</span>
        <span class="rc" id="count">0 条</span>
      </div>
      <ul class="rl" id="messages"></ul>
    </div>
    
      </div>
      
      <div id="tab-stats" class="tab-pane">
        <div class="g2">
          <div>
            <div class="fl">服务器 ID</div>
            <div class="fr">
              <input id="stat-guild" type="text" placeholder="留空查私信">
              <button class="bs bsm" id="stat-btn-picker" title="从列表选择">
                <svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18"/></svg>列表
              </button>
              <button class="bs bsm" id="stat-fill-cur" title="填入当前页面ID">
                <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>当前
              </button>
            </div>
          </div>
          <div><div class="fl">频道 ID</div><input id="stat-channel" type="text" placeholder="可选"></div>
        </div>
        <div class="div" style="margin:12px 0"></div>
        <button class="bp" id="stat-btn">
          <svg viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>查询总发言量
        </button>
        
        <div class="stat-card" style="margin-top:15px;">
          <div style="font-size:13px;color:#949ba4;">当前范围总发言数</div>
          <div class="stat-num" id="stat-result">-</div>
          <div style="font-size:11px;color:#80848e;">*调用高级检索接口，可能受风控影响。</div>
          <div id="stat-err-msg" style="color:#da373c;font-size:12px;margin-top:8px;"></div>
        </div>
        <button class="bd" id="stat-del-btn" style="display:none;width:100%">将此作为目标进行清理</button>
      </div>
      
      <div id="tab-about" class="tab-pane">
        <div class="about">
          作者: mzrodyu / catie<br>
          <a href="https://github.com/mzrodyu/discord-self-message-cleaner" target="_blank">View on GitHub</a>
        </div>
      </div>
    </div>
  </div>

  <!-- Picker Overlay -->
  <div id="picker" class="hidden">
    <div class="pkh">
      <button class="pk-back" id="pk-back" style="visibility:hidden">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg> 返回
      </button>
      <span id="pk-title">选择服务器</span>
      <button class="xbtn" id="pk-close">✕</button>
    </div>
    <div style="padding:10px 12px; border-bottom:1px solid #111214; background:#2b2d31;">
      <input type="text" id="pk-search" placeholder="搜索频道或服务器名称..." style="width:100%; padding:8px 10px; font-size:12px; border-radius:6px; background:#1e1f22; border:none; outline:none; color:#dbdee1;">
    </div>
    <div class="pk-list" id="pk-list"></div>
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
      if (!/^(\d{15,25}|@me)$/.test(guildId)) throw new Error('服务器 ID 格式不对。');
      if (!/^\d{15,25}$/.test(channelId)) throw new Error('频道 ID 格式不对。');
      if (!$('disclaimer').checked) throw new Error('请先勾选免责声明。');
      const limit = Math.min(Math.max(Number($('limit').value) || 100, 1), 5000);
      const delayMs = Math.min(Math.max(Number($('delay').value) || 1600, 100), 30000);
      const after = $('after').value ? new Date($('after').value) : null;
      const before = $('before').value ? new Date($('before').value) : null;
      if (after && before && after >= before) throw new Error('起始时间必须早于结束时间。');
      const order = root.querySelector('input[name="order"]:checked').value;
      return { guildId, channelId, limit, delayMs, after, before, order };
    }

    function getToken() {
      const t = $('token').value.trim();
      if (!t) throw new Error('请先填入或自动获取 token。');
      return t;
    }

    function renderMessages(msgs) {
      st.previewed = msgs;
      $('count').textContent = msgs.length + ' 条';
      const ul = $('messages');
      ul.textContent = '';
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
      ul.appendChild(frag);
      $('delete-btn').disabled = msgs.length === 0;
    }

    /* save/restore */
    async function save() {
      const data = {
        guildId: $('guildId').value, channelId: $('channelId').value,
        limit: $('limit').value, delayMs: $('delay').value,
        after: $('after').value, before: $('before').value,
        order: root.querySelector('input[name="order"]:checked')?.value || 'desc'
      };
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ cleanerOpts: data }).catch(() => {});
      } else if (typeof GM_setValue !== 'undefined') {
        GM_setValue('cleanerOpts', JSON.stringify(data));
      } else {
        localStorage.setItem('cleanerOpts', JSON.stringify(data));
      }
    }
    async function restore() {
      let o = {};
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const res = await chrome.storage.local.get('cleanerOpts').catch(() => ({}));
        o = res.cleanerOpts || {};
      } else if (typeof GM_getValue !== 'undefined') {
        try { o = JSON.parse(GM_getValue('cleanerOpts', '{}')); } catch (e) {}
      } else {
        try { o = JSON.parse(localStorage.getItem('cleanerOpts') || '{}'); } catch (e) {}
      }
      if (o.guildId) $('guildId').value = o.guildId;
      if (o.channelId) $('channelId').value = o.channelId;
      if (o.limit) $('limit').value = o.limit;
      if (o.delayMs) $('delay').value = o.delayMs;
      if (o.after) $('after').value = o.after;
      if (o.before) $('before').value = o.before;
      if (o.order) {
        const radio = root.querySelector(`input[name="order"][value="${o.order}"]`);
        if (radio) radio.checked = true;
      }
    }

    /* auto token */
    function tryAutoToken() {
      const tok = extractToken();
      if (tok) { $('token').value = tok; setStatus('已获取 Token', '点击「列表」选择服务器和频道。'); }
    }

    /* drag */
    const drag = $('drag');
    let ox = 0, oy = 0, dragging = false;
    drag.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
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

    /* toggle main panel */
    function toggle() {
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) {
        tryAutoToken();
        if (!$('before').value) syncNow();
      }
    }
    $('close').addEventListener('click', () => panel.classList.add('hidden'));

    /* sync time */
    function syncNow() {
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      $('before').value = now.toISOString().slice(0, 16);
      save().catch(() => {});
    }
    $('set-now').addEventListener('click', syncNow);

    /* fill current */
    $('fill-cur').addEventListener('click', () => {
      const m = location.pathname.match(/\/channels\/(\d{15,25}|@me)\/(\d{15,25})/);
      if (!m) { setStatus('无法填充', '当前不在具体的频道/私信页面。'); return; }
      $('guildId').value = m[1]; $('channelId').value = m[2];
      save().catch(() => {});
      setStatus('已填充', '已从当前 URL 读取 ID。');
    });

    $('stat-fill-cur').addEventListener('click', () => {
      const m = location.pathname.match(/\/channels\/(\d{15,25}|@me)\/(\d{15,25})/);
      if (!m) { setStatus('无法填充', '当前不在具体的频道/私信页面。'); return; }
      $('stat-guild').value = m[1]; $('stat-channel').value = m[2];
      setStatus('已填充', '已从当前 URL 读取 ID。');
    });

    /* auto token button */
    $('auto-tok').addEventListener('click', () => {
      const tok = extractToken();
      if (tok) { $('token').value = tok; setStatus('Token 已获取', '可点击列表进行选择。'); }
      else setStatus('获取失败', '请手动粘贴 token。');
    });

    /* --- Picker Logic --- */
    const picker = $('picker');
    const pkList = $('pk-list');
    const pkTitle = $('pk-title');
    const pkBack = $('pk-back');
    let pkState = 'guilds'; // 'guilds' | 'channels'
    let pkCurrentGuild = null; // { id, name }
    let pkTarget = 'basic'; // 'basic' | 'stats'
    let pkCurrentItems = [];
    let pkCurrentType = 'guilds';

    function openPicker(target = 'basic') {
      pkTarget = target;
      picker.classList.remove('hidden');
      root.getElementById('pk-search').value = '';
      loadGuilds();
    }

    function closePicker() {
      picker.classList.add('hidden');
    }

    $('btn-picker').addEventListener('click', () => {
      try { getToken(); openPicker('basic'); } catch (e) { setStatus('需要 Token', e.message); }
    });
    $('stat-btn-picker').addEventListener('click', () => {
      try { getToken(); openPicker('stats'); } catch (e) { setStatus('需要 Token', e.message); }
    });
    $('pk-close').addEventListener('click', closePicker);
    pkBack.addEventListener('click', () => {
      if (pkState === 'channels') loadGuilds();
    });

    $('pk-search').addEventListener('input', e => {
      const q = e.target.value.trim().toLowerCase();
      if (!q) return _renderFilteredList(pkCurrentItems, pkCurrentType);
      const filtered = pkCurrentItems.filter(it => (it.name || it.id || '').toLowerCase().includes(q) || (it.id === '@me' && '私信私聊'.includes(q)));
      _renderFilteredList(filtered, pkCurrentType);
    });

    function renderList(items, type) {
      pkCurrentItems = items;
      pkCurrentType = type;
      _renderFilteredList(items, type);
    }

    function _renderFilteredList(items, type) {
      pkList.innerHTML = '';
      if (!items.length) {
        pkList.innerHTML = '<div class="pk-empty">没有找到项目</div>';
        return;
      }
      items.forEach(it => {
        const div = document.createElement('div');
        div.className = 'pk-item';
        
        let iconHtml = '';
        if (type === 'guilds') {
          if (it.id === '@me') {
            iconHtml = '@';
          } else if (it.icon) {
            iconHtml = `<img src="https://cdn.discordapp.com/icons/${it.id}/${it.icon}.png?size=64">`;
          } else {
            iconHtml = it.name.charAt(0);
          }
        } else {
          // channels
          iconHtml = '#';
          if (it.type === 'server_wide') iconHtml = '🌐';
          else if (it.type === 2) iconHtml = 'V'; // voice
          else if (it.type === 1) iconHtml = 'U'; // DM
          else if (it.type === 3) iconHtml = 'G'; // Group DM
        }

        div.innerHTML = `
          <div class="pk-icon">${iconHtml}</div>
          <div style="min-width:0;flex:1;">
            <div class="pk-name">${it.name || '未命名'}</div>
            <div class="pk-type">${it.id}</div>
          </div>
        `;

        div.addEventListener('click', () => {
          if (type === 'guilds') {
            loadChannels(it.id, it.name);
          } else {
            // Picked channel
            if (pkTarget === 'basic') {
              $('guildId').value = pkCurrentGuild.id;
              $('channelId').value = it.id;
              save().catch(()=>{});
            } else {
              $('stat-guild').value = pkCurrentGuild.id;
              $('stat-channel').value = it.id;
            }
            setStatus('已选择', `[${pkCurrentGuild.name}] -> [${it.name}]`);
            closePicker();
          }
        });
        pkList.appendChild(div);
      });
    }

    async function loadGuilds() {
      pkState = 'guilds';
      pkCurrentGuild = null;
      pkTitle.textContent = '选择服务器/私聊';
      pkBack.style.visibility = 'hidden';
      pkList.innerHTML = '<div class="pk-empty">正在加载...</div>';
      
      try {
        const token = getToken();
        const guilds = await apiFetch(token, '/users/@me/guilds');
        const list = [{ id: '@me', name: '私信与群聊 (DMs)' }, ...guilds];
        renderList(list, 'guilds');
      } catch (e) {
        pkList.innerHTML = `<div class="pk-empty" style="color:#ed4245">加载失败: ${e.message}</div>`;
      }
    }

    async function loadChannels(guildId, guildName) {
      pkState = 'channels';
      pkCurrentGuild = { id: guildId, name: guildName };
      pkTitle.textContent = guildName;
      pkBack.style.visibility = 'visible';
      root.getElementById('pk-search').value = '';
      pkList.innerHTML = '<div class="pk-empty">正在加载...</div>';

      try {
        const token = getToken();
        let channels = [];
        if (guildId === '@me') {
          const dms = await apiFetch(token, '/users/@me/channels');
          // For DMs, format names since they might be arrays of recipients
          channels = dms.map(c => {
            let name = c.name;
            if (!name && c.recipients) name = c.recipients.map(r => r.global_name || r.username).join(', ');
            return { id: c.id, name: name || '未知私聊', type: c.type };
          });
        } else {
          const rawChannels = await apiFetch(token, `/guilds/${guildId}/channels`);
          // Filter out categories (type 4)
          channels = rawChannels.filter(c => c.type !== 4).map(c => ({
            id: c.id, name: c.name, type: c.type
          }));
          channels.unshift({ id: '', name: '--- 全服扫描清理 (不限频道) ---', type: 'server_wide' });
        }
        renderList(channels, 'channels');
      } catch (e) {
        pkList.innerHTML = `<div class="pk-empty" style="color:#ed4245">加载失败: ${e.message}</div>`;
      }
    }
    /* --- End Picker Logic --- */

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
        let chName = '全服扫描';
        
        if (opts.channelId) {
          const ch = await apiFetch(token, `/channels/${opts.channelId}`);
          chName = ch.name || opts.channelId;
          // 只有不是私信时才校验 guild_id
          if (opts.guildId !== '@me' && String(ch.guild_id || '') !== opts.guildId) {
            throw new Error('频道不属于填写的服务器。');
          }
        } else if (opts.guildId && opts.guildId !== '@me') {
          // Verify guild
          const g = await apiFetch(token, `/guilds/${opts.guildId}`);
          chName = g.name || '全服';
        } else {
          throw new Error('请输入具体的频道ID，或者填写具体的服务器ID进行全服扫描！');
        }

        const dirStr = opts.order === 'asc' ? '从老到新' : '从新到老';
        setStatus('预览中', `账号 ${me.username}，频道 ${chName} (${dirStr})`);
        
        const msgs = await collectMessages(token, opts, me.id, setStatus);
        st.previewCtx = { opts, meId: me.id };
        renderMessages(msgs);
        setStatus('预览完成', `找到 ${msgs.length} 条符合条件的消息。`);
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
          const t0 = Date.now();
          try {
            const delCid = m.channel_id || st.previewCtx.opts.channelId;
            await apiFetch(token, `/channels/${delCid}/messages/${m.id}`, { method: 'DELETE' });
          } catch (err) {
            if (!err.message.includes('API 404')) throw err;
          }
          done++;
          setStatus('删除中', `已删除 ${done}/${st.previewed.length} 条。`);
          
          // 动态读取最新的间隔时间，并扣除网络请求耗时
          const currentDelay = Math.min(Math.max(Number($('delay').value) || 1600, 100), 30000);
          const dt = Date.now() - t0;
          if (dt < currentDelay) await sleep(currentDelay - dt);
        }
        renderMessages([]);
        st.previewCtx = null;
        setStatus('完成', `已删除 ${done} 条消息。`);
      } catch (e) { setStatus('失败', e.message); }
      finally { st.deleting = false; $('preview-btn').disabled = false; }
    });

    /* Tab logic */
    const tabs = root.querySelectorAll('.tab-btn');
    const panes = root.querySelectorAll('.tab-pane');
    tabs.forEach(t => {
      t.addEventListener('click', () => {
        tabs.forEach(x => x.classList.remove('active'));
        panes.forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        root.getElementById(t.dataset.tab).classList.add('active');
      });
    });
    
    /* Stat logic */
    $('stat-btn').addEventListener('click', async () => {
      const gid = root.getElementById('stat-guild').value.trim();
      const cid = root.getElementById('stat-channel').value.trim();
      let meId = '1';
      try { meId = (await apiFetch(getToken(), '/users/@me')).id; } catch(e) { setStatus('错误', 'Token 无效'); return; }
      
      let path = `/guilds/${gid}/messages/search?author_id=${meId}&include_nsfw=true`;
      if (!gid || gid === '@me') {
        if (!cid) { setStatus('错误', '查私信请填写频道ID'); return; }
        path = `/channels/${cid}/messages/search?author_id=${meId}&include_nsfw=true`;
      } else if (cid) {
        path += `&channel_id=${cid}`;
      }
      
      root.getElementById('stat-result').innerText = '...';
      setStatus('查询中', '正在调用高级检索接口...');
      try {
        const res = await apiFetch(getToken(), path);
        
        if (res && res.message === 'Indexing') {
          root.getElementById('stat-result').innerText = '索引中';
          root.getElementById('stat-result').style.fontSize = '32px';
          root.getElementById('stat-err-msg').innerText = 'Discord 正在为您建立全服索引，这可能需要几分钟，请稍后再查。';
          setStatus('查询中', 'Discord 返回 202 Indexing...');
          return;
        }

        root.getElementById('stat-result').innerText = res.total_results || 0;
        root.getElementById('stat-result').style.fontSize = '48px';
        root.getElementById('stat-err-msg').innerText = '';
        setStatus('查询成功', `找到 ${res.total_results} 条发言。`);
        if (res.total_results > 0) root.getElementById('stat-del-btn').style.display = 'flex';
        else root.getElementById('stat-del-btn').style.display = 'none';
      } catch (e) {
        root.getElementById('stat-result').innerText = '错误';
        root.getElementById('stat-result').style.fontSize = '32px';
        root.getElementById('stat-err-msg').innerText = e.message;
        setStatus('查询失败', e.message);
      }
    });

    $('stat-del-btn').addEventListener('click', () => {
      const gid = root.getElementById('stat-guild').value.trim();
      const cid = root.getElementById('stat-channel').value.trim();
      if (gid) $('guildId').value = gid;
      $('channelId').value = cid;
      tabs[0].click();
      setStatus('准备就绪', '已同步 ID，请点击预览开始清理。');
    });

    // Prevent Discord from capturing keypresses inside our inputs
    root.addEventListener('keydown', e => e.stopPropagation());
    root.addEventListener('keyup', e => e.stopPropagation());
    root.addEventListener('keypress', e => e.stopPropagation());

    /* init */
    restore().then(() => {
      if (!$('before').value) syncNow();
    }).catch(() => {});
    tryAutoToken();

    /* expose toggle to message listener */
    root._toggle = toggle;
  }

  /* ── message listener & monkey menu ── */
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
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
  }

  if (typeof GM_registerMenuCommand !== 'undefined') {
    GM_registerMenuCommand('显示/隐藏 冲水面板', () => {
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
    });
  }

  /* ── boot ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
