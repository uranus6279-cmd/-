// 모든 페이지/프레임에서 실행: 영상 종료를 감지하고, 요청받으면 '다음' 버튼을 찾아 클릭합니다.
const DEFAULTS = {
  enabled: true,
  mode: 'button', // 'button' | 'url'
  nextSelector: '',
  nextKeywords: '다음 차시, 다음차시, 다음 강의, 다음강의, 다음 회차, 다음회차, 다음 영상, 다음 페이지, 다음, Next',
  loop: true,
  firstUrl: '',
  urlPattern: '',
  urlStart: 1,
  urlEnd: 10,
  delaySec: 3,
  autoPlay: true,
  playbackRate: 1,
  autoConfirm: true,
};

let settings = { ...DEFAULTS };
const hooked = new WeakSet();
let firedFor = null; // 이미 '종료' 처리한 영상 (중복 방지)

function applyDatasetFlag() {
  const on = settings.enabled && settings.autoConfirm;
  document.documentElement.dataset.lectureAutoConfirm = on ? '1' : '0';
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  settings = s;
  applyDatasetFlag();
  scanVideos();
});
chrome.storage.onChanged.addListener((changes) => {
  for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
  applyDatasetFlag();
  document.querySelectorAll('video').forEach(applyVideoSettings);
});

// ---------- 영상 감지 ----------
function applyVideoSettings(v) {
  if (!settings.enabled) return;
  const rate = Number(settings.playbackRate) || 1;
  if (v.playbackRate !== rate) v.playbackRate = rate;
}

function tryAutoPlay(v) {
  if (!settings.enabled || !settings.autoPlay || !v.paused || v.ended) return;
  v.play().catch(() => {
    // 브라우저 자동재생 정책에 막힌 경우: 음소거로라도 재생 (README의 자동재생 허용 방법 참고)
    v.muted = true;
    v.play().catch(() => {});
  });
}

function onFinished(v) {
  if (!settings.enabled || firedFor === v) return;
  firedFor = v;
  chrome.runtime.sendMessage({ type: 'VIDEO_ENDED' });
}

function hook(v) {
  if (hooked.has(v)) return;
  hooked.add(v);
  applyVideoSettings(v);
  v.addEventListener('ended', () => onFinished(v));
  // 일부 플레이어는 ended 이벤트 없이 마지막 프레임에서 멈추므로 보조 감지
  v.addEventListener('timeupdate', () => {
    if (v.duration > 5 && v.duration - v.currentTime < 0.5 && !v.loop) {
      setTimeout(() => { if (v.paused || v.ended) onFinished(v); }, 1500);
    }
  });
  // 새 영상이 로드되거나 다시 재생되면 종료 플래그 해제 (SPA 방식 사이트 대응)
  v.addEventListener('loadedmetadata', () => { if (firedFor === v) firedFor = null; tryAutoPlay(v); });
  v.addEventListener('play', () => {
    if (firedFor === v && v.currentTime < v.duration - 2) firedFor = null;
    applyVideoSettings(v);
  });
  if (v.readyState >= 1) tryAutoPlay(v);
}

function scanVideos() {
  document.querySelectorAll('video').forEach(hook);
}
new MutationObserver(scanVideos).observe(document.documentElement, { childList: true, subtree: true });
setInterval(scanVideos, 2000);

// ---------- '다음' 버튼 찾기 ----------
function isVisible(el) {
  if (!el.getClientRects().length) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0;
}
function isDisabled(el) {
  return el.disabled || el.getAttribute('aria-disabled') === 'true' ||
    /\bdisabled?\b/i.test(el.className || '');
}
function labelOf(el) {
  return [el.innerText, el.value, el.title, el.getAttribute('aria-label'), el.getAttribute('alt')]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function findNextButton() {
  if (settings.nextSelector) {
    for (const el of document.querySelectorAll(settings.nextSelector)) {
      if (isVisible(el) && !isDisabled(el)) return el;
    }
    return null;
  }
  const keywords = settings.nextKeywords.split(',').map((k) => k.trim()).filter(Boolean);
  const candidates = [...document.querySelectorAll(
    'a, button, input[type=button], input[type=submit], input[type=image], img, [role=button], [onclick]'
  )].filter((el) => isVisible(el) && !isDisabled(el));

  // 키워드 순서가 우선순위 (긴/구체적인 키워드를 앞에)
  for (const kw of keywords) {
    const lower = kw.toLowerCase();
    let best = null;
    for (const el of candidates) {
      const text = labelOf(el);
      if (!text || text.length > 25) continue; // 긴 문단은 제외
      const t = text.toLowerCase();
      if (!t.includes(lower)) continue;
      if (/이전|prev/i.test(t)) continue;
      if (!best || text.length < labelOf(best).length) best = el;
    }
    if (best) return best.closest('a, button, [role=button], [onclick]') || best;
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'CLICK_NEXT') {
    const btn = findNextButton();
    if (btn) {
      btn.scrollIntoView({ block: 'center' });
      btn.click();
    }
    sendResponse({ clicked: !!btn, label: btn ? labelOf(btn) : null });
  }
});
