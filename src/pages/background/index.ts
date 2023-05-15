import reloadOnUpdate from "virtual:reload-on-update-in-background-script";

reloadOnUpdate("pages/background");

/**
 * Extension reloading is necessary because the browser automatically caches the css.
 * If you do not use the css of the content script, please delete it.
 */
reloadOnUpdate("pages/content/style.scss");

console.log("background loaded");

chrome.action.onClicked.addListener((tab) => {
  const event = { type: "toggle", url: tab.url };
  chrome.tabs.sendMessage(tab.id, event);
  console.log("message sent", event);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const event = { type: "urlChange", url: changeInfo.url };
    chrome.tabs.sendMessage(tabId, event);
    console.log("message sent", event);
  }
});