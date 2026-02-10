// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  kuro 🐈‍⬛ — Background Service Worker                                  ║
// ║  Message router between sidepanel ↔ content scripts                     ║
// ╚════════════════════════════════════════════════════════════════════════════╝

// Open sidepanel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Route messages from sidepanel → content script (and back)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "DOM_ACTION") {
    // Forward to content script in the target tab
    const tabId = msg.tabId;
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) {
        // Content script not injected yet — inject it first, then retry
        chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
        }).then(() => {
          // Small delay for script to initialize
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, msg, (retryResponse) => {
              sendResponse(retryResponse || { error: "Content script failed to respond" });
            });
          }, 100);
        }).catch((err) => {
          sendResponse({ error: `Cannot inject content script: ${err.message}` });
        });
      } else {
        sendResponse(response);
      }
    });
    return true; // async response
  }

  if (msg.type === "GET_TAB_INFO") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      sendResponse(tab ? { tabId: tab.id, url: tab.url, title: tab.title } : { error: "No active tab" });
    });
    return true;
  }

  if (msg.type === "NAVIGATE") {
    chrome.tabs.update(msg.tabId, { url: msg.url }, () => {
      let responded = false;
      const respond = (data) => {
        if (responded) return; // prevent double sendResponse
        responded = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        sendResponse(data);
      };
      // Wait for navigation to complete — get UPDATED tab info
      const listener = (updatedTabId, changeInfo, updatedTab) => {
        if (updatedTabId === msg.tabId && changeInfo.status === "complete") {
          respond({ ok: true, url: updatedTab.url, title: updatedTab.title });
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Timeout after 15s
      const timer = setTimeout(() => {
        respond({ ok: true, url: msg.url, title: "(timeout)" });
      }, 15000);
    });
    return true;
  }

  if (msg.type === "SCREENSHOT") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true;
  }

  // EXEC_SCRIPT removed — was unused dead code and a security risk (arbitrary code execution)
});

// Enable side panel on all pages
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
