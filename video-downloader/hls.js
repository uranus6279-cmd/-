// m3u8 재생목록을 읽어 조각(segment)을 모두 받은 뒤 하나의 파일로 합쳐 저장한다.
// 암호화(EXT-X-KEY)된 스트림과 라이브 방송은 지원하지 않는다.
// 진행 상황과 실패 원인은 background를 거쳐 팝업에도 표시된다.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const srcUrl = params.get("url");
const title = params.get("title") || "";
const pageUrl = params.get("ref") || "";
const sourceTabId = Number(params.get("tabId"));
const CONCURRENCY = 6;
const RETRIES = 3;
const STALL_MS = 20000; // 이 시간 동안 데이터가 한 바이트도 안 오면 다시 시도한다.
let cancelled = false;
let ruleId = 0;

const log = (t) => ($("log").textContent = t);

// 팝업에 보여줄 상태를 알린다(팝업이 닫혀 있어도 저장된다).
function report(patch) {
  if (!Number.isInteger(sourceTabId)) return;
  chrome.runtime.sendMessage({ type: "status", tabId: sourceTabId, url: srcUrl, patch }).catch(() => {});
}

class Failure extends Error {}

function fail(reason) {
  log(`실패: ${reason}`);
  report({ state: "failed", reason });
  $("cancel").classList.add("hidden");
}

// 핫링크 차단 사이트를 위해 이 탭이 보내는 요청에 원래 페이지 주소를 Referer로 붙인다.
async function setReferer() {
  if (!/^https?:/.test(pageUrl)) return;
  const tab = await chrome.tabs.getCurrent();
  ruleId = tab.id;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId, priority: 1,
      condition: { tabIds: [tab.id] },
      action: { type: "modifyHeaders", requestHeaders: [
        { header: "Referer", operation: "set", value: pageUrl },
        { header: "Origin", operation: "set", value: new URL(pageUrl).origin },
      ] },
    }],
  }).catch(() => {});
}
const clearReferer = () => ruleId && chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
addEventListener("pagehide", clearReferer);

// 한 번 요청한다. 응답이 STALL_MS 동안 멈추면 중단한다.
async function fetchOnce(url, range, asText, onChunk, sink) {
  const ctrl = new AbortController();
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), STALL_MS); };
  arm();
  try {
    const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : {};
    let r;
    try {
      r = await fetch(url, { credentials: "include", headers, signal: ctrl.signal });
    } catch (e) {
      throw new Error(ctrl.signal.aborted
        ? `서버가 ${STALL_MS / 1000}초 동안 응답하지 않았습니다.`
        : "서버에 연결하지 못했습니다(네트워크 오류).");
    }
    if (!r.ok) {
      const err = new Error(httpErrorText(r.status));
      err.status = r.status;
      throw err;
    }
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      arm();
      let res;
      try { res = await reader.read(); } catch {
        throw new Error(ctrl.signal.aborted
          ? `받는 도중 ${STALL_MS / 1000}초 동안 데이터가 오지 않았습니다.`
          : "받는 도중 연결이 끊겼습니다.");
      }
      if (res.done) break;
      total += res.value.length;
      if (sink) {
        clearTimeout(timer); // 디스크 쓰기 시간은 응답 대기 시간에 넣지 않는다.
        await sink.write(res.value);
      } else {
        chunks.push(res.value);
      }
      onChunk?.(total, Number(r.headers.get("content-length")) || 0);
    }
    if (sink) return { bytes: null, url: r.url, type: r.headers.get("content-type") };
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
    if (range && r.status === 200) {
      // 서버가 Range를 무시하고 파일 전체를 줬다면 필요한 부분만 잘라 쓴다.
      return { bytes: bytes.subarray(range[0], range[1] + 1), url: r.url };
    }
    return { bytes: asText ? new TextDecoder().decode(bytes) : bytes, url: r.url, type: r.headers.get("content-type") };
  } finally {
    clearTimeout(timer);
  }
}

