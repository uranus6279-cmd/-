// 페이지 안의 <video>, <audio>, <source> 태그에서 직접 재생 주소를 찾아 알린다.
(() => {
  const sent = new Set();

  function abs(url) {
    try { return new URL(url, location.href).href; } catch { return ""; }
  }

  function scan() {
    const items = [];
    document.querySelectorAll("video, audio, source").forEach((el) => {
      for (const raw of [el.currentSrc, el.src, el.getAttribute("src")]) {
        const url = raw && abs(raw);
        if (!url || !/^https?:/.test(url) || sent.has(url)) continue;
        sent.add(url);
        const tag = el.tagName === "SOURCE" ? el.parentElement?.tagName : el.tagName;
        items.push({ url, type: el.type || (tag === "AUDIO" ? "audio/" : "video/") });
      }
    });
    if (items.length) chrome.runtime.sendMessage({ type: "found", items }).catch(() => {});
  }

  // main-world.js가 내용으로 찾아낸 m3u8 재생목록을 전달한다.
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || d?.__videoDownloader !== "m3u8" || sent.has(d.url)) return;
    if (!/^https?:/.test(d.url)) return;
    sent.add(d.url);
    chrome.runtime.sendMessage({
      type: "found", items: [{ url: d.url, type: "application/vnd.apple.mpegurl" }],
    }).catch(() => {});
  });

  window.postMessage({ __videoDownloader: "hello" }, "*");

  scan();
  new MutationObserver(() => scan()).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["src"],
  });
  document.addEventListener("loadedmetadata", scan, true);
})();
