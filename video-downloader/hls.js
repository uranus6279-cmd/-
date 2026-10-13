// m3u8 재생목록을 읽어 조각(segment)을 모두 받은 뒤 하나의 파일로 합쳐 저장한다.
// 암호화(EXT-X-KEY)된 스트림은 지원하지 않는다.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const srcUrl = params.get("url");
const title = params.get("title") || "";
const CONCURRENCY = 6;
const RETRIES = 3;
let cancelled = false;

const log = (t) => ($("log").textContent = t);

async function fetchText(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.text();
}

async function fetchBytes(url) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (cancelled || i >= RETRIES) throw new Error(`조각 받기 실패 (${e.message}): ${url}`);
      await new Promise((res) => setTimeout(res, 500 * i));
    }
  }
}

// 속성 목록 파싱: BANDWIDTH=123,RESOLUTION=1280x720,CODECS="a,b"
function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

function parsePlaylist(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("m3u8 형식이 아닙니다.");
  const abs = (u) => new URL(u, base).href;

  const variants = [];
  const segments = [];
  let map = null;
  let encrypted = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#EXT-X-STREAM-INF:")) {
      const a = parseAttrs(l.slice(18));
      const uri = lines[i + 1];
      if (uri && !uri.startsWith("#")) {
        variants.push({ url: abs(uri), bandwidth: Number(a.BANDWIDTH) || 0, resolution: a.RESOLUTION || "" });
        i++;
      }
    } else if (l.startsWith("#EXT-X-KEY:")) {
      if (parseAttrs(l.slice(11)).METHOD !== "NONE") encrypted = true;
    } else if (l.startsWith("#EXT-X-MAP:")) {
      map = abs(parseAttrs(l.slice(11)).URI);
    } else if (!l.startsWith("#")) {
      segments.push(abs(l));
    }
  }
  const live = segments.length > 0 && !lines.includes("#EXT-X-ENDLIST");
  return { variants, segments, map, encrypted, live };
}

function fileName(ext) {
  const base = title.replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "video";
  return `${base}.${ext}`;
}

async function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const { saveAs = false } = await chrome.storage.local.get("saveAs");
  const opts = { url, filename: name, saveAs };
  let id = await chrome.downloads.download(opts).catch(() => null);
  if (!id) { delete opts.filename; id = await chrome.downloads.download(opts); }
  // 다운로드가 끝나면 메모리를 돌려준다.
  chrome.downloads.onChanged.addListener(function done(d) {
    if (d.id === id && d.state && d.state.current !== "in_progress") {
      URL.revokeObjectURL(url);
      chrome.downloads.onChanged.removeListener(done);
    }
  });
}

async function downloadMedia(playlistUrl) {
  log("재생목록 읽는 중…");
  const pl = parsePlaylist(await fetchText(playlistUrl), playlistUrl);
  if (pl.encrypted) throw new Error("암호화된 스트림이라 받을 수 없습니다.");
  if (pl.live) throw new Error("실시간(라이브) 방송은 지원하지 않습니다. 방송이 끝난 다시보기에서 시도하세요.");
  if (!pl.segments.length) throw new Error("영상 조각을 찾지 못했습니다.");

  const urls = pl.map ? [pl.map, ...pl.segments] : pl.segments;
  const parts = new Array(urls.length);
  let done = 0, bytes = 0, next = 0;
  $("bar").max = urls.length;
  $("cancel").classList.remove("hidden");

  async function worker() {
    while (!cancelled && next < urls.length) {
      const i = next++;
      parts[i] = await fetchBytes(urls[i]);
      done++; bytes += parts[i].length;
      $("bar").value = done;
      $("info").textContent = `${done} / ${urls.length} 조각 · ${(bytes / 1048576).toFixed(1)} MB`;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (cancelled) throw new Error("취소했습니다.");

  // EXT-X-MAP(init 조각)이 있으면 fMP4, 없으면 MPEG-TS 조각이다.
  const fmp4 = !!pl.map || /\.(m4s|mp4)(\?|$)/i.test(pl.segments[0]);
  const ext = fmp4 ? "mp4" : "ts";
  log("파일로 합치는 중…");
  await saveBlob(new Blob(parts, { type: fmp4 ? "video/mp4" : "video/mp2t" }), fileName(ext));
  $("cancel").classList.add("hidden");
  log(`완료! ${fileName(ext)} 저장을 시작했습니다. (Ctrl+J 로 확인)` +
    (ext === "ts" ? "\n.ts 파일은 VLC, 팟플레이어 등에서 바로 재생됩니다." : ""));
}

async function main() {
  $("src").textContent = srcUrl;
  $("cancel").onclick = () => { cancelled = true; };
  try {
    const pl = parsePlaylist(await fetchText(srcUrl), srcUrl);
    if (!pl.variants.length) return await downloadMedia(srcUrl);

    // 마스터 재생목록: 화질을 고르게 한다(기본은 가장 높은 화질).
    pl.variants.sort((a, b) => b.bandwidth - a.bandwidth);
    for (const v of pl.variants) {
      const o = document.createElement("option");
      o.value = v.url;
      o.textContent = `${v.resolution || "해상도 미표시"} · ${(v.bandwidth / 1e6).toFixed(2)} Mbps`;
      $("variant").append(o);
    }
    $("pick").classList.remove("hidden");
    log("화질을 고른 뒤 '받기 시작'을 누르세요.");
    $("start").onclick = async () => {
      $("pick").classList.add("hidden");
      try { await downloadMedia($("variant").value); } catch (e) { log(`실패: ${e.message}`); }
    };
  } catch (e) {
    log(`실패: ${e.message}`);
  }
}

main();
