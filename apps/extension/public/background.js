const APP_TAB_KEY = "__weddingMusicAppTabId";

chrome.action.onClicked.addListener(() => {
  void openOrFocusApp();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearClosedAppTab(tabId);
});

async function openOrFocusApp() {
  const saved = await chrome.storage.local.get(APP_TAB_KEY);
  const savedTabId = saved[APP_TAB_KEY];

  if (typeof savedTabId === "number") {
    try {
      const tab = await chrome.tabs.get(savedTabId);
      await chrome.tabs.update(savedTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      // The stored tab ID is stale; open a new app tab.
    }
  }

  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
  await chrome.storage.local.set({ [APP_TAB_KEY]: tab.id });
}

async function clearClosedAppTab(tabId) {
  const saved = await chrome.storage.local.get(APP_TAB_KEY);
  if (saved[APP_TAB_KEY] === tabId) {
    await chrome.storage.local.remove(APP_TAB_KEY);
  }
}
