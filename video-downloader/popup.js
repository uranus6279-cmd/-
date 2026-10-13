const $ = (id) => document.getElementById(id);
const status = (t) => ($("status").textContent = t);

function fmtSize(n) {
  if (!n) return "크기 알 수 없음";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

  render(await chrome.runtime.sendMessage({ type: "list", tabId: tab.id }), tab);
}

function render(items, tab) {
  const list = $("list");
  list.textContent = "";
  $("empty").style.display = items.length ? "none" : "";
  // 큰 파일(본 영상일 가능성이 높음)이 위로 오도록 정렬한다.
  items.sort((a, b) => (b.size || 0) - (a.size || 0));

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
        const q = new URLSearchParams({ url: item.url, title: tab?.title || "" });
        return chrome.tabs.create({ url: chrome.runtime.getURL(`hls.html?${q}`) });
      }
      status("다운로드 시작 중…");
      const res = await chrome.runtime.sendMessage({
        type: "download", item, title: tab?.title, saveAs: $("saveAs").checked,
      });
      status(res.ok ? "다운로드를 시작했습니다. (Ctrl+J 로 확인)" : `실패: ${res.error || "알 수 없는 오류"}`);
    };
    const copy = document.createElement("button");
    copy.textContent = "주소 복사";
    copy.onclick = async () => {
      await navigator.clipboard.writeText(item.url);
      status("주소를 복사했습니다.");
    };
    btns.append(dl, copy);

    li.append(url, meta, btns);
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
