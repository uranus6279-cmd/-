// 탭별로 발견한 미디어 목록을 모으고, 팝업 요청에 따라 다운로드한다.
importScripts("reasons.js");

const MEDIA_EXT = /\.(mp4|webm|m4v|mov|mkv|ogv|mp3|m4a|aac|ogg|oga|wav|flac|opus|m3u8|mpd)(\?|#|$)/i;
const MEDIA_TYPE = /^(video|audio)\/|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)/i;
// 유튜브 스트림은 조각난 서명 URL이라 받아도 재생 가능한 파일이 아니므로 제외한다.
const BLOCKED_HOST = /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|ytimg\.com)$/i;
// HLS/DASH 조각은 재생목록(m3u8/mpd)으로 받으므로 목록에 하나하나 올리지 않는다.
const SEGMENT_EXT = /\.(ts|m4s|m4f|cmfv|cmfa|aac)(\?|#|$)/i;
const SEGMENT_TYPE = /^video\/(mp2t|iso\.segment)$/i;
const MAX_ITEMS = 50;
// 일부 서버는 미디어를 작은 조각(range)으로 나눠 보내므로 너무 작은 응답은 무시한다.
const MIN_BYTES = 100 * 1024;

// 서비스 워커는 수시로 꺼지므로 목록은 storage.session(브라우저 종료 시 삭제)에 둔다.
const key = (tabId) => `tab:${tabId}`;
async function getList(tabId) {
  return (await chrome.storage.session.get(key(tabId)))[key(tabId)] || {};
}
async function clearList(tabId) {
  await chrome.storage.session.remove([key(tabId), statusKey(tabId)]);
  updateBadge(tabId, 0);
}

// 항목별 다운로드 상태: { state: "running" | "done" | "failed", reason, progress, file }
// 팝업이 이 값을 보고 진행률과 실패 원인을 보여준다.
const statusKey = (tabId) => `st:${tabId}`;
function setStatus(tabId, url, patch) {
  return serial(async () => {
    const k = statusKey(tabId);
    const all = (await chrome.storage.session.get(k))[k] || {};
    all[url] = patch.state && patch.state !== all[url]?.state ? patch : { ...all[url], ...patch };
    await chrome.storage.session.set({ [k]: all });
  });
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
    if (!list[item.url] && Object.keys(list).length >= MAX_ITEMS) return;
    const prev = list[item.url] || {};
    // 네트워크 응답의 형식/크기 정보가 페이지 태그에서 추측한 값보다 정확하다.
    const merged = item.source === "network" ? { ...prev, ...item } : { ...item, ...prev };
    merged.size = merged.size || prev.size || item.size || 0;
    merged.seen = prev.seen || Date.now();
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
    // 이 확장(다운로드 탭)이 보낸 요청은 제외한다.
    if ((d.initiator || "").startsWith("chrome-extension://")) return;
    const h = Object.fromEntries((d.responseHeaders || []).map((x) => [x.name.toLowerCase(), x.value]));
    const type = (h["content-type"] || "").split(";")[0].trim();
    const looksMedia = MEDIA_TYPE.test(type) || MEDIA_EXT.test(d.url);
    if (!looksMedia || SEGMENT_TYPE.test(type) || SEGMENT_EXT.test(d.url)) return;

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

// 페이지가 새로 로드되면 이전 목록을 비운다. 페이지 요청(main_frame)은 그 페이지의
// 다른 요청보다 항상 먼저 오므로, 새로 찾은 항목을 지우는 일이 없다.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => { if (d.tabId >= 0) serial(() => clearList(d.tabId)); },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);
chrome.tabs.onRemoved.addListener((tabId) =>
  serial(() => chrome.storage.session.remove([key(tabId), statusKey(tabId)])));

function fileNameFor(item, title) {
  let base = "";
  try { base = decodeURIComponent(new URL(item.url).pathname.split("/").pop() || ""); } catch {}
  const ext = (/\.([a-z0-9]{2,4})$/i.exec(base) || [])[1]
    || (item.type?.split("/")[1] || "mp4").replace("mpeg", "mp3").replace("quicktime", "mov");
  const safeTitle = (title || "").replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, " ").trim().slice(0, 80);
  const name = safeTitle || base.replace(/\.[^.]+$/, "") || "video";
  return `${name}.${ext}`;
}

async function startDownload(msg) {
  const { item, tabId } = msg;
  const opts = { url: item.url, filename: fileNameFor(item, msg.title), saveAs: !!msg.saveAs };
  let id = await chrome.downloads.download(opts).catch(() => null);
  let error = "";
  if (!id) {
    // 파일 이름이 거부되면 크롬이 정하는 기본 이름으로 다시 시도한다.
    delete opts.filename;
    id = await chrome.downloads.download(opts).catch((e) => { error = e.message; return null; });
  }
  if (!id) {
    const reason = startErrorText(error);
    await setStatus(tabId, item.url, { state: "failed", reason });
    return { ok: false, error: reason };
  }
  await chrome.storage.session.set({
    [`dl:${id}`]: { tabId, url: item.url, pageUrl: msg.pageUrl, name: opts.filename || "", retried: !!msg.retried },
  });
  await setStatus(tabId, item.url, { state: "running", downloadId: id, progress: 0 });
  return { ok: true };
}

// 다운로드가 끝나거나 중단되면 상태와 원인을 기록한다.
chrome.downloads.onChanged.addListener(async (d) => {
  if (!d.state && !d.error) return;
  const k = `dl:${d.id}`;
  const info = (await chrome.storage.session.get(k))[k];
  if (!info) return;
  const state = d.state?.current;
  if (state === "complete") {
    const [item] = await chrome.downloads.search({ id: d.id });
    await setStatus(info.tabId, info.url, { state: "done", file: item?.filename.split(/[\\/]/).pop() });
  } else if (state === "interrupted" || d.error) {
    const [item] = await chrome.downloads.search({ id: d.id });
    const code = d.error?.current || item?.error;
    chrome.storage.session.remove(k);
    // 크롬 다운로드는 Referer를 바꿀 수 없어 핫링크 차단에 막힌다.
    // 403/401이면 Referer를 붙일 수 있는 다운로드 탭에서 한 번 더 시도한다.
    if (/SERVER_(FORBIDDEN|UNAUTHORIZED)/.test(code) && /^https?:/.test(info.pageUrl || "")) {
      chrome.downloads.erase({ id: d.id }).catch(() => {});
      await setStatus(info.tabId, info.url, { state: "running", progress: 0, note: "다른 방법으로 다시 시도 중" });
      const q = new URLSearchParams({
        mode: "file", url: info.url, name: info.name, ref: info.pageUrl, tabId: info.tabId,
      });
      chrome.tabs.create({ url: chrome.runtime.getURL(`hls.html?${q}`), active: false });
      return;
    }
    await setStatus(info.tabId, info.url, { state: "failed", reason: downloadErrorText(code), code });
    return;
  } else {
    return;
  }
  chrome.storage.session.remove(k);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "found") {
    for (const item of msg.items) addMedia(sender.tab?.id ?? -1, { ...item, source: "page" });
  } else if (msg.type === "list") {
    serial(() => getList(msg.tabId)).then((list) => sendResponse(Object.values(list)));
    return true;
  } else if (msg.type === "download") {
    startDownload(msg).then(sendResponse);
    return true;
  } else if (msg.type === "status") {
    // HLS 다운로드 페이지가 진행 상황/실패 원인을 알려 온다.
    setStatus(msg.tabId, msg.url, msg.patch).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === "clear") {
    serial(() => clearList(msg.tabId)).then(() => sendResponse({ ok: true }));
    return true;
  }
});
