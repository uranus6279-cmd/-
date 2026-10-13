// 탭별로 발견한 미디어 목록을 모으고, 팝업 요청에 따라 다운로드한다.

const MEDIA_EXT = /\.(mp4|webm|m4v|mov|mkv|ogv|mp3|m4a|aac|ogg|oga|wav|flac|opus|m3u8|mpd)(\?|#|$)/i;
const MEDIA_TYPE = /^(video|audio)\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)/i;
// 유튜브 스트림은 조각난 서명 URL이라 받아도 재생 가능한 파일이 아니므로 제외한다.
const BLOCKED_HOST = /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|ytimg\.com)$/i;
// 일부 서버는 미디어를 작은 조각(range)으로 나눠 보내므로 너무 작은 응답은 무시한다.
const MIN_BYTES = 100 * 1024;

// 서비스 워커는 수시로 꺼지므로 목록은 storage.session(브라우저 종료 시 삭제)에 둔다.
const key = (tabId) => `tab:${tabId}`;
async function getList(tabId) {
  return (await chrome.storage.session.get(key(tabId)))[key(tabId)] || {};
}
async function clearList(tabId) {
  await chrome.storage.session.remove(key(tabId));
  updateBadge(tabId, 0);
}

// 같은 탭에 대한 쓰기가 겹치지 않도록 순서대로 처리한다.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

function isStreamManifest(url, type) {
  return /\.(m3u8|mpd)(\?|#|$)/i.test(url) || /mpegurl|dash\+xml/i.test(type || "");
}

function addMedia(tabId, item) {
  if (tabId < 0 || !/^https?:/.test(item.url || "")) return;
  if (BLOCKED_HOST.test(hostOf(item.url))) return;
  serial(async () => {
    const list = await getList(tabId);
    const prev = list[item.url] || {};
    // 네트워크 응답의 형식/크기 정보가 페이지 태그에서 추측한 값보다 정확하다.
    const merged = item.source === "network" ? { ...prev, ...item } : { ...item, ...prev };
    merged.size = merged.size || prev.size || item.size || 0;
    merged.stream = isStreamManifest(merged.url, merged.type);
    list[item.url] = merged;
    await chrome.storage.session.set({ [key(tabId)]: list });
    updateBadge(tabId, Object.keys(list).length);
  });
}

function updateBadge(tabId, n) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.statusCode >= 400) return;
    const h = Object.fromEntries((d.responseHeaders || []).map((x) => [x.name.toLowerCase(), x.value]));
    const type = (h["content-type"] || "").split(";")[0].trim();
    const looksMedia = MEDIA_TYPE.test(type) || MEDIA_EXT.test(d.url);
    if (!looksMedia) return;

    // 206 응답이면 Content-Range의 전체 크기를, 아니면 Content-Length를 쓴다.
    let size = Number(h["content-length"]) || 0;
    const range = /\/(\d+)$/.exec(h["content-range"] || "");
    if (range) size = Number(range[1]);
    if (!isStreamManifest(d.url, type) && size && size < MIN_BYTES) return;

    addMedia(d.tabId, { url: d.url, type, size, source: "network" });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// 페이지가 새로 로드되면 이전 목록을 비운다.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) serial(() => clearList(tabId));
});
chrome.tabs.onRemoved.addListener((tabId) => serial(() => chrome.storage.session.remove(key(tabId))));

function fileNameFor(item, title) {
  let base = "";
  try { base = decodeURIComponent(new URL(item.url).pathname.split("/").pop() || ""); } catch {}
  const ext = (/\.([a-z0-9]{2,4})$/i.exec(base) || [])[1]
    || (item.type?.split("/")[1] || "mp4").replace("mpeg", "mp3").replace("quicktime", "mov");
  const safeTitle = (title || "").replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, " ").trim().slice(0, 80);
  const name = safeTitle || base.replace(/\.[^.]+$/, "") || "video";
  return `${name}.${ext}`;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "found") {
    for (const item of msg.items) addMedia(sender.tab?.id ?? -1, { ...item, source: "page" });
  } else if (msg.type === "list") {
    serial(() => getList(msg.tabId)).then((list) => sendResponse(Object.values(list)));
    return true;
  } else if (msg.type === "download") {
    const opts = { url: msg.item.url, filename: fileNameFor(msg.item, msg.title), saveAs: !!msg.saveAs };
    chrome.downloads.download(opts, (id) => {
      if (id) return sendResponse({ ok: true });
      // 파일 이름이 거부되면 크롬이 정하는 기본 이름으로 다시 시도한다.
      delete opts.filename;
      chrome.downloads.download(opts, (id2) =>
        sendResponse({ ok: !!id2, error: chrome.runtime.lastError?.message }));
    });
    return true;
  } else if (msg.type === "clear") {
    serial(() => clearList(msg.tabId)).then(() => sendResponse({ ok: true }));
    return true;
  }
});
