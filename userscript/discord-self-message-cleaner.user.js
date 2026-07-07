// ==UserScript==
// @name         Discord Self Message Cleaner
// @namespace    https://github.com/mzrodyu/discord-self-message-cleaner
// @version      0.1.0
// @description  Batch-delete your own visible Discord messages on Discord Web.
// @author       mzrodyu / catie
// @match        https://discord.com/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/mzrodyu/discord-self-message-cleaner
// @supportURL   https://github.com/mzrodyu/discord-self-message-cleaner/issues
// ==/UserScript==

(() => {
  "use strict";

  const state = {
    running: false,
    deleted: 0,
    stopRequested: false
  };

  const defaults = {
    limit: 50,
    delayMs: 1400,
    autoScroll: true
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function visible(element) {
    if (!element) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getMessageList() {
    return document.querySelector('[data-list-id="chat-messages"]');
  }

  function getCandidateMessages() {
    return Array.from(document.querySelectorAll('[id^="chat-messages-"]'))
      .filter((node) => node instanceof HTMLElement)
      .filter(visible);
  }

  function isOwnMessage(message) {
    const avatar = message.querySelector('img[class*="avatar"]');
    const buttons = message.querySelectorAll('div[role="button"], button');
    const hasDeletePath = Array.from(buttons).some((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`;
      return /delete|删除/i.test(label);
    });

    return Boolean(avatar) || hasDeletePath;
  }

  function getMoreButton(message) {
    const buttons = Array.from(message.querySelectorAll('div[role="button"], button'));
    return buttons.find((button) => {
      const label = button.getAttribute("aria-label") || button.textContent || "";
      return /more|更多/i.test(label);
    });
  }

  function getDeleteMenuItem() {
    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"], button'));
    return menuItems.find((item) => {
      const label = `${item.getAttribute("aria-label") || ""} ${item.textContent || ""}`;
      return /delete message|delete|删除消息|删除/i.test(label);
    });
  }

  function getConfirmDeleteButton() {
    const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
    return buttons.find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`;
      return /delete|删除/i.test(label);
    });
  }

  function clickElement(element) {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    element.click();
  }

  async function deleteMessage(message) {
    message.scrollIntoView({ block: "center" });
    await sleep(180);
    clickElement(message);
    await sleep(180);

    const moreButton = getMoreButton(message);
    if (!moreButton) {
      return false;
    }

    clickElement(moreButton);
    await sleep(260);

    const deleteItem = getDeleteMenuItem();
    if (!deleteItem) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return false;
    }

    clickElement(deleteItem);
    await sleep(360);

    const confirmButton = getConfirmDeleteButton();
    if (!confirmButton) {
      return false;
    }

    clickElement(confirmButton);
    return true;
  }

  async function scrollOlder() {
    const list = getMessageList();
    if (!list) {
      window.scrollBy({ top: -window.innerHeight * 0.8, behavior: "smooth" });
      return;
    }

    list.scrollBy({ top: -list.clientHeight * 0.85, behavior: "smooth" });
  }

  function setStatus(title, details) {
    const titleNode = document.querySelector("#dsmc-state");
    const detailsNode = document.querySelector("#dsmc-details");
    if (titleNode) {
      titleNode.textContent = title;
    }
    if (detailsNode) {
      detailsNode.textContent = details;
    }
  }

  function readOptions() {
    const limit = Number(document.querySelector("#dsmc-limit")?.value) || defaults.limit;
    const delayMs = Number(document.querySelector("#dsmc-delay")?.value) || defaults.delayMs;
    const autoScroll = Boolean(document.querySelector("#dsmc-auto-scroll")?.checked);

    return {
      limit: Math.min(Math.max(limit, 1), 500),
      delayMs: Math.min(Math.max(delayMs, 600), 10000),
      autoScroll
    };
  }

  async function runCleaner(options) {
    state.running = true;
    state.stopRequested = false;
    state.deleted = 0;

    setStatus("运行中", "正在扫描当前频道。");

    while (!state.stopRequested && state.deleted < options.limit) {
      const messages = getCandidateMessages().filter(isOwnMessage).reverse();
      let deletedThisPass = 0;

      for (const message of messages) {
        if (state.stopRequested || state.deleted >= options.limit) {
          break;
        }

        const ok = await deleteMessage(message);
        if (ok) {
          state.deleted += 1;
          deletedThisPass += 1;
          setStatus("运行中", `已删除 ${state.deleted} 条。`);
          await sleep(options.delayMs);
        }
      }

      if (deletedThisPass === 0) {
        if (!options.autoScroll) {
          break;
        }
        await scrollOlder();
        await sleep(1300);
      }
    }

    const stopped = state.stopRequested;
    state.running = false;
    state.stopRequested = false;
    setStatus(stopped ? "已停止" : "完成", `本轮删除 ${state.deleted} 条。`);
  }

  function createSvg(path) {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        ${path}
      </svg>
    `;
  }

  function mountPanel() {
    if (document.querySelector("#dsmc-panel")) {
      return;
    }

    const panel = document.createElement("section");
    panel.id = "dsmc-panel";
    panel.innerHTML = `
      <style>
        #dsmc-panel {
          position: fixed;
          right: 18px;
          bottom: 18px;
          z-index: 2147483647;
          width: 312px;
          display: grid;
          gap: 10px;
          padding: 14px;
          border: 1px solid #e5e5ea;
          border-radius: 18px;
          background: #f2f2f7;
          color: #1c1c1e;
          box-shadow: 0 12px 34px rgba(0, 0, 0, 0.18);
          font: 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        }
        #dsmc-panel * { box-sizing: border-box; }
        #dsmc-panel svg { width: 16px; height: 16px; }
        #dsmc-panel h2 {
          margin: 0;
          font-size: 16px;
          line-height: 1.2;
          letter-spacing: 0;
        }
        #dsmc-panel p {
          margin: 2px 0 0;
          color: #6e6e73;
          font-size: 12px;
          line-height: 1.35;
        }
        #dsmc-panel .dsmc-head {
          display: flex;
          align-items: center;
          gap: 9px;
        }
        #dsmc-panel .dsmc-icon {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          padding: 5px;
          background: #007aff;
          fill: none;
          stroke: #fff;
          stroke-width: 1.8;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        #dsmc-panel .dsmc-card {
          overflow: hidden;
          display: grid;
          border: 1px solid #e5e5ea;
          border-radius: 14px;
          background: #fff;
        }
        #dsmc-panel label,
        #dsmc-panel .dsmc-row {
          display: grid;
          gap: 7px;
          padding: 11px;
          border-bottom: 1px solid #e5e5ea;
          font-weight: 600;
        }
        #dsmc-panel label:last-child,
        #dsmc-panel .dsmc-row:last-child {
          border-bottom: 0;
        }
        #dsmc-panel input[type="number"] {
          width: 100%;
          min-height: 34px;
          border: 1px solid #d1d1d6;
          border-radius: 10px;
          padding: 6px 10px;
          background: #f9f9fb;
          color: #1c1c1e;
          font: inherit;
        }
        #dsmc-panel .dsmc-check {
          grid-template-columns: 18px 1fr;
          align-items: center;
          gap: 8px;
          font-weight: 500;
        }
        #dsmc-panel input[type="checkbox"] {
          width: 18px;
          height: 18px;
          accent-color: #007aff;
        }
        #dsmc-panel .dsmc-actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        #dsmc-panel button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          min-height: 38px;
          border: 0;
          border-radius: 999px;
          background: #007aff;
          color: #fff;
          font: 700 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
          cursor: pointer;
        }
        #dsmc-panel button.secondary {
          background: #e5e5ea;
          color: #1c1c1e;
        }
        #dsmc-panel .dsmc-status {
          gap: 5px;
          padding: 11px;
          font-weight: 400;
        }
        #dsmc-panel .dsmc-status strong {
          display: flex;
          align-items: center;
          gap: 7px;
        }
        #dsmc-panel .dsmc-status svg {
          fill: none;
          stroke: #007aff;
          stroke-width: 2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        #dsmc-panel .dsmc-meta {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          color: #6e6e73;
          font-size: 12px;
        }
        #dsmc-panel .dsmc-meta a {
          min-width: 0;
          overflow: hidden;
          color: #1c1c1e;
          font-weight: 700;
          text-decoration: none;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        @media (prefers-color-scheme: dark) {
          #dsmc-panel {
            border-color: #2c2c2e;
            background: #000;
            color: #f5f5f7;
          }
          #dsmc-panel .dsmc-card {
            border-color: #2c2c2e;
            background: #1c1c1e;
          }
          #dsmc-panel label,
          #dsmc-panel .dsmc-row {
            border-color: #2c2c2e;
          }
          #dsmc-panel p,
          #dsmc-panel .dsmc-meta {
            color: #a1a1a6;
          }
          #dsmc-panel input[type="number"] {
            border-color: #3a3a3c;
            background: #2c2c2e;
            color: #f5f5f7;
          }
          #dsmc-panel button.secondary {
            background: #2c2c2e;
            color: #f5f5f7;
          }
          #dsmc-panel .dsmc-meta a {
            color: #f5f5f7;
          }
        }
      </style>
      <div class="dsmc-head">
        ${createSvg('<path d="M7.5 4.5h9l-.6 2H8.1l-.6-2Z"></path><path d="M9 8h6l-.5 10.5a1.8 1.8 0 0 1-1.8 1.7h-1.4a1.8 1.8 0 0 1-1.8-1.7L9 8Z"></path><path d="M10.8 10.5v7M13.2 10.5v7"></path>').replace("<svg", '<svg class="dsmc-icon"')}
        <div>
          <h2>Discord Self Message Cleaner</h2>
          <p>删除当前频道里你自己的可见消息。</p>
        </div>
      </div>
      <div class="dsmc-card">
        <label>
          每轮最多删除
          <input id="dsmc-limit" type="number" min="1" max="500" value="${defaults.limit}">
        </label>
        <label>
          删除间隔（毫秒）
          <input id="dsmc-delay" type="number" min="600" max="10000" step="100" value="${defaults.delayMs}">
        </label>
        <label class="dsmc-check">
          <input id="dsmc-auto-scroll" type="checkbox" checked>
          自动向上加载更早消息
        </label>
      </div>
      <div class="dsmc-actions">
        <button id="dsmc-start" type="button">
          ${createSvg('<path d="M8 5.5v13l10-6.5-10-6.5Z"></path>')}
          开始
        </button>
        <button id="dsmc-stop" class="secondary" type="button">
          ${createSvg('<path d="M7 7h10v10H7z"></path>')}
          停止
        </button>
      </div>
      <div class="dsmc-card dsmc-status">
        <strong>
          ${createSvg('<path d="M12 6v6l4 2"></path><circle cx="12" cy="12" r="8"></circle>')}
          <span id="dsmc-state">待机</span>
        </strong>
        <p id="dsmc-details">打开 Discord 频道后再运行。</p>
      </div>
      <div class="dsmc-meta">
        <span>mzrodyu / catie</span>
        <a href="https://github.com/mzrodyu/discord-self-message-cleaner" target="_blank" rel="noreferrer">GitHub</a>
      </div>
    `;

    document.documentElement.append(panel);

    panel.querySelector("#dsmc-start").addEventListener("click", () => {
      if (state.running) {
        setStatus("运行中", "已有删除任务正在运行。");
        return;
      }
      runCleaner(readOptions());
    });

    panel.querySelector("#dsmc-stop").addEventListener("click", () => {
      state.stopRequested = true;
      setStatus("正在停止", "当前消息处理完后停止。");
    });
  }

  mountPanel();
})();
