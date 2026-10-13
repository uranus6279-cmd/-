// 페이지 안에서 실행된다. 주소나 형식(Content-Type)만으로는 알 수 없는
// m3u8 재생목록(예: /api/play?id=7, text/plain)을 응답 내용으로 찾아낸다.
(() => {
  const MAGIC = "#EXTM3U";
  const reported = new Set();
  const report = (url) => {
    if (!url || reported.has(url)) return;
    reported.add(url);
    window.postMessage({ __videoDownloader: "m3u8", url }, "*");
  };
  // content.js는 페이지 로드 후에 시작되므로, 그 전에 찾은 것은 인사를 받으면 다시 보낸다.
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data?.__videoDownloader === "hello")
      for (const url of reported) window.postMessage({ __videoDownloader: "m3u8", url }, "*");
  });
  // 영상 조각 같은 큰 응답은 건드리지 않는다.
  const worthChecking = (type, length) =>
    !/^(video|audio|image|font)\//i.test(type || "") && !(Number(length) > 2 * 1024 * 1024);

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      if (res.ok && worthChecking(res.headers.get("content-type"), res.headers.get("content-length"))) {
        // 복사본의 앞부분만 읽고 멈춘다(원래 응답은 페이지가 그대로 쓴다).
        const reader = res.clone().body?.getReader();
        reader?.read().then(({ value }) => {
          reader.cancel().catch(() => {});
          const head = new TextDecoder().decode((value || new Uint8Array()).slice(0, 16)).replace(/^﻿/, "");
          if (head.startsWith(MAGIC)) report(res.url);
        }).catch(() => {});
      }
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener("load", () => {
      try {
        if (this.status >= 400) return;
        if (!worthChecking(this.getResponseHeader("content-type"), this.getResponseHeader("content-length"))) return;
        let head = "";
        if (this.responseType === "" || this.responseType === "text") head = this.responseText.slice(0, 16);
        else if (this.responseType === "arraybuffer" && this.response)
          head = new TextDecoder().decode(new Uint8Array(this.response, 0, Math.min(16, this.response.byteLength)));
        if (head.replace(/^﻿/, "").startsWith(MAGIC)) report(this.responseURL);
      } catch {}
    });
    return origOpen.apply(this, args);
  };
})();
