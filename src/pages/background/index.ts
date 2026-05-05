import reloadOnUpdate from "virtual:reload-on-update-in-background-script";

import "./auth";

reloadOnUpdate("pages/background");

/**
 * Extension reloading is necessary because the browser automatically caches the css.
 * If you do not use the css of the content script, please delete it.
 */
reloadOnUpdate("pages/content/style.scss");

console.log("background loaded");

if (__DEV__) {
  // Visual marker so a dev build is unmistakable next to the Web Store install.
  // Tree-shaken out of release bundles via the vite `define` constant.
  void chrome.action.setBadgeText({ text: "DEV" });
  void chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
}

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.id !== "number") return;
  const event = { type: "toggle", url: tab.url };
  // Swallow "Receiving end does not exist" — content script is absent on
  // chrome://, the new tab page, the Web Store, etc. Log only on success
  // so a real delivery failure isn't masked by a misleading "sent" line.
  chrome.tabs
    .sendMessage(tab.id, event)
    .then(() => console.log("message sent", event))
    .catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    const event = { type: "urlChange", url: changeInfo.url };
    chrome.tabs
      .sendMessage(tabId, event)
      .then(() => console.log("message sent", event))
      .catch(() => {});
  }
});