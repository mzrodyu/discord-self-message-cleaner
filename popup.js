const tokenInput = document.querySelector("#token");
const autoTokenButton = document.querySelector("#autoToken");
const guildIdInput = document.querySelector("#guildId");
const channelIdInput = document.querySelector("#channelId");
const limitInput = document.querySelector("#limit");
const delayInput = document.querySelector("#delay");
const afterInput = document.querySelector("#after");
const beforeInput = document.querySelector("#before");
const disclaimerInput = document.querySelector("#disclaimer");
const fillCurrentButton = document.querySelector("#fillCurrent");
const uiDeleteButton = document.querySelector("#uiDelete");
const uiStopButton = document.querySelector("#uiStop");
const previewButton = document.querySelector("#preview");
const deleteButton = document.querySelector("#delete");
const stateText = document.querySelector("#state");
const detailsText = document.querySelector("#details");
const countText = document.querySelector("#count");
const messagesList = document.querySelector("#messages");

const API_BASE = "https://discord.com/api/v10";
const SNOWFLAKE_EPOCH = 1420070400000n;
const DEFAULTS = {
  limit: 100,
  delayMs: 1600
};

let previewedMessages = [];
let previewContext = null;
let deleting = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(state, details) {
  stateText.textContent = state;
  detailsText.textContent = details;
}

function normalizeId(value) {
  return value.trim();
}

async function autoFetchToken() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://discord.com/")) {
      return; // 不在 Discord 页，静默降级
    }
    const result = await chrome.tabs.sendMessage(tab.id, { type: "GET_TOKEN" });
    if (result?.ok && result.token) {
      tokenInput.value = result.token;
      setStatus("已自动获取", "Token 已从 Discord 自动提取，无需手动填写。");
    }
  } catch (_) {
    // 静默降级：让用户自己填
  }
}

function readToken() {
  const token = tokenInput.value.trim();
  if (!token) {
    throw new Error("未能自动获取 token，请手动在上方填入。");
  }
  return token;
}

function readOptions() {
  const guildId = normalizeId(guildIdInput.value);
  const channelId = normalizeId(channelIdInput.value);
  if (!/^\d{15,25}$/.test(guildId)) {
    throw new Error("服务器 ID 格式不对。");
  }
  if (!/^\d{15,25}$/.test(channelId)) {
    throw new Error("频道 ID 格式不对。");
  }
  if (!disclaimerInput.checked) {
    throw new Error("请先勾选免责声明。");
  }

  const limit = Math.min(Math.max(Number(limitInput.value) || DEFAULTS.limit, 1), 5000);
  const delayMs = Math.min(Math.max(Number(delayInput.value) || DEFAULTS.delayMs, 800), 30000);
  const after = afterInput.value ? new Date(afterInput.value) : null;
  const before = beforeInput.value ? new Date(beforeInput.value) : null;

  if (after && Number.isNaN(after.getTime())) {
    throw new Error("起始时间无效。");
  }
  if (before && Number.isNaN(before.getTime())) {
    throw new Error("结束时间无效。");
  }
  if (after && before && after >= before) {
    throw new Error("起始时间必须早于结束时间。");
  }

  return { guildId, channelId, limit, delayMs, after, before };
}

async function saveOptions(options) {
  await chrome.storage.local.set({
    cleanerOptions: {
      guildId: options.guildId,
      channelId: options.channelId,
      limit: options.limit,
      delayMs: options.delayMs,
      after: afterInput.value,
      before: beforeInput.value
    }
  });
}

async function restoreOptions() {
  const { cleanerOptions } = await chrome.storage.local.get("cleanerOptions");
  const options = { ...DEFAULTS, ...cleanerOptions };
  guildIdInput.value = options.guildId || "";
  channelIdInput.value = options.channelId || "";
  limitInput.value = options.limit;
  delayInput.value = options.delayMs;
  afterInput.value = options.after || "";
  beforeInput.value = options.before || "";
}

async function getActiveTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    throw new Error("没有读到当前标签页地址。");
  }
  return tab.url;
}

async function getActiveDiscordTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://discord.com/")) {
    throw new Error("请先切到 Discord 网页频道。");
  }
  return tab;
}

