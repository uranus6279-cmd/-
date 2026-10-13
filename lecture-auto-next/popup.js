const DEFAULTS = {
  enabled: true,
  mode: 'button',
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
const $ = (id) => document.getElementById(id);
const CHECKS = ['enabled', 'loop', 'autoPlay', 'autoConfirm'];
const NUMBERS = ['urlStart', 'urlEnd', 'delaySec', 'playbackRate'];

function toggleBoxes() {
  $('buttonBox').classList.toggle('hidden', $('mode').value !== 'button');
  $('urlBox').classList.toggle('hidden', $('mode').value !== 'url');
}

function collect() {
  const s = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (CHECKS.includes(k)) s[k] = $(k).checked;
    else if (NUMBERS.includes(k)) s[k] = Number($(k).value);
    else s[k] = $(k).value.trim();
  }
  return s;
}

function save() {
  chrome.storage.sync.set(collect(), () => {
    $('status').textContent = '저장됨 ✔';
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  for (const [k, v] of Object.entries(s)) {
    if (CHECKS.includes(k)) $(k).checked = v;
    else $(k).value = v;
  }
  toggleBoxes();
});
chrome.storage.local.get('lastStatus', ({ lastStatus }) => {
  if (lastStatus) $('status').textContent = lastStatus;
});

$('mode').addEventListener('change', toggleBoxes);
$('enabled').addEventListener('change', save);
$('save').addEventListener('click', save);
$('setFirst').addEventListener('click', async () => {
  const tab = await activeTab();
  $('firstUrl').value = tab.url;
  save();
});
$('nextNow').addEventListener('click', async () => {
  save();
  const tab = await activeTab();
  chrome.runtime.sendMessage({ type: 'ADVANCE_NOW', tabId: tab.id, tabUrl: tab.url }, () => {
    chrome.storage.local.get('lastStatus', ({ lastStatus }) => {
      $('status').textContent = lastStatus || '';
    });
  });
});