// 실패하면 잠시 쉬었다 다시 시도한다. 401/403/404처럼 다시 해도 안 될 오류는 바로 포기한다.
async function fetchRetry(url, range, asText) {
  for (let i = 1; ; i++) {
    try {
      return await fetchOnce(url, range, asText);
    } catch (e) {
      const permanent = [401, 403, 404, 410].includes(e.status);
      if (cancelled || permanent || i >= RETRIES) throw e;
      await new Promise((res) => setTimeout(res, 700 * i));
    }
  }
}

async function fetchText(url) {
  const { bytes, url: finalUrl } = await fetchRetry(url, null, true);
  // 리다이렉트됐다면 상대 경로는 최종 주소를 기준으로 풀어야 한다.
  return { text: bytes, base: finalUrl || url };
}

// 속성 목록 파싱: BANDWIDTH=123,RESOLUTION=1280x720,CODECS="a,b"
function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

// "길이@시작" 형식의 바이트 범위. 시작이 없으면 같은 파일의 이전 범위 바로 뒤부터다.
function parseByteRange(spec, url, lastEnd) {
  const [len, start] = spec.split("@").map(Number);
  const a = Number.isFinite(start) ? start : (lastEnd.get(url) ?? 0);
  lastEnd.set(url, a + len);
  return [a, a + len - 1];
}

function parsePlaylist(text, base) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Failure("m3u8 재생목록이 아닙니다. 주소가 만료됐거나 로그인 페이지로 이동됐을 수 있습니다.");
  const abs = (u) => new URL(u, base).href;

  const variants = [];
  const audios = [];
  const segments = [];
  const lastEnd = new Map();
  let map = null;
  let encrypted = false;
  let pendingRange = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("#EXT-X-STREAM-INF:")) {
      const a = parseAttrs(l.slice(18));
      const uri = lines[i + 1];
      if (uri && !uri.startsWith("#")) {
        variants.push({ url: abs(uri), bandwidth: Number(a.BANDWIDTH) || 0, resolution: a.RESOLUTION || "", audio: a.AUDIO });
        i++;
      }
    } else if (l.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttrs(l.slice(13));
      if (a.TYPE === "AUDIO" && a.URI) audios.push({ group: a["GROUP-ID"], url: abs(a.URI), name: a.NAME, def: a.DEFAULT === "YES", lang: a.LANGUAGE });
    } else if (l.startsWith("#EXT-X-KEY:")) {
      if (parseAttrs(l.slice(11)).METHOD !== "NONE") encrypted = true;
    } else if (l.startsWith("#EXT-X-MAP:")) {
      const a = parseAttrs(l.slice(11));
      const url = abs(a.URI);
      map = { url, range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, url, lastEnd) : null };
    } else if (l.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = l.slice(17);
    } else if (!l.startsWith("#")) {
      const url = abs(l);
      segments.push({ url, range: pendingRange ? parseByteRange(pendingRange, url, lastEnd) : null });
      pendingRange = null;
    }
  }
  const live = segments.length > 0 && !lines.includes("#EXT-X-ENDLIST");
  return { variants, audios, segments, map, encrypted, live };
}

