// 영상 종료 신호를 받아 '다음 회차'로 이동시키는 중앙 제어부
const DEFAULTS = {
  enabled: true,
  mode: 'button',
  loop: true,
  firstUrl: '',
  urlPattern: '',
  urlStart: 1,
  urlEnd: 10,
  delaySec: 3,
};

const busy = new Set(); // 탭별 중복 처리 방지

function getSettings() {
  return new Promise((r) => chrome.storage.sync.get(DEFAULTS, r));
}

function setStatus(text) {
  chrome.storage.local.set({ lastStatus: `${new Date().toLocaleTimeString()} - ${text}` });
}

// 'https://site.com/lec?no={n}' 같은 패턴. {nn}, {nnn} 은 0으로 자릿수 채움
function parsePattern(pattern) {
  const m = pattern.match(/\{(n+)\}/);
  if (!m) return null;
  const [before, after] = pattern.split(m[0]);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { re: new RegExp('^' + esc(before) + '(\\d+)' + esc(after) + '$'), before, after, pad: m[1].length };
}
function buildUrl(p, n) {
  return p.before + String(n).padStart(p.pad, '0') + p.after;
}

async function clickNextInAnyFrame(tabId) {
  let frames = [{ frameId: 0 }];
  try {
    const all = await chrome.webNavigation.getAllFrames({ tabId });
    if (all) frames = [{ frameId: 0 }, ...all.filter((f) => f.frameId !== 0)];
  } catch (_) {}
  for (const { frameId } of frames) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'CLICK_NEXT' }, { frameId });
      if (res?.clicked) return res;
    } catch (_) { /* 해당 프레임에 content script 없음 */ }
  }
  return null;
}

async function advance(tabId, tabUrl) {
  const s = await getSettings();
  if (!s.enabled) return;

  if (s.mode === 'url') {
    const p = parsePattern(s.urlPattern || '');
    if (!p) return setStatus('URL 패턴에 {n} 이 없습니다.');
    const m = (tabUrl || '').match(p.re);
    const cur = m ? parseInt(m[1], 10) : s.urlStart - 1;
    let next = cur + 1;
    if (next > s.urlEnd) {
      if (!s.loop) return setStatus('마지막 회차 완료 (반복 꺼짐)');
      next = Number(s.urlStart);
    }
    setStatus(`${next}회차로 이동`);
    return chrome.tabs.update(tabId, { url: buildUrl(p, next) });
  }

  const res = await clickNextInAnyFrame(tabId);
  if (res) return setStatus(`'${res.label}' 버튼 클릭`);

  if (s.loop && s.firstUrl) {
    setStatus('다음 버튼 없음 → 1회차로 돌아가 반복');
    return chrome.tabs.update(tabId, { url: s.firstUrl });
  }
  setStatus('다음 버튼을 찾지 못했습니다. 팝업에서 버튼 선택자/키워드를 설정하세요.');
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== 'VIDEO_ENDED' || !sender.tab) return;
  const tabId = sender.tab.id;
  if (busy.has(tabId)) return;
  busy.add(tabId);
  getSettings().then((s) => {
    setStatus(`영상 종료 감지 → ${s.delaySec}초 후 다음 회차`);
    setTimeout(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        await advance(tabId, tab.url);
      } finally {
        setTimeout(() => busy.delete(tabId), 2000);
      }
    }, Math.max(0, Number(s.delaySec) || 0) * 1000);
  });
});

// 다음 페이지로 넘어가면 즉시 잠금 해제
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) busy.delete(tabId);
});

// 팝업의 '지금 다음으로' 버튼
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ADVANCE_NOW') {
    advance(msg.tabId, msg.tabUrl).then(() => sendResponse({ ok: true }));
    return true;
  }
});
