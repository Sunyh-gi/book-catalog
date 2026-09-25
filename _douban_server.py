# -*- coding: utf-8 -*-
""" ============================================================
 * 藏书阁 · 豆瓣本地代理服务
 * ------------------------------------------------------------
 * 用途：让 index.html 页面里的「搜索豆瓣」真正连上豆瓣。
 *       （浏览器直接 fetch 豆瓣会被 CORS 拦截，所以走本地代理）
 *
 * 用法（managed python，PowerShell）：
 *   python _douban_server.py            # 默认端口 8765，仅监听 127.0.0.1
 *   python _douban_server.py 9999       # 指定端口
 *
 * 端点（与云端 Worker 一致，共 5 个）：
 *   GET /health                     -> {"ok": true, "service": "douban-proxy"}
 *   GET /search?q=百年孤独           -> {"candidates": [{id,title,year,author_name,img,...}]}
 *                                       （search.douban.com 全量版本 + suggest 补充）
 *   GET /fetch?id=6082808           -> 豆瓣条目详情 JSON（与 _douban_cache/<id>.json 同结构）
 *   GET /cover?id=6082808           -> 封面图片字节（服务端带 Referer，绕过豆瓣 418）
 *   GET /save_cover?sid=&book_id=   -> 把封面落到 covers/<book_id>.jpg，并回 dataUrl
 *
 * 缓存：条目详情 24h（_douban_cache/<id>.json）、搜索结果 10 分钟（内存）、
 *       封面图落 _douban_cache/covers/<id>.jpg、封面直链记 _douban_cache/_cover_urls.json
 *       （下划线前缀 = 旁路缓存，sweep_cache() 不会当过期详情删）；启动时 sweep_cache() 清过期文件。
 *
 * 页面（index.html）启动时探测 /health；在线则「搜索豆瓣」返回候选版本，
 * 离线回落本地查重 + 手动录入。可带 ?svc=http://127.0.0.1:8765 覆盖服务地址。
 *
 * 零第三方依赖：http.server + urllib（复用 _douban_fetch 的抓取逻辑）。
 * ============================================================ """
import base64, json, re, sys, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from _douban_fetch import (CACHE, ROOT, UA, http_get, load_cover_urls, parse_subject,
                           search_subjects)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

FETCH_TTL = 24 * 3600      # 条目详情缓存 24h
SEARCH_TTL = 600           # 搜索结果内存缓存 10 分钟
_search_cache = {}


def sweep_cache():
    """启动时清一遍过期缓存。

    FETCH_TTL 只在「读取时」判断：过期条目会被当成未命中重新抓，但旧文件从不删除，
    于是 _douban_cache/ 只增不减（详情 JSON + covers/ 里的封面图都没有回收路径）。
    这里按 mtime 扫一遍，过期的直接删；下次要用手再抓一次即可。
    """
    if not CACHE.exists():
        return 0
    now, n = time.time(), 0
    # 下划线开头的是旁路缓存（_cover_urls.json 等），不是详情条目，别当过期详情删掉
    targets = [f for f in CACHE.glob("*.json") if not f.name.startswith("_")]
    cdir = CACHE / "covers"
    if cdir.exists():
        targets += list(cdir.glob("*.jpg"))
    for f in targets:
        try:
            if now - f.stat().st_mtime > FETCH_TTL:
                f.unlink()
                n += 1
        except OSError:
            pass
    return n


def fetch_cached(sid):
    """详情缓存优先（毫秒级命中），过期/缺失才现抓豆瓣并落盘。"""
    sid = str(sid)
    jf = CACHE / ("%s.json" % sid)
    if jf.exists():
        try:
            d = json.loads(jf.read_text(encoding="utf-8"))
            if time.time() - (d.get("fetchedAt") or 0) < FETCH_TTL:
                return d
        except Exception:
            pass
    d = parse_subject(sid)
    d["fetchedAt"] = time.time()
    CACHE.mkdir(exist_ok=True)
    jf.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    return d


def search_cached(q):
    """同一关键词 10 分钟内直接复用内存结果，不重复打豆瓣。"""
    q = q.strip()
    now = time.time()
    hit = _search_cache.get(q)
    if hit and now - hit[0] < SEARCH_TTL:
        return hit[1]
    data = search_subjects(q)
    _search_cache[q] = (now, data)
    return data