async function sendUiCommand(type) {
  const tab = await getActiveDiscordTab();
  const options = {
    limit: Math.min(Math.max(Number(limitInput.value) || DEFAULTS.limit, 1), 5000),
    delayMs: Math.min(Math.max(Number(delayInput.value) || DEFAULTS.delayMs, 800), 30000),
    autoScroll: true
  };
  return chrome.tabs.sendMessage(tab.id, { type, options });
}

function parseDiscordChannelUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== "discord.com") {
    throw new Error("请先切到 Discord 网页频道。");
  }

  const match = parsed.pathname.match(/^\/channels\/(\d{15,25})\/(\d{15,25})/);
  if (!match) {
    throw new Error("当前页面不是服务器频道，无法自动填 ID。");
  }

  return {
    guildId: match[1],
    channelId: match[2]
  };
}

async function fillCurrentChannel() {
  const url = await getActiveTabUrl();
  const ids = parseDiscordChannelUrl(url);
  guildIdInput.value = ids.guildId;
  channelIdInput.value = ids.channelId;
  await chrome.storage.local.set({
    cleanerOptions: {
      guildId: ids.guildId,
      channelId: ids.channelId,
      limit: Number(limitInput.value) || DEFAULTS.limit,
      delayMs: Number(delayInput.value) || DEFAULTS.delayMs,
      after: afterInput.value,
      before: beforeInput.value
    }
  });
  setStatus("已填充", "已从当前 Discord 频道读取服务器 ID 和频道 ID。");
}

