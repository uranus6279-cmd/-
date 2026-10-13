const $ = (id) => document.getElementById(id);
const status = (t) => ($("status").textContent = t);

let tab = null;
let statuses = {}; // url -> { state, reason, progress, file, downloadId }
const statusEls = new Map(); // url -> 상태 표시 요소

function fmtSize(n) {
  if (!n) return "크기 알 수 없음";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

async function loadStatuses() {
  const k = `st:${tab.id}`;
  statuses = (await chrome.storage.session.get(k))[k] || {};
  for (const [url, el] of statusEls) paintStatus(el, statuses[url]);
}

// 항목 아래에 진행률 / 완료 / 실패 원인을 표시한다.
function paintStatus(el, st) {
  el.className = "state";
  el.textContent = "";
  if (!st) return;
  if (st.state === "running") {
    el.classList.add("running");
    el.textContent = `⏳ 받는 중 ${Math.floor((st.progress || 0) * 100)}%`;
  } else if (st.state === "waiting") {
    el.classList.add("running");
    el.textContent = `⏸ ${st.reason}`;
  } else if (st.state === "done") {
    el.classList.add("done");
    el.textContent = `✅ 완료: ${st.file || ""}${st.note ? ` (${st.note})` : ""}`;
  } else if (st.state === "failed") {
    el.classList.add("failed");
    const b = document.createElement("b");
    b.textContent = "❌ 실패 원인: ";
    el.append(b, st.reason || "알 수 없는 오류");
  }
}

// 일반 다운로드는 진행률 알림이 따로 없으므로 열려 있는 동안 1초마다 확인한다.
async function pollProgress() {
  for (const [url, st] of Object.entries(statuses)) {
    if (st.state !== "running" || !st.downloadId) continue;
    const [d] = await chrome.downloads.search({ id: st.downloadId });
    if (d && d.state === "in_progress" && d.totalBytes > 0) {
      st.progress = d.bytesReceived / d.totalBytes;
      const el = statusEls.get(url);
      if (el) paintStatus(el, st);
    }
  }
}

async function main() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = (() => { try { return new URL(tab.url).hostname; } catch { return ""; } })();

  const { saveAs = false } = await chrome.storage.local.get("saveAs");
  $("saveAs").checked = saveAs;
  $("saveAs").onchange = () => chrome.storage.local.set({ saveAs: $("saveAs").checked });

  $("clear").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "clear", tabId: tab.id });
    render([]);
  };

  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) {
    $("empty").innerHTML =
      "YouTube는 지원하지 않습니다. YouTube 영상은 오프라인 저장이 필요하면 " +
      "YouTube Premium의 '오프라인 저장' 기능을 이용하세요.";
    return;
  }

  render(await chrome.runtime.sendMessage({ type: "list", tabId: tab.id }));
  await loadStatuses();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[`st:${tab.id}`]) loadStatuses();
  });
  setInterval(pollProgress, 1000);
}

function render(items) {
  const list = $("list");
  list.textContent = "";
  statusEls.clear();
  $("empty").style.display = items.length ? "none" : "";
  // 스트리밍 목록은 먼저 발견된 순서로 위에 둔다. 플레이어는 화질/음성 정보가 담긴
  // 전체 목록(master)을 가장 먼저 받으므로, 맨 위 항목이 영상+음성을 함께 받는 목록이다.
  // 일반 파일은 큰 것(본 영상일 가능성이 높음)이 위로 오게 한다.
  items.sort((a, b) =>
    (b.stream - a.stream) || (a.stream ? (a.seen || 0) - (b.seen || 0) : (b.size || 0) - (a.size || 0)));

  for (const item of items) {
    const li = document.createElement("li");

    const url = document.createElement("div");
    url.className = "url";
    url.textContent = item.url;
    url.title = item.url;

    const meta = document.createElement("div");
    meta.className = "meta";
    const tags = [item.type || "알 수 없는 형식", fmtSize(item.size)];
    if (item.stream) tags.push("스트리밍 목록(HLS/DASH)");
    for (const t of tags) {
      const s = document.createElement("span");
      s.className = "tag" + (t.startsWith("스트리밍") ? " warn" : "");
      s.textContent = t;
      meta.append(s);
    }

    const btns = document.createElement("div");
    btns.className = "btns";
    const dl = document.createElement("button");
    const hls = /\.m3u8(\?|#|$)/i.test(item.url) || /mpegurl/i.test(item.type || "");
    dl.textContent = hls ? "합쳐서 받기" : item.stream ? "목록 파일 받기" : "다운로드";
    dl.onclick = async () => {
      if (hls) {
        const q = new URLSearchParams({ url: item.url, title: tab?.title || "", ref: tab?.url || "", tabId: tab?.id });
        return chrome.tabs.create({ url: chrome.runtime.getURL(`hls.html?${q}`) });
      }
      status("다운로드 시작 중…");
      const res = await chrome.runtime.sendMessage({
        type: "download", item, tabId: tab.id, title: tab?.title, pageUrl: tab?.url, saveAs: $("saveAs").checked,
      });
      status(res.ok ? "다운로드를 시작했습니다. (Ctrl+J 로 확인)" : "");
    };
    const copy = document.createElement("button");
    copy.textContent = "주소 복사";
    copy.onclick = async () => {
      await navigator.clipboard.writeText(item.url);
      status("주소를 복사했습니다.");
    };
    btns.append(dl, copy);

    const state = document.createElement("div");
    statusEls.set(item.url, state);
    paintStatus(state, statuses[item.url]);

    li.append(url, meta, btns, state);
    if (item.stream && !hls) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "DASH(.mpd) 목록입니다. 하나의 파일로 합치려면 ffmpeg 같은 도구가 필요합니다.";
      li.append(hint);
    }
    list.append(li);
  }
}

main();
