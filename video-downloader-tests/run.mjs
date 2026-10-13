// 하드 조건 테스트 러너: 실제 크롬을 띄우고 확장을 실사용처럼 조작한다.
// 사용법: ./gen-media.sh 후 `node run.mjs [케이스 이름...]`
//   PLAYWRIGHT=playwright 모듈 경로, CHROME=크롬 실행 파일 경로, HUGE_N=초대용량 조각 수(기본 3000 = 1.5GB)
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT = process.env.EXT || path.join(HERE, '../video-downloader');
const CHROME = process.env.CHROME || chromium.executablePath();
const PORT = 8766;
const O = `http://127.0.0.1:${PORT}`;
const DL = path.join(HERE, 'out/downloads');
const PROF = path.join(HERE, 'out/profile');
const only = process.argv.slice(2);

fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });
fs.rmSync(PROF, { recursive: true, force: true }); fs.mkdirSync(path.join(PROF, 'Default'), { recursive: true });
fs.writeFileSync(path.join(PROF, 'Default/Preferences'),
  JSON.stringify({ download: { default_directory: DL, prompt_for_download: false } }));

// 테스트 서버를 새로 띄운다(케이스별 '첫 요청만 실패' 카운터가 초기화되도록).
const server = spawn('python3', [path.join(HERE, 'server.py'), String(PORT)], { stdio: 'ignore', env: process.env });
process.on('exit', () => server.kill());
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', `--user-data-dir=${PROF}`, '--remote-debugging-port=9333', '--no-first-run',
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required',
  'about:blank'], { stdio: 'ignore', env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = browser.contexts()[0];
// Playwright가 다운로드 이름을 임의로 바꾸지 않도록 크롬 기본 동작으로 되돌린다.
await (await browser.newBrowserCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'default' });
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const getSW = async () => ctx.serviceWorkers().find((w) => w.url().includes(extId)) || ctx.waitForEvent('serviceworker');

const probe = (f) => {
  try {
    const j = JSON.parse(execSync(`ffprobe -v error -show_entries format=duration:stream=codec_type -of json "${f}"`).toString());
    return { dur: Math.round(Number(j.format.duration)), streams: j.streams.map((s) => s.codec_type).sort().join('+') };
  } catch { return { dur: 0, streams: 'unreadable' }; }
};
const sha = (f) => execSync(`sha256sum "${f}"`).toString().split(' ')[0];

