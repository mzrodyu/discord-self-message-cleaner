const state = {
  running: false,
  deleted: 0,
  stopRequested: false
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendStatus(stateText, details) {
  chrome.runtime.sendMessage({
    type: "CLEANER_STATUS",
    state: stateText,
    details
  }).catch(() => {});
}

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

async function runCleaner(options) {
  state.running = true;
  state.stopRequested = false;
  state.deleted = 0;

  sendStatus("运行中", "正在扫描当前频道。");

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
        sendStatus("运行中", `已删除 ${state.deleted} 条。`);
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
  sendStatus(stopped ? "已停止" : "完成", `本轮删除 ${state.deleted} 条。`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_CLEANING") {
    if (state.running) {
      sendResponse({ ok: false, message: "已有删除任务正在运行。" });
      return false;
    }

    const options = {
      limit: Math.min(Math.max(Number(message.options?.limit) || 50, 1), 500),
      delayMs: Math.min(Math.max(Number(message.options?.delayMs) || 1400, 600), 10000),
      autoScroll: Boolean(message.options?.autoScroll)
    };

    runCleaner(options);
    sendResponse({ ok: true, message: "任务已启动。保持频道页面打开。" });
    return false;
  }

  if (message?.type === "STOP_CLEANING") {
    state.stopRequested = true;
    sendResponse({ ok: true, message: "正在停止当前任务。" });
    return false;
  }

  return false;
});