def get_bytes(url, referer=None):
    """下载字节（豆瓣封面 CDN 需带 Referer 才不被 418 拒绝）。"""
    hdrs = dict(UA)
    if referer:
        hdrs["Referer"] = referer
    req = urllib.request.Request(url, headers=hdrs)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def cover_bytes(sid):
    """返回 (图片字节, content_type)：优先本地缓存，其次现场抓豆瓣封面。

    封面直链的查找顺序（越靠前越省一次 5s 的条目页抓取）：
    ① 已落盘的封面图 → ② 搜索时顺手记下的直链 → ③ 详情缓存里的 → ④ 现抓条目页
    """
    sid = str(sid)
    cdir = CACHE / "covers"
    cdir.mkdir(parents=True, exist_ok=True)
    f = cdir / (sid + ".jpg")
    if f.exists():
        return f.read_bytes(), "image/jpeg"
    url = load_cover_urls().get(sid) or ""
    if not url:
        jf = CACHE / (sid + ".json")
        if jf.exists():
            try:
                url = json.loads(jf.read_text(encoding="utf-8")).get("coverUrl") or ""
            except Exception:
                url = ""
    if not url:
        url = parse_subject(sid).get("coverUrl") or ""
    if not url:
        raise RuntimeError("no cover for subject %s" % sid)
    body = get_bytes(url, referer="https://book.douban.com/")
    f.write_bytes(body)
    return body, "image/jpeg"


class Handler(BaseHTTPRequestHandler):
    # ---- 工具 ----
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- 请求 ----
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            p = parsed.path
            if p == "/health":
                self._send({"ok": True, "service": "douban-proxy"})
            elif p == "/search":
                q = (qs.get("q") or [""])[0].strip()
                if not q:
                    return self._send({"error": "missing q"}, 400)
                try:
                    self._send({"candidates": search_cached(q)})
                except Exception as e:
                    self._send({"error": "search failed: %s" % e}, 502)
            elif p == "/fetch":
                sid = (qs.get("id") or [""])[0].strip()
                if not sid:
                    return self._send({"error": "missing id"}, 400)
                try:
                    self._send(fetch_cached(sid))
                except Exception as e:
                    self._send({"error": "fetch failed: %s" % e}, 502)
            elif p == "/cover":
                sid = (qs.get("id") or [""])[0].strip()
                if not sid:
                    return self._send({"error": "missing id"}, 400)
                try:
                    body, ctype = cover_bytes(sid)
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except Exception as e:
                    self._send({"error": "cover failed: %s" % e}, 502)
            elif p == "/save_cover":
                # 页面入库/补封面：把豆瓣封面落到 covers/<book_id>.jpg
                sid = (qs.get("sid") or [""])[0].strip()
                book_id = (qs.get("book_id") or [""])[0].strip()
                if not sid or not book_id:
                    return self._send({"error": "missing sid/book_id"}, 400)
                if not re.match(r"^[A-Za-z0-9_\-]+$", book_id):
                    return self._send({"error": "bad book_id"}, 400)
                try:
                    body, _ = cover_bytes(sid)
                    covers = ROOT / "covers"
                    covers.mkdir(exist_ok=True)
                    (covers / (book_id + ".jpg")).write_bytes(body)
                    # dataUrl 与页面来源无关：线上 Pages / 本地 file:// 均可直接显示
                    data_url = "data:image/jpeg;base64," + base64.b64encode(body).decode()
                    self._send({"ok": True, "cover": "covers/%s.jpg" % book_id, "dataUrl": data_url})
                except Exception as e:
                    self._send({"error": "save_cover failed: %s" % e}, 502)
            else:
                self._send({"error": "not found"}, 404)
        except Exception as e:
            self._send({"error": "internal: %s" % e}, 500)

    def log_message(self, fmt, *args):
        sys.stderr.write("[douban-proxy] " + fmt % args + "\n")


if __name__ == "__main__":
    swept = sweep_cache()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("藏书阁 · 豆瓣代理已启动：http://127.0.0.1:%d  （Ctrl+C 停止）" % PORT, flush=True)
    if swept:
        print("已清理 %d 个过期缓存文件（>%dh）" % (swept, FETCH_TTL // 3600), flush=True)
    srv.serve_forever()