async function waitDownloads(n, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const w = await getSW();
    const items = await w.evaluate(() => chrome.downloads.search({})).catch(() => []);
    // 성공 케이스는 '완료'된 파일만 센다(403 뒤 재시도하는 경우 첫 시도는 실패로 남는다).
    const fresh = items.filter((d) => !seen.has(d.id) && d.state === 'complete');
    if (fresh.length >= n) {
      fresh.forEach((d) => seen.add(d.id));
      return fresh;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
const seen = new Set();

async function openPopupFor(tabUrlPrefix) {
  const p = await ctx.newPage();
  await p.addInitScript((u) => { const q = chrome.tabs.query; chrome.tabs.query = () => q({ url: u }); }, tabUrlPrefix);
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.waitForTimeout(500);
  return p;
}

// 각 케이스: 기대 결과(expect)를 실제 결과와 비교한다.
const CASES = [
  ['basic', '기본 m3u8 (31조각)', { dur: 60, streams: 'audio+video' }],
  ['fmp4', 'fMP4 조각 (EXT-X-MAP)', { dur: 60, streams: 'audio+video' }],
  ['crlf', 'Windows 줄바꿈 + BOM 재생목록', { dur: 60, streams: 'audio+video' }],
  ['redirect', '재생목록이 302로 다른 폴더로 이동 (상대 경로)', { dur: 60, streams: 'audio+video' }],
  ['cdn', '조각이 다른 도메인(CDN) + 토큰 쿼리', { dur: 60, streams: 'audio+video' }],
  ['flaky', '불안정한 서버 (500 에러 / 연결 끊김)', { dur: 60, streams: 'audio+video' }],
  ['hang', '조각 하나가 응답 없이 멈춤 (5분)', { dur: 60, streams: 'audio+video' }, 150000],
  ['referer', 'Referer 검사 (핫링크 차단)', { dur: 60, streams: 'audio+video' }],
  ['cookie', '로그인 쿠키 필요', { dur: 60, streams: 'audio+video' }],
  ['byterange', '한 파일을 바이트 범위로 쪼갠 재생목록', { dur: 60, streams: 'audio+video' }],
  ['alt', '영상/음성이 분리된 재생목록 (EXT-X-MEDIA)', { split: true }],
  ['disguised', '위장: text/plain 재생목록 + .jpg 조각', { dur: 60, streams: 'audio+video' }],
  ['aes', 'AES-128 암호화 → 거부 메시지가 나와야 정상', { error: /암호화/ }],
  ['live', '라이브 방송 → 거부 메시지가 나와야 정상', { error: /라이브/ }],
  ['title', '이모지/특수문자/300자 제목', { dur: 60, streams: 'audio+video', name: true }],
  ['big', '대용량 300MB (600조각)', { hash: execSync(`python3 ${HERE}/server.py 0 bighash`).toString().trim() }, 240000],
  ['prog', '일반 mp4: 확장자 없음 + octet-stream + 64KB 분할 전송', { dur: 60, streams: 'audio+video', direct: true }],
  ['iframe', '다른 도메인 iframe 안의 영상', { dur: 60, streams: 'audio+video', direct: true, prefix: '/c/prog/' }],
  ['progref', '일반 mp4: 핫링크 차단 (Referer 검사)', { dur: 60, streams: 'audio+video', direct: true, prefix: '/c/progref/' }],
  ['gone', '실패 원인 표시: 중간 조각 만료(404)', { failReason: /404/ }],
  ['once', '실패 원인 표시: 직접 다운로드 거부(403)', { failReason: /403/, direct: true, prefix: '/c/once/' }],
  ['pngwrap', '조각 앞에 가짜 PNG 머리 붙인 위장', { dur: 60, streams: 'audio+video' }],
  ['authheader', '한계 확인: 플레이어가 JS로 인증 헤더 추가 → 원인 표시', { failReason: /403/ }],
  ['huge', `초대용량 ${process.env.HUGE_N || 3000}조각`, { hash: execSync(`HUGE_N=${process.env.HUGE_N || 3000} python3 ${HERE}/server.py 0 hugehash`).toString().trim() }, 600000],
  ['player', '플레이어가 조각 31개를 모두 받아도 목록은 m3u8 하나', { listCount: 1 }],
  ['swkill', '서비스 워커 강제 종료 후에도 목록 유지', { survive: true }],
];

const results = [];
for (const [id, desc, exp, timeout = 60000] of CASES) {
  if (only.length && !only.includes(id)) continue;
  const t0 = Date.now();
  let r = { id, desc, ok: false, note: '' };
  try {
    const page = await ctx.newPage();
    await page.goto(`${O}/page/${id === 'swkill' ? 'basic' : id}.html`);
    await page.waitForTimeout(2500);
    if (id === 'swkill') {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('ServiceWorker.enable');
      await cdp.send('ServiceWorker.stopAllWorkers');
      await page.waitForTimeout(1000);
    }
    const popup = await openPopupFor(`${O}/page/${id === 'swkill' ? 'basic' : id}.html`);
    const rows = await popup.$$eval('#list li', (lis) => lis.map((li) => li.querySelector('.url').textContent));
    r.detected = rows.length;
    if (exp.listCount) {
      r.ok = rows.length === exp.listCount; r.note = `목록 ${rows.length}개: ${rows.map((u) => u.split('/').pop()).join(', ')}`;
    } else if (exp.survive) {
      r.ok = rows.length > 0; r.note = `종료 후 목록 ${rows.length}개`;
    } else {
      const want = exp.direct ? (exp.prefix || '/c/prog/') : '';
      let idx = rows.findIndex((u) => (want ? u.includes(want) : /m3u8|api\/play/.test(u)));
      if (idx < 0) throw new Error(`감지 실패 (목록: ${rows.length}개 ${rows.map((u) => u.slice(-30)).join(', ')})`);
      const btn = (await popup.$$('#list li'))[idx];
      if (exp.direct) {
        await (await btn.$('button')).click();
      } else {
        const hlsP = ctx.waitForEvent('page');
        await (await btn.$('button')).click();
        const hls = await hlsP;
        await hls.waitForLoadState();
        await hls.waitForFunction(() => /실패|완료|화질/.test(document.getElementById('log').textContent), null, { timeout });
        if (await hls.isVisible('#start')) await hls.click('#start');
        if (exp.error || exp.failReason) {
          await hls.waitForFunction(() => /실패|완료/.test(document.getElementById('log').textContent), null, { timeout: timeout });
          const log = await hls.textContent('#log');
          r.ok = (exp.error || exp.failReason).test(log); r.note = log.trim().slice(0, 60);
        } else {
          await hls.waitForFunction(() => /실패|완료/.test(document.getElementById('log').textContent), null, { timeout });
          const log = await hls.textContent('#log');
          r.hlslog = log.trim();
          if (/실패/.test(log)) throw new Error(log.trim().slice(0, 120));
        }
      }
      if (exp.failReason) {
        // 팝업을 다시 열어 실패 원인이 보이는지 확인한다.
        await new Promise((res) => setTimeout(res, 1500));
        const p2 = await openPopupFor(`${O}/page/${id}.html`);
        const txt = await p2.$$eval('.state.failed', (els) => els.map((e) => e.textContent).join(' | '));
        r.ok = exp.failReason.test(txt);
        r.note = `팝업 표시: ${txt || '(없음)'}`;
      } else if (exp.split) {
        const files = await waitDownloads(2, timeout);
        if (!files) {
          const all = await (await getSW()).evaluate(() => chrome.downloads.search({}));
          throw new Error('다운로드가 끝나지 않음: [' + r.hlslog.slice(0, 80) + '] ' + JSON.stringify(all.filter((d) => !seen.has(d.id)).map((d) => [d.filename.split('/').pop(), d.state, d.error])));
        }
        const ps = files.map((f) => probe(f.filename));
        r.file = files.map((f) => path.basename(f.filename)).join(' + ');
        r.ok = ps.map((x) => x.streams).sort().join(',') === 'audio,video' && ps.every((x) => x.dur === 60);
        r.note = '두 파일로 저장: ' + ps.map((x) => `${x.streams} ${x.dur}초`).join(', ');
      } else if (!exp.error) {
        const files = await waitDownloads(1, timeout);
        if (!files) throw new Error('다운로드가 끝나지 않음');
        const f = files[0];
        r.file = path.basename(f.filename);
        if (exp.hash) {
          r.ok = sha(f.filename) === exp.hash; r.note = `${(f.fileSize / 1048576).toFixed(0)}MB, 해시 ${r.ok ? '일치' : '불일치'}`;
        } else {
          const p = probe(f.filename);
          await new Promise((res) => setTimeout(res, 800));
          const p2 = await openPopupFor(`${O}/page/${id}.html`);
          r.popup = await p2.$$eval('.state', (els) => els.map((e) => e.textContent).filter(Boolean).join(' | '));
          r.ok = p.dur === exp.dur && p.streams === exp.streams;
          // 같은 조각을 여러 번 받는 실수는 길이로는 안 보이므로 용량도 확인한다 (원본 ts ≈ 2.1MB).
          const mb = f.fileSize / 1048576;
          r.ok = r.ok && mb < 4;
          r.ok = r.ok && /완료/.test(r.popup) && /\.(ts|mp4|m4a)$/.test(r.file);
          r.note = `${p.dur}초, ${p.streams}, ${mb.toFixed(1)}MB, 팝업: ${r.popup.slice(0, 30) || '(없음)'}`;
          if (exp.name) {
            const bad = /[\/\\:*?"<>|]/.test(r.file);
            r.ok = r.ok && !bad; r.note += `, 파일명 ${Buffer.byteLength(r.file)}바이트`;
          }
        }
      }
    }
    for (const pg of ctx.pages()) if (pg.url() !== 'about:blank') await pg.close().catch(() => {});
  } catch (e) {
    r.note = e.message.split('\n')[0].slice(0, 140);
    for (const pg of ctx.pages()) if (pg.url() !== 'about:blank') await pg.close().catch(() => {});
  }
  r.sec = ((Date.now() - t0) / 1000).toFixed(1);
  results.push(r);
  console.log(`${r.ok ? '✅' : '❌'} ${id.padEnd(10)} ${r.sec.padStart(6)}s  ${desc} — ${r.note}${r.file ? ` [${r.file.slice(0, 40)}]` : ''}`);
}
fs.writeFileSync(path.join(HERE, 'out/results.json'), JSON.stringify(results, null, 1));
console.log(`\n통과 ${results.filter((r) => r.ok).length} / ${results.length}`);
await browser.close().catch(() => {});
chrome.kill();
server.kill();
