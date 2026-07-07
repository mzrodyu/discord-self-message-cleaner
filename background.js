chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url?.startsWith('https://discord.com/')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch (_) {
    // content script 还没加载，忽略
  }
});
