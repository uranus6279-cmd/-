# 실제 사이트의 까다로운 동작을 흉내 내는 테스트 서버.
import hashlib, os, re, sys, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
M = os.path.join(os.path.dirname(os.path.abspath(__file__)), "m")
ORIGIN = f"http://127.0.0.1:{PORT}"
counts = {}
lock = threading.Lock()

def hit(key):
    with lock:
        counts[key] = counts.get(key, 0) + 1
        return counts[key]

def read(p):
    with open(os.path.join(M, p), "rb") as f:
        return f.read()

BIG_N, BIG_SZ = 600, 512 * 1024
def big_seg(i):
    return hashlib.sha256(str(i).encode()).digest() * (BIG_SZ // 32)

PAGE = """<!doctype html><meta charset=utf-8><title>{title}</title>
<h1>{case}</h1>{body}
<script>const ALL = {all};
// 플레이어 흉내: 재생목록과 첫 조각을 받아온다.
(async () => {{ const u = {pl!r}; if (!u) return;
  const t = await (await fetch(u, {{credentials:'include'}})).text();
  const base = new URL(u, location.href);
  const segs = t.split(/\\r?\\n/).filter(l => l && !l.startsWith('#'));
  for (const sgm of (ALL ? segs : segs.slice(0, 1))) await fetch(new URL(sgm, base), {{credentials:'include', headers: {hdr}}});
}})();
</script>"""

CASES = {
    "basic": "/c/basic/index.m3u8",
    "fmp4": "/c/fmp4/index.m3u8",
    "referer": "/c/referer/index.m3u8",
    "cookie": "/c/cookie/index.m3u8",
    "flaky": "/c/flaky/index.m3u8",
    "hang": "/c/hang/index.m3u8",
    "redirect": "/c/redirect/index.m3u8",
    "byterange": "/c/byterange/index.m3u8",
    "alt": "/c/alt/master.m3u8",
    "aes": "/c/aes/index.m3u8",
    "live": "/c/live/index.m3u8",
    "disguised": "/c/disguised/api/play?id=7",
    "cdn": "/c/cdn/index.m3u8",
    "big": "/c/big/index.m3u8",
    "crlf": "/c/crlf/index.m3u8",
    "title": "/c/basic/index.m3u8",
    "gone": "/c/gone/index.m3u8",
    "pngwrap": "/c/pngwrap/index.m3u8",
    "authheader": "/c/authheader/index.m3u8",
    "huge": "/c/huge/index.m3u8",
    "player": "/c/basic/index.m3u8",
}
HUGE_N = int(os.environ.get("HUGE_N", "3000"))
FAKE_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + bytes(range(97))

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass

    def send(self, code, body=b"", ctype="text/plain", headers=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin") or "*")
        self.send_header("Access-Control-Allow-Credentials", "true")
        for k, v in headers: self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)

    def send_ranged(self, data, ctype):
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d+)-(\d*)", rng or "")
        if not m:
            return self.send(200, data, ctype, [("Accept-Ranges", "bytes")])
        a = int(m[1]); b = int(m[2]) if m[2] else len(data) - 1
        b = min(b, len(data) - 1, a + 64 * 1024 - 1)  # 일부러 64KB씩만 준다
        self.send(206, data[a:b + 1], ctype, [("Accept-Ranges", "bytes"),
                  ("Content-Range", f"bytes {a}-{b}/{len(data)}")])

    def do_HEAD(self): self.do_GET()

    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query); p = u.path
        if p.startswith("/page/"):
            case = p[6:].replace(".html", "")
            title = f"{case} 테스트"
            body = ""
            hdrs = []
            if case == "cookie":
                hdrs.append(("Set-Cookie", "sess=ok; Path=/; SameSite=Lax; HttpOnly"))
            if case == "title":
                title = "🎬 영상/제목: 특수*문자?|\"테스트\" <긴 제목> " + "가나다" * 100
            if case in ("prog", "progref", "once"):
                body = f'<video src="/c/{case}/stream?id=1" muted autoplay></video>'
            if case == "iframe":
                body = f'<iframe src="http://localhost:{PORT}/page/prog.html" width=400 height=300></iframe>'
            hdr = '{"X-Auth": "secret"}' if case == "authheader" else "{}"
            html = PAGE.format(title=title, case=case, body=body, pl=CASES.get(case, ""), hdr=hdr, all="true" if case == "player" else "false")
            return self.send(200, html.encode(), "text/html; charset=utf-8", hdrs)

        m = re.match(r"/c/([^/]+)/(.*)", p)
        if not m: return self.send(404)
        case, rest = m[1], m[2]

        if case == "gone" and rest == "index10.ts":
            return self.send(404, b"expired")
        if case in ("basic", "flaky", "hang", "crlf", "referer", "cookie", "gone"):
            if case == "referer" and not (self.headers.get("Referer") or "").startswith(ORIGIN + "/page/"):
                return self.send(403, b"bad referer")
            if case == "cookie" and "sess=ok" not in (self.headers.get("Cookie") or ""):
                return self.send(403, b"no cookie")
            if rest.endswith(".ts"):
                if case == "flaky":
                    n = hit(case + rest)
                    if n == 1 and int(re.sub(r"\D", "", rest) or 0) % 3 == 0:
                        return self.send(500, b"oops")
                    if n == 1 and int(re.sub(r"\D", "", rest) or 0) % 3 == 1:
                        self.wfile.write(b"HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\npartial")
                        self.close_connection = True
                        return
                if case == "hang" and rest == "index5.ts" and hit(case + rest) == 1:
                    time.sleep(300)
                return self.send(200, read("ts/" + rest), "video/mp2t")
            pl = read("ts/index.m3u8")
            if case == "crlf":
                pl = b"\xef\xbb\xbf" + pl.replace(b"\n", b"\r\n")
            return self.send(200, pl, "application/vnd.apple.mpegurl")

        if case in ("fmp4", "byterange", "alt", "aes"):
            d = {"fmp4": "fmp4", "byterange": "br", "alt": "alt", "aes": "aes"}[case]
            data = read(f"{d}/{rest}")
            ctype = "application/vnd.apple.mpegurl" if rest.endswith(".m3u8") else "video/mp2t"
            if case == "byterange" and rest.endswith(".ts"):
                rng = re.match(r"bytes=(\d+)-(\d+)", self.headers.get("Range") or "")
                if rng:
                    a, b = int(rng[1]), int(rng[2])
                    return self.send(206, data[a:b + 1], ctype,
                                     [("Content-Range", f"bytes {a}-{b}/{len(data)}")])
            return self.send(200, data, ctype)

        if case == "redirect":
            if rest == "index.m3u8":
                return self.send(302, b"", headers=[("Location", "/c/redirect/real/deep/index.m3u8")])
            if rest.startswith("real/deep/"):
                f = rest[len("real/deep/"):]
                return self.send(200, read("ts/" + f),
                                 "application/vnd.apple.mpegurl" if f.endswith("m3u8") else "video/mp2t")
            return self.send(404, b"wrong base: " + rest.encode())

        if case == "live":
            lines = read("ts/index.m3u8").decode().splitlines()
            lines = [l for l in lines if "ENDLIST" not in l and "PLAYLIST-TYPE" not in l]
            return self.send(200, "\n".join(lines[:16]).encode(), "application/vnd.apple.mpegurl")

        if case == "disguised":
            if rest.startswith("api/play"):
                pl = read("ts/index.m3u8").decode()
                pl = re.sub(r"index(\d+)\.ts", r"/c/disguised/img/\1.jpg", pl)
                return self.send(200, pl.encode(), "text/plain")
            mm = re.match(r"img/(\d+)\.jpg", rest)
            return self.send(200, read(f"ts/index{mm[1]}.ts"), "image/jpeg")

        if case == "cdn":
            if rest == "index.m3u8":
                pl = read("ts/index.m3u8").decode()
                pl = re.sub(r"index(\d+)\.ts",
                            rf"http://localhost:{PORT}/c/cdn/seg/index\1.ts?token=abc123&exp=9999999999", pl)
                return self.send(200, pl.encode(), "application/vnd.apple.mpegurl")
            if q.get("token") != ["abc123"]:
                return self.send(403, b"token")
            return self.send(200, read("ts/" + rest[4:]), "video/mp2t")

        if case == "pngwrap":
            if rest == "index.m3u8":
                pl = re.sub(r"index(\d+)\.ts", r"img/\1.png", read("ts/index.m3u8").decode())
                return self.send(200, pl.encode(), "application/vnd.apple.mpegurl")
            mm = re.match(r"img/(\d+)\.png", rest)
            return self.send(200, FAKE_PNG + read(f"ts/index{mm[1]}.ts"), "image/png")

        if case == "authheader":
            if rest.endswith(".ts") and self.headers.get("X-Auth") != "secret":
                return self.send(403, b"need X-Auth")
            if rest.endswith(".ts"):
                return self.send(200, read("ts/" + rest), "video/mp2t")
            return self.send(200, read("ts/index.m3u8"), "application/vnd.apple.mpegurl")

        if case == "huge":
            if rest == "index.m3u8":
                pl = ["#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXT-X-PLAYLIST-TYPE:VOD"]
                for i in range(HUGE_N): pl += ["#EXTINF:2.0,", f"s{i}.ts"]
                pl.append("#EXT-X-ENDLIST")
                return self.send(200, "\n".join(pl).encode(), "application/vnd.apple.mpegurl")
            return self.send(200, big_seg(int(rest[1:-3])), "video/mp2t")

        if case == "big":
            if rest == "index.m3u8":
                pl = ["#EXTM3U", "#EXT-X-TARGETDURATION:2", "#EXT-X-PLAYLIST-TYPE:VOD"]
                for i in range(BIG_N): pl += ["#EXTINF:2.0,", f"s{i}.ts"]
                pl.append("#EXT-X-ENDLIST")
                return self.send(200, "\n".join(pl).encode(), "application/vnd.apple.mpegurl")
            return self.send(200, big_seg(int(rest[1:-3])), "video/mp2t")

        if case == "prog":
            return self.send_ranged(read("src.mp4"), "application/octet-stream")
        if case == "progref":
            # 핫링크 차단: 영상 페이지에서 온 요청만 허용
            if not (self.headers.get("Referer") or "").startswith(ORIGIN + "/page/progref"):
                return self.send(403, b"hotlink")
            return self.send_ranged(read("src.mp4"), "video/mp4")
        if case == "once":
            # 플레이어(Range 요청)만 허용하고 통째로 받으려는 요청은 거부
            if not self.headers.get("Range"):
                return self.send(403, b"no direct download")
            return self.send_ranged(read("src.mp4"), "video/mp4")

        self.send(404)

if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[2] in ("bighash", "hugehash"):
        h = hashlib.sha256()
        for i in range(BIG_N if sys.argv[2] == "bighash" else HUGE_N): h.update(big_seg(i))
        print(h.hexdigest()); sys.exit()
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
