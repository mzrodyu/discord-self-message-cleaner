const limitInput = document.querySelector("#limit");
const delayInput = document.querySelector("#delay");
const autoScrollInput = document.querySelector("#autoScroll");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const stateText = document.querySelector("#state");
const detailsText = document.querySelector("#details");

const DEFAULTS = {
  limit: 50,
  delayMs: 1400,
  autoScroll: true
};

async function getActiveDiscordTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://discord.com/")) {
    throw new Error("请先切到 discord.com 的频道页面。");
  }
  return tab;
}

function setStatus(state, details) {
  stateText.textContent = state;
  detailsText.textContent = details;
}

function readOptions() {
  return {
    limit: Number(limitInput.value) || DEFAULTS.limit,
    delayMs: Number(delayInput.value) || DEFAULTS.delayMs,
    autoScroll: autoScrollInput.checked
  };
}

async function saveOptions(options) {
  await chrome.storage.local.set({ cleanerOptions: options });
}

async function sendCommand(type, payload = {}) {
  const tab = await getActiveDiscordTab();
  return chrome.tabs.sendMessage(tab.id, { type, ...payload });
}

async function restoreOptions() {
  const { cleanerOptions } = await chrome.storage.local.get("cleanerOptions");
  const options = { ...DEFAULTS, ...cleanerOptions };
  limitInput.value = options.limit;
  delayInput.value = options.delayMs;
  autoScrollInput.checked = options.autoScroll;
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  try {
    const options = readOptions();
    await saveOptions(options);
    const result = await sendCommand("START_CLEANING", { options });
    setStatus("运行中", result?.message || "正在删除当前频道可见的自己消息。");
  } catch (error) {
    setStatus("无法启动", error.message);
  } finally {
    startButton.disabled = false;
  }
});

stopButton.addEventListener("click", async () => {
  try {
    const result = await sendCommand("STOP_CLEANING");
    setStatus("已停止", result?.message || "删除任务已停止。");
  } catch (error) {
    setStatus("无法停止", error.message);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "CLEANER_STATUS") {
    return;
  }
  setStatus(message.state, message.details);
});

restoreOptions().catch((error) => setStatus("初始化失败", error.message));
