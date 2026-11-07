// Vinted Checker extension: sends a Vinted photo to the local app and opens the result.
// Written for LibreWolf/Firefox (Manifest V3 with a background script).
//
// The photo is downloaded here, in the extension, the same way the browser
// already loaded it for the page. Nothing is crawled: one photo per click.

const DEFAULT_SERVER = "http://127.0.0.1:3000";
// Vinted serves listing photos from these hosts (images1.vinted.net etc.).
const PHOTO_PATTERN = "https://*.vinted.net/*";
const MENU_ID = "vinted-checker-check";

async function serverUrl() {
  const { server } = await chrome.storage.sync.get({ server: DEFAULT_SERVER });
  return server.replace(/\/+$/, "");
}

// The background script is unloaded when idle and runs again on the next
// event, so (re)create the menu each time instead of only on install.
chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Check with Vinted Checker",
    contexts: ["image"],
    targetUrlPatterns: [PHOTO_PATTERN],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && info.srcUrl) check(info.srcUrl, tab);
});

// Toolbar button: Vinted often lays a transparent overlay over the gallery,
// which hides the image context menu. Fall back to the largest visible photo.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const [{ result: photo }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: largestVintedPhoto,
    });
    if (!photo) return flag(tab, "No Vinted photo found on this page.");
    await check(photo, tab);
  } catch (err) {
    flag(tab, "Can't read this page: " + err.message);
  }
});

/** Runs inside the page. Returns the URL of the largest visible Vinted photo, or null. */
function largestVintedPhoto() {
  let best = null;
  let bestArea = 0;
  for (const img of document.images) {
    const src = img.currentSrc || img.src;
    if (!/^https:\/\/[^/]+\.vinted\.net\//.test(src)) continue;
    const r = img.getBoundingClientRect();
    const visible = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    const area = r.width * r.height;
    if (visible && area > bestArea) {
      best = src;
      bestArea = area;
    }
  }
  return best;
}

async function check(photoUrl, tab) {
  await setBadge(tab, "…", "#5c6a73", "Checking…");
  try {
    const photo = await fetch(photoUrl);
    if (!photo.ok) throw new Error(`Couldn't download the photo (HTTP ${photo.status}).`);
    const blob = await photo.blob();

    const form = new FormData();
    form.append("file", blob, "vinted.jpg");
    // The listing the photo came from, so the result links back to it.
    if (tab?.url?.startsWith("http")) form.append("url", tab.url);
    if (tab?.title) form.append("title", tab.title);

    const server = await serverUrl();
    let res;
    try {
      res = await fetch(`${server}/check`, { method: "POST", body: form });
    } catch {
      throw new Error(`Vinted Checker isn't running at ${server}. Start it with "npm run dev".`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The check failed (HTTP ${res.status}).`);

    await setBadge(tab, verdictBadge(data.verdict), verdictColor(data.verdict), "Checked. See the opened tab.");
    await chrome.tabs.create({ url: `${server}/?listing=${data.id}`, index: tab ? tab.index + 1 : undefined });
  } catch (err) {
    flag(tab, err.message);
  }
}

const verdictBadge = (v) => (v === "likely_fast_fashion" ? "!" : v === "possible_fast_fashion" ? "?" : "ok");
const verdictColor = (v) =>
  v === "likely_fast_fashion" ? "#b3261e" : v === "possible_fast_fashion" ? "#8a5300" : "#1d6b3a";

/** Shows a red "x" on the toolbar icon, with the message as its tooltip. */
function flag(tab, message) {
  console.warn("Vinted Checker:", message);
  return setBadge(tab, "x", "#b3261e", "Vinted Checker: " + message);
}

async function setBadge(tab, text, color, title) {
  const tabId = tab?.id;
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setTitle({ tabId, title });
}