async function discordFetch(token, path, options = {}, attempt = 0) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (response.status === 429) {
    const retry = await response.json().catch(() => ({}));
    const retryAfter = Math.ceil(Number(retry.retry_after || 1) * 1000);
    if (attempt < 3) {
      setStatus("限速等待", `Discord 要求等待 ${retryAfter}ms，正在自动重试。`);
      await sleep(retryAfter + 250);
      return discordFetch(token, path, options, attempt + 1);
    }
    throw new Error(`触发限速，请稍后重试。`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Discord API ${response.status}: ${body.slice(0, 180) || response.statusText}`);
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function snowflakeTime(id) {
  const timestamp = (BigInt(id) >> 22n) + SNOWFLAKE_EPOCH;
  return new Date(Number(timestamp));
}

function timestampToSnowflake(date) {
  return String((BigInt(date.getTime()) - SNOWFLAKE_EPOCH) << 22n);
}

function withinRange(message, after, before) {
  const createdAt = new Date(message.timestamp || snowflakeTime(message.id));
  if (after && createdAt < after) {
    return false;
  }
  if (before && createdAt > before) {
    return false;
  }
  return true;
}

async function getMe(token) {
  return discordFetch(token, "/users/@me");
}

async function verifyChannel(token, guildId, channelId) {
  const channel = await discordFetch(token, `/channels/${channelId}`);
  if (String(channel.guild_id || "") !== guildId) {
    throw new Error("这个频道不属于填写的服务器 ID。");
  }
  return channel;
}

async function collectOwnMessages(token, options, meId) {
  const messages = [];
  let before = options.before ? timestampToSnowflake(options.before) : null;
  let keepGoing = true;

  while (keepGoing && messages.length < options.limit) {
    const params = new URLSearchParams({ limit: "100" });
    if (before) {
      params.set("before", before);
    }

    const batch = await discordFetch(token, `/channels/${options.channelId}/messages?${params}`);
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    for (const message of batch) {
      const createdAt = new Date(message.timestamp || snowflakeTime(message.id));
      if (options.after && createdAt < options.after) {
        keepGoing = false;
        break;
      }
      if (message.author?.id === meId && withinRange(message, options.after, options.before)) {
        messages.push(message);
        if (messages.length >= options.limit) {
          break;
        }
      }
    }

    before = batch[batch.length - 1].id;
    setStatus("预览中", `已找到 ${messages.length} 条自己的消息。`);
    await sleep(250);
  }

  return messages;
}

function renderMessages(messages) {
  previewedMessages = messages;
  countText.textContent = `${messages.length} 条`;
  messagesList.textContent = "";

  const fragment = document.createDocumentFragment();
  for (const message of messages.slice(0, 50)) {
    const item = document.createElement("li");
    const time = new Date(message.timestamp || snowflakeTime(message.id)).toLocaleString();
    const content = message.content?.trim() || "[无文本内容]";
    item.textContent = `${time}  ${content.slice(0, 90)}`;
    fragment.appendChild(item);
  }
  messagesList.appendChild(fragment);

  if (messages.length > 50) {
    const extra = document.createElement("li");
    extra.textContent = `还有 ${messages.length - 50} 条未在面板中展开显示。`;
    messagesList.appendChild(extra);
  }

  deleteButton.disabled = messages.length === 0;
}

async function preview() {
  deleteButton.disabled = true;
  renderMessages([]);
  const token = readToken();
  const options = readOptions();
  await saveOptions(options);

  setStatus("校验中", "正在读取账号和频道信息。");
  const me = await getMe(token);
  const channel = await verifyChannel(token, options.guildId, options.channelId);
  setStatus("预览中", `账号 ${me.username}，频道 ${channel.name || options.channelId}。`);

  const messages = await collectOwnMessages(token, options, me.id);
  previewContext = { options, meId: me.id };
  renderMessages(messages);
  setStatus("预览完成", `找到 ${messages.length} 条可删除的自己消息。`);
}

async function deletePreviewed() {
  if (deleting) {
    return;
  }
  if (!previewContext || previewedMessages.length === 0) {
    throw new Error("请先预览。");
  }

  const token = readToken();
  const ok = confirm(`将删除预览中的 ${previewedMessages.length} 条消息。删除不可恢复，确认继续？`);
  if (!ok) {
    return;
  }

  deleting = true;
  previewButton.disabled = true;
  deleteButton.disabled = true;

  let deleted = 0;
  try {
    for (const message of previewedMessages) {
      await discordFetch(token, `/channels/${previewContext.options.channelId}/messages/${message.id}`, {
        method: "DELETE"
      });
      deleted += 1;
      setStatus("删除中", `已删除 ${deleted}/${previewedMessages.length} 条。`);
      await sleep(previewContext.options.delayMs);
    }
    renderMessages([]);
    previewContext = null;
    setStatus("完成", `已删除 ${deleted} 条消息。`);
  } finally {
    deleting = false;
    previewButton.disabled = false;
  }
}

previewButton.addEventListener("click", async () => {
  previewButton.disabled = true;
  try {
    await preview();
  } catch (error) {
    setStatus("失败", error.message);
  } finally {
    previewButton.disabled = false;
  }
});

fillCurrentButton.addEventListener("click", async () => {
  fillCurrentButton.disabled = true;
  try {
    await fillCurrentChannel();
  } catch (error) {
    setStatus("无法填充", error.message);
  } finally {
    fillCurrentButton.disabled = false;
  }
});

uiDeleteButton.addEventListener("click", async () => {
  uiDeleteButton.disabled = true;
  try {
    const result = await sendUiCommand("START_CLEANING");
    setStatus("免 token 运行中", result?.message || "正在当前频道用网页界面删除自己的可见消息。");
  } catch (error) {
    setStatus("无法启动", error.message);
  } finally {
    uiDeleteButton.disabled = false;
  }
});

uiStopButton.addEventListener("click", async () => {
  try {
    const result = await sendUiCommand("STOP_CLEANING");
    setStatus("正在停止", result?.message || "已发送停止请求。");
  } catch (error) {
    setStatus("无法停止", error.message);
  }
});

autoTokenButton.addEventListener("click", async () => {
  autoTokenButton.disabled = true;
  const prev = autoTokenButton.textContent.trim();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://discord.com/")) {
      setStatus("提取失败", "请先切换到 Discord 网页标签页再点此按鈕。");
      return;
    }
    setStatus("提取中…", "正在从 Discord 读取 token。");
    const result = await chrome.tabs.sendMessage(tab.id, { type: "GET_TOKEN" });
    if (result?.ok && result.token) {
      tokenInput.value = result.token;
      setStatus("自动获取成功", "Token 已填入，可直接点预览。");
    } else {
      setStatus("自动获取失败", result?.message || "请手动将 token 粘贴到上方输入框。");
    }
  } catch (error) {
    setStatus("提取异常", error.message);
  } finally {
    autoTokenButton.disabled = false;
  }
});

deleteButton.addEventListener("click", async () => {
  try {
    await deletePreviewed();
  } catch (error) {
    setStatus("失败", error.message);
    previewButton.disabled = false;
    deleteButton.disabled = previewedMessages.length === 0;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "CLEANER_STATUS") {
    return;
  }
  setStatus(message.state, message.details);
});

restoreOptions()
  .then(() => autoFetchToken())
  .catch((error) => setStatus("初始化失败", error.message));