function safeTitle() {
  return title.replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

// 받은 데이터를 메모리에 쌓지 않고 브라우저 전용 저장소(OPFS)의 임시 파일에 차례로 쓴다.
// 덕분에 수 GB 영상도 메모리를 거의 쓰지 않는다. OPFS를 쓸 수 없으면 메모리에 모은다.
const TMP_PREFIX = "tmp-";
async function openSink(type) {
  try {
    const dir = await navigator.storage.getDirectory();
    const name = `${TMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    const remove = () => dir.removeEntry(name).catch(() => {});
    return {
      write: (b) => w.write(b),
      async finish() {
        await w.close();
        const f = await handle.getFile();
        return { blob: f.slice(0, f.size, type), cleanup: remove };
      },
      abort: () => w.abort().catch(() => {}).then(remove),
    };
  } catch {
    const parts = [];
    return {
      write: async (b) => { parts.push(b); },
      finish: async () => ({ blob: new Blob(parts, { type }), cleanup: () => {} }),
      abort: async () => { parts.length = 0; },
    };
  }
}

// 탭을 닫아 중간에 끊긴 다운로드의 임시 파일을 지운다(하루 넘게 지난 것만).
async function cleanupOldTemp() {
  try {
    const dir = await navigator.storage.getDirectory();
    for await (const [name, h] of dir.entries()) {
      if (!name.startsWith(TMP_PREFIX)) continue;
      const f = await h.getFile();
      if (Date.now() - f.lastModified > 24 * 3600 * 1000) await dir.removeEntry(name).catch(() => {});
    }
  } catch {}
}

function diskError(e) {
  return /quota/i.test(`${e?.name} ${e?.message}`)
    ? "디스크 공간이 부족해 임시 파일을 쓰지 못했습니다."
    : `임시 파일을 쓰지 못했습니다 (${e?.message || e}).`;
}

async function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const { saveAs = false } = await chrome.storage.local.get("saveAs");
  const opts = { url, filename: name, saveAs };
  let id = await chrome.downloads.download(opts).catch(() => null);
  if (!id) { delete opts.filename; id = await chrome.downloads.download(opts).catch(() => null); }
  if (!id) { URL.revokeObjectURL(url); throw new Failure("파일 저장을 시작하지 못했습니다."); }
  // 저장이 끝날 때까지 기다려 결과(완료/실패 원인)를 알린다.
  return new Promise((resolve, reject) => {
    chrome.downloads.onChanged.addListener(function done(d) {
      if (d.id !== id || !d.state || d.state.current === "in_progress") return;
      chrome.downloads.onChanged.removeListener(done);
      URL.revokeObjectURL(url);
      if (d.state.current === "complete") return resolve(name);
      chrome.downloads.search({ id }).then(([it]) => reject(new Failure(downloadErrorText(it?.error))));
    });
  });
}

// MPEG-TS 조각은 0x47 바이트가 188바이트 간격으로 반복된다. 일부 사이트는 조각을
// 이미지처럼 보이게 하려고 앞에 가짜 PNG/JPG 머리를 붙이는데, 그 부분을 잘라낸다.
// TS가 아니면(오디오 전용 .aac 등) 그대로 둔다. 찾지 못하면 null을 돌려준다.
function stripToTs(bytes) {
  const isSync = (o) => bytes[o] === 0x47 && bytes[o + 188] === 0x47 && bytes[o + 376] === 0x47;
  if (isSync(0)) return bytes;
  const limit = Math.min(bytes.length - 377, 64 * 1024);
  for (let o = 1; o < limit; o++) if (isSync(o)) return bytes.subarray(o);
  return null;
}
let unknownFormat = false;

// 재생목록 하나의 조각을 모두 받아 순서대로 sink에 쓴다.
// 조각은 동시에 여러 개 받으므로 도착 순서가 뒤섞인다. 앞 조각이 올 때까지 잠시 보관하되,
// 보관량이 너무 커지면 새 조각 받기를 멈춰 메모리 사용량을 일정하게 유지한다.
const MAX_BUFFERED = 64 * 1024 * 1024;
async function fetchAll(pl, onProgress, sink) {
  const jobs = pl.map ? [pl.map, ...pl.segments] : pl.segments;
  const pending = new Map();
  let next = 0, writeIdx = 0, buffered = 0, writeError = null;
  let writing = Promise.resolve();
  const deliver = (i, bytes) => {
    pending.set(i, bytes);
    buffered += bytes.length;
    while (pending.has(writeIdx)) {
      const b = pending.get(writeIdx);
      pending.delete(writeIdx++);
      writing = writing.then(() => writeError || sink.write(b))
        .catch((e) => { writeError = e; cancelled = true; })
        .finally(() => { buffered -= b.length; });
    }
  };
  async function worker() {
    while (!cancelled && next < jobs.length) {
      if (buffered > MAX_BUFFERED) { await new Promise((r) => setTimeout(r, 50)); continue; }
      const i = next++;
      let bytes;
      try {
        bytes = (await fetchRetry(jobs[i].url, jobs[i].range)).bytes;
      } catch (e) {
        if (writeError) return;
        cancelled = true;
        throw new Failure(`${e.message} (전체 ${jobs.length}개 중 ${i + 1}번째 조각)`);
      }
      if (!pl.map && !/\.(aac|mp3|ac3|ec3|m4s|mp4|m4a|vtt)(\?|$)/i.test(jobs[i].url)) {
        const ts = stripToTs(bytes);
        if (ts) bytes = ts; else unknownFormat = true;
      }
      deliver(i, bytes);
      onProgress(bytes.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await writing;
  if (writeError) throw new Failure(diskError(writeError));
}

async function loadMedia(url, label) {
  const { text, base } = await fetchText(url);
  const pl = parsePlaylist(text, base);
  if (pl.encrypted) throw new Failure(`${label}이 암호화된 스트림이라 받을 수 없습니다(DRM/암호화).`);
  if (pl.live) throw new Failure("실시간(라이브) 방송은 지원하지 않습니다. 방송이 끝난 다시보기에서 시도하세요.");
  if (!pl.segments.length) throw new Failure(`${label} 조각을 찾지 못했습니다.`);
  return pl;
}

async function downloadVariant(videoUrl, audioUrl) {
  log("재생목록 읽는 중…");
  report({ state: "running", progress: 0 });
  const tracks = [{ pl: await loadMedia(videoUrl, "영상"), label: "" }];
  if (audioUrl) tracks.push({ pl: await loadMedia(audioUrl, "음성"), label: " (음성)" });

  const total = tracks.reduce((n, t) => n + t.pl.segments.length + (t.pl.map ? 1 : 0), 0);
  let done = 0, bytes = 0, lastReport = 0;
  $("bar").max = total;
  $("cancel").classList.remove("hidden");
  const onProgress = (n) => {
    done++; bytes += n;
    $("bar").value = done;
    $("info").textContent = `${done} / ${total} 조각 · ${(bytes / 1048576).toFixed(1)} MB`;
    if (Date.now() - lastReport > 500 || done === total) {
      lastReport = Date.now();
      report({ state: "running", progress: done / total });
    }
  };

  const names = [];
  for (const t of tracks) {
    if (cancelled) break;
    const fmp4 = !!t.pl.map || /\.(m4s|mp4)(\?|$)/i.test(t.pl.segments[0].url);
    const sink = await openSink(fmp4 ? "video/mp4" : "video/mp2t");
    try {
      await fetchAll(t.pl, onProgress, sink);
    } catch (e) {
      await sink.abort();
      throw e;
    }
    log("파일로 저장하는 중…");
    const { blob, cleanup } = await sink.finish().catch((e) => { throw new Failure(diskError(e)); });
    const ext = fmp4 ? (t.label ? "m4a" : "mp4") : "ts";
    try {
      names.push(await saveBlob(blob, `${safeTitle()}${t.label}.${ext}`));
    } finally {
      cleanup();
    }
  }
  if (cancelled) throw new Failure("사용자가 취소했습니다.");

  $("cancel").classList.add("hidden");
  let msg = `완료! ${names.join(", ")} 저장했습니다. (Ctrl+J 로 확인)`;
  if (names.length > 1)
    msg += "\n이 영상은 사이트에서 영상과 음성을 따로 보내 두 파일로 저장했습니다. 하나로 합치려면:\n" +
      `ffmpeg -i "${names[0]}" -i "${names[1]}" -c copy "${safeTitle()}.mp4"`;
  else if (names[0].endsWith(".ts"))
    msg += "\n.ts 파일은 VLC, 팟플레이어 등에서 바로 재생됩니다.";
  const notes = [];
  if (names.length > 1) notes.push("영상과 음성이 따로 저장됨");
  if (unknownFormat) {
    notes.push("일부 조각의 형식을 알 수 없어 재생되지 않을 수 있음");
    msg += "\n⚠️ 일부 조각이 알 수 없는 형식이었습니다. 사이트가 조각을 변형했다면 저장된 파일이 재생되지 않을 수 있습니다.";
  }
  log(msg);
  report({ state: "done", file: names.join(", "), note: notes.join(", ") });
}

async function run(videoUrl, audioUrl) {
  try {
    await downloadVariant(videoUrl, audioUrl);
  } catch (e) {
    fail(e instanceof Failure ? e.message : `${e.message}`);
  } finally {
    clearReferer();
  }
}

// 일반 파일(mp4 등)을 Referer를 붙여 받는다. 크롬 다운로드가 403으로 막혔을 때 쓴다.
async function downloadFile() {
  document.querySelector("h1").textContent = "📼 파일 다시 받기 (핫링크 차단 우회)";
  log("받는 중…");
  report({ state: "running", progress: 0, note: "다른 방법으로 다시 시도 중" });
  let lastReport = 0;
  const sink = await openSink("");
  let type;
  const onChunk = (got, total) => {
    $("bar").max = total || 1;
    $("bar").value = total ? got : 0;
    $("info").textContent = `${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ""}`;
    if (total && Date.now() - lastReport > 500) {
      lastReport = Date.now();
      report({ state: "running", progress: got / total, note: "다른 방법으로 다시 시도 중" });
    }
  };
  try {
    ({ type } = await fetchOnce(srcUrl, null, false, onChunk, sink));
  } catch (e) {
    await sink.abort();
    throw e;
  }
  const name = params.get("name") || `${safeTitle()}.mp4`;
  const { blob, cleanup } = await sink.finish().catch((e) => { throw new Failure(diskError(e)); });
  // 형식이 없으면 크롬이 확장자를 .txt로 바꾸므로 서버가 알려준 형식을 붙인다.
  const mime = /^(video|audio)\//i.test(type || "") ? type.split(";")[0] : "application/octet-stream";
  try {
    await saveBlob(blob.slice(0, blob.size, mime), name);
  } finally {
    cleanup();
  }
  log(`완료! ${name} 저장했습니다. (Ctrl+J 로 확인)`);
  report({ state: "done", file: name });
}

async function main() {
  $("src").textContent = srcUrl;
  cleanupOldTemp();
  if (params.get("mode") === "file") {
    try {
      await setReferer();
      await downloadFile();
    } catch (e) {
      fail(`${e.message} (페이지 주소를 붙여 다시 시도했지만 실패)`);
    } finally {
      clearReferer();
    }
    return;
  }
  $("cancel").onclick = () => { cancelled = true; };
  try {
    await setReferer();
    const { text, base } = await fetchText(srcUrl);
    const pl = parsePlaylist(text, base);
    if (!pl.variants.length) return await run(srcUrl, null);

    // 마스터 재생목록: 화질을 고르게 한다(기본은 가장 높은 화질).
    const audioFor = (v) => {
      const group = pl.audios.filter((a) => a.group === v.audio);
      return (group.find((a) => a.def) || group[0])?.url || null;
    };
    pl.variants.sort((a, b) => b.bandwidth - a.bandwidth);
    for (const v of pl.variants) {
      const o = document.createElement("option");
      o.value = v.url;
      o.textContent = `${v.resolution || "해상도 미표시"} · ${(v.bandwidth / 1e6).toFixed(2)} Mbps`;
      $("variant").append(o);
    }
    $("pick").classList.remove("hidden");
    log("화질을 고른 뒤 '받기 시작'을 누르세요.");
    report({ state: "waiting", reason: "다운로드 탭에서 화질을 골라 주세요." });
    $("start").onclick = () => {
      $("pick").classList.add("hidden");
      const v = pl.variants.find((x) => x.url === $("variant").value);
      run(v.url, audioFor(v));
    };
  } catch (e) {
    fail(e.message);
    clearReferer();
  }
}

main();
