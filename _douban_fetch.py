# -*- coding: utf-8 -*-
""" ============================================================
 * 藏书阁 · 豆瓣对接脚本
 * ------------------------------------------------------------
 * 用法（managed python，PowerShell）：
 *   python _douban_fetch.py search 百年孤独
 *   python _douban_fetch.py fetch 1084336
 *   python _douban_fetch.py merge 1084336 --into b-1001
 *   python _douban_fetch.py merge 1084336 --new --book-id b-1011 --genre 文学小说
 *
 * 说明：
 *   search  按书名/ISBN 搜豆瓣，列候选（同名不同版本一并列出，不止最匹配的一条）
 *   fetch   抓单个条目详情，解析为 JSON（打印并存 _douban_cache/<id>.json）
 *   merge   把抓到的字段写回 data/books.js（写前自动备份 _backup_books_*.js）
 *           --into <书库id>  更新已有条目（保留 genre/status/addedAt）
 *           --new            追加新书（默认 status=pending）
 *
 * 零第三方依赖：urllib + re（并行取数只用标准库 concurrent.futures）。抓取频率低，带浏览器 UA。
 * ============================================================ """
import argparse, hashlib, html as H, http.cookiejar, json, pathlib, re, shutil, sys
import threading, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Accept-Language": "zh-CN,zh;q=0.9",
}
ROOT = pathlib.Path(__file__).resolve().parent
BOOKS_JS = ROOT / "data" / "books.js"
CACHE = ROOT / "_douban_cache"
LABELS = ["作者", "译者", "编者", "出版社", "出品方", "副标题", "原作名",
          "出版年", "页数", "定价", "装帧", "丛书", "ISBN", "统一书号"]
# 详情解析的「结构版本」。改了 parse_subject 的解析口径就 +1：
# _douban_cache/<id>.json 有 24h TTL，旧文件里 subtitle 是按老口径解析的（恒为 None），
# 不主动失效的话，改完代码 24h 内读到的还是旧结果，看起来像「修了没用」。
PARSE_VERSION = 2


# ---------------- 反爬验证（sec.douban.com 的 PoW 页） ----------------
# search.douban.com 聚合页会对本机出口回一个 3KB 的「点我继续浏览」页：
# 表单里带 tok/cha，要求算出 nonce 使 sha512(cha + nonce) 的前 4 个十六进制位为 0，
# POST 回 /c 换 dbsawcv1 cookie。不过这一关，聚合页永远拿不到 window.__DATA__ ——
# search_douban_page 静默返回 0 条，搜索整体退化成 suggest（只有 1 条、没有副标题、
# 同名版本全丢），页面表现就是「详情卡没有副标题」「波斯札记只显示 1 个版本」。
# 全程 0.03s 即可解出，且 cookie 存进 jar 后所有请求都不再被拦。
_COOKIES = http.cookiejar.CookieJar()
_OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_COOKIES))
_SEC_LOCK = threading.Lock()
_SEC_FORM_RE = re.compile(r'<form[^>]*action="([^"]*)"[^>]*>(.*?)</form>', re.S | re.I)
_SEC_FIELD_RE = re.compile(r'name="(tok|cha|sol|red)"[^>]*value="([^"]*)"', re.I)
SEC_DIFFICULTY = 4


def is_sec_page(text):
    """是否是 sec.douban.com 的「点我继续浏览」验证页。"""
    return "点我继续浏览" in text or ('name="cha"' in text and 'id="sec"' in text)


def solve_sec(cha, difficulty=SEC_DIFFICULTY):
    """找 nonce 使 sha512(cha + nonce) 前 difficulty 位为 0（对应页面里的 process()）。"""
    target = "0" * difficulty
    nonce = 0
    while True:
        nonce += 1
        if hashlib.sha512((cha + str(nonce)).encode()).hexdigest()[:difficulty] == target:
            return nonce


def pass_sec_challenge(text, base_url):
    """命中验证页则解 PoW 并 POST 回 /c，cookie 落进 _COOKIES；成功返回 True。"""
    m = _SEC_FORM_RE.search(text)
    if not m:
        return False
    fields = dict(_SEC_FIELD_RE.findall(m.group(2)))
    if "cha" not in fields or "tok" not in fields:
        return False
    fields["sol"] = str(solve_sec(fields["cha"]))
    action = urllib.parse.urljoin(base_url, m.group(1))
    body = urllib.parse.urlencode(fields).encode()
    # 并行搜索时两个线程可能同时撞上验证页，串行化避免重复解/互相覆盖 cookie
    with _SEC_LOCK:
        req = urllib.request.Request(action, data=body, headers=dict(
            UA, **{"Content-Type": "application/x-www-form-urlencoded", "Referer": base_url}))
        with _OPENER.open(req, timeout=20) as r:
            r.read()
    return True


def http_get(url, tries=2):
    last = None
    for i in range(tries):
        try:
            with _OPENER.open(urllib.request.Request(url, headers=UA), timeout=15) as r:
                text = r.read().decode("utf-8", "ignore")
                final = r.url
            if "有异常请求" in text:
                raise RuntimeError("豆瓣反爬拦截（异常请求页）")
            if is_sec_page(text) and pass_sec_challenge(text, final):
                with _OPENER.open(urllib.request.Request(url, headers=UA), timeout=15) as r2:
                    text = r2.read().decode("utf-8", "ignore")
            return text
        except Exception as e:
            last = e
            if i < tries - 1:
                time.sleep(2)
    raise RuntimeError("请求失败 %s :: %s" % (url, last))


# 豆瓣图床的镜像域名：img1/img2/img3 是同一套内容（实测同路径同图），img4/img5 不解析；
# img9 会对本机出口返回 HTTP 200 + text/html 的 JS 风控挑战页（EO_Bot_Ssid）而不是图片
IMG_MIRRORS = ("img1.doubanio.com", "img2.doubanio.com", "img3.doubanio.com")
_IMG_HOST_RE = re.compile(r"//img\d+\.doubanio\.com(?=/)")


def fetch_image(url, referer="https://book.douban.com/"):
    """下载图片，返回 (body, content_type)。

    ⚠ 豆瓣部分图床域名（实测 img9）会对本机出口返回 **HTTP 200 + text/html** 的
    JS 风控挑战页（EO_Bot_Ssid），**状态码正常但根本不是图片**——所以必须校验
    Content-Type：只看状态码会把 987 字节的 HTML 当封面存下来（页面上就是空白）。
    命中风控时换到镜像域名（img1/2/3）重试即可拿到真图；
    换 UA、补 Sec-Fetch-* 等浏览器头都无效（UA 换成 Chrome/140 反而 418）。
    """
    cands = [url]
    if _IMG_HOST_RE.search(url):
        cands += [_IMG_HOST_RE.sub("//" + h, url, count=1) for h in IMG_MIRRORS]
    last = None
    for u in cands:
        try:
            hdrs = dict(UA)
            if referer:
                hdrs["Referer"] = referer
            with urllib.request.urlopen(urllib.request.Request(u, headers=hdrs), timeout=30) as r:
                body, ctype = r.read(), (r.headers.get("Content-Type") or "")
        except Exception as e:
            last = e
            continue
        if ctype.startswith("image/"):
            return body, ctype.split(";")[0].strip()
        last = RuntimeError("非图片响应（Content-Type: %s，%d 字节）" % (ctype or "空", len(body)))
    raise RuntimeError("封面下载失败 %s :: %s" % (url, last))


def strip_tags(s):
    return H.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def parse_info(block):
    """豆瓣 #info 块 → {字段: 值}；无标签的续行并入上一字段（多作者等）。"""
    text = re.sub(r"<br\s*/?>", "\n", block)
    lines = [l.strip() for l in strip_tags(text).split("\n") if l.strip()]
    fields, cur = {}, None
    pat = re.compile(r"^(?:<b>)?(?:" + "|".join(LABELS) + r")\s*[:：]\s*(.*)$")
    for line in lines:
        m = re.match(r"^(?:" + "|".join(LABELS) + r")\s*[:：]\s*(.*)$", line)
        if m:
            # ⚠ 豆瓣「丛书:</span>&nbsp;<a>值</a>」同行结构：冒号与值之间夹 &nbsp;(\xa0)，
            #   必须先 rstrip() 清掉所有 Unicode 空白再去冒号，否则 key 会变成 "丛书:\xa0"
            label = m.group(0)[: len(m.group(0)) - len(m.group(1))].rstrip().rstrip(" :：")
            cur = label
            fields[cur] = m.group(1).strip()
        elif cur:
            fields[cur] = (fields[cur] + " / " + line).strip(" /")
    return fields


def parse_subject(sid):
    sid = str(sid).strip().rstrip("/")
    if "/" in sid:
        sid = sid.rstrip("/").rsplit("/", 1)[-1]
    url = "https://book.douban.com/subject/%s/" % sid
    html = http_get(url)

    def rx(p):
        m = re.search(p, html, re.S)
        return H.unescape(m.group(1)).strip() if m else ""

    title = rx(r'<span property="v:itemreviewed">(.*?)</span>')
    # ⚠ 必须确认是「真条目页」才敢继续：sec 风控页/异常页里既没有 v:itemreviewed 也没有
    #   v:subtitle，放过去就会被解析成「这本书没有副标题」，把 None 写进库再也补不回来。
    if not title:
        raise RuntimeError("详情页解析失败（非豆瓣条目页）：%s" % url)
    m = re.search(r'<div id="info">(.*?)</div>', html, re.S)
    f = parse_info(m.group(1)) if m else {}

    cov = re.search(r'<img src="(https://img\d\.doubanio\.com/view/subject/[^"]+)"', html)
    pub = f.get("出版年", "")
    mm = re.match(r"(\d{4})-(\d{1,2})", pub)
    pub_date = ("%s-%02d" % (mm.group(1), int(mm.group(2)))) if mm else (pub or None)
    pages_m = re.match(r"(\d+)", f.get("页数", ""))

    return {
        "id": str(sid),
        "v": PARSE_VERSION,
        "url": url,
        "title": title,
        # 副标题有两个来源：#info 里的「副标题:」行（罕见，实测多本书都没有）与页头
        # <h2 class="subtitle"><span property="v:subtitle">…</span></h2>（常态）。
        # ⚠ 后者才是主源——只认 #info 那一行等于永远拿不到副标题，而副标题又是搜索侧
        #   唯一给不出的字段（搜索被限流时标题就只剩书名）。别再退回只读 #info。
        "subtitle": (f.get("副标题")
                     or rx(r'<h2 class="subtitle">\s*<span property="v:subtitle">(.*?)</span>')
                     or None),
        "author": f.get("作者") or "",
        "translator": f.get("译者") or "",
        "publisher": f.get("出版社") or "",
        "pubDate": pub_date,
        "year": int(mm.group(1)) if mm else None,
        "pages": int(pages_m.group(1)) if pages_m else None,
        "binding": f.get("装帧") or None,
        "price": f.get("定价") or None,
        "series": f.get("丛书") or None,
        "isbn": f.get("ISBN") or "",
        "coverUrl": cov.group(1) if cov else None,
    }


COVER_URLS = CACHE / "_cover_urls.json"


def load_cover_urls():
    """读 sid -> 封面直链的旁路缓存（文件缺失/损坏都当空表）。"""
    try:
        d = json.loads(COVER_URLS.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def remember_cover_urls(items):
    """搜索时豆瓣已把封面直链一并返回，记下来。

    否则页面为 15 个候选各请求一次 /cover，而每个 /cover 都要现抓一遍条目页
    （实测 5s）——15 条就是十几秒的封面等待。记下后 /cover 只剩「下图片」。
    写盘失败不影响搜索，静默跳过即可。
    """
    m, n = load_cover_urls(), 0
    for it in items:
        sid, url = str(it.get("id") or "").strip(), (it.get("img") or "").strip()
        if sid and url and m.get(sid) != url:
            m[sid] = url
            n += 1
    if n:
        try:
            CACHE.mkdir(exist_ok=True)
            COVER_URLS.write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass
    return n


def _json_object_at(text, start):
    """从 text[start]（'{'）起做括号配平，返回一个完整 JSON 对象文本。"""
    depth, instr, esc = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if instr:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                instr = False
        elif ch == '"':
            instr = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


# ---------------- 搜索限流（__DATA__.error_info） ----------------
# 除 PoW 验证页外，豆瓣还有一种「软拦截」：HTTP 200、页面结构正常、window.__DATA__ 也在，
# 但内容变成 {"total": 0, "error_info": "搜索访问太频繁。", "items": []}。
# 它既不是异常页也不是验证页，既有检查全放它过去 → search_douban_page 静默返回 0 条
# → 搜索降级到 subject_suggest（只给最匹配 1 条）。
# ⚠ 不做退避重试：实测本机与云端都是**持续性**限流（连测多个关键词全中），退避只会把
#   响应从 ~5s 拖到 12~22s 还照样失败。识别出来立刻返回，由页面提示用户稍后重搜。
#   副标题已改从条目详情页 v:subtitle 取（详情页不受搜索限流影响），所以限流现在只影响
#   「候选版本全不全」，跟副标题无关了。


class DoubanRateLimited(RuntimeError):
    """豆瓣搜索被限流（__DATA__.error_info 非空）。

    单独一个异常类型，是为了区分「被限流」和「真的没结果」：这一轮不能进搜索缓存，
    页面也要显式提示候选不全，否则用户会把降级结果当成「豆瓣上只有这一版」。
    """


def _search_page_json(url):
    """抓聚合页并解出 window.__DATA__ 的 dict；拿不到（结构变了/被拦）返回 None。"""
    m = re.search(r"window\.__DATA__\s*=\s*(\{.*)", http_get(url), re.S)
    if not m:
        return None
    raw = _json_object_at(m.group(1), 0)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _page_candidates(data):
    """__DATA__ → 候选列表。"""
    out = []
    for it in (data.get("items") or []):
        sid = str(it.get("id") or "").strip()
        if not sid:
            continue
        # abstract 形如「作者 / 译者 / 出版社 / 出版年 / 定价」，逐段找 4 位年份最稳
        parts = [p.strip() for p in (it.get("abstract") or "").split("/")]
        year = ""
        for p in parts:
            mm = re.match(r"(\d{4})", p)
            if mm:
                year = mm.group(1)
                break
        out.append({
            "id": sid,
            "title": it.get("title") or "",
            "year": year,
            "author_name": parts[0] if parts else "",
            "abstract": it.get("abstract") or "",
            "img": it.get("cover_url") or "",
            "url": it.get("url") or ("https://book.douban.com/subject/%s/" % sid),
        })
    return out


def search_douban_page(q):
    """search.douban.com 聚合搜索页 → 候选列表（含同名不同版本的全量）。

    豆瓣的 subject_suggest 只给「最匹配的一条」（搜「波斯札记」只回 2023 版，
    漏掉 2014 版），而这个页面的 window.__DATA__.items 是完整结果集。

    ⚠ 命中限流（error_info 非空）抛 DoubanRateLimited —— 别把「被限流」当成「没结果」，
    那样会静默录进没副标题的书。
    """
    url = ("https://search.douban.com/book/subject_search?search_text=%s&cat=1001"
           % urllib.parse.quote(q))
    data = _search_page_json(url)
    if data is None:
        return []
    info = str(data.get("error_info") or "").strip()
    if info:
        raise DoubanRateLimited("豆瓣搜索限流：%s" % info)
    return _page_candidates(data)


def suggest_books(q):
    """subject_suggest（输入联想）→ 只取书籍条目。"""
    s = json.loads(http_get("https://book.douban.com/j/subject_suggest?q=" + urllib.parse.quote(q)))
    if not isinstance(s, list):
        return []
    # type == "b" 才是书（同接口也回电影/音乐），无 type 字段时保留
    return [x for x in s if not x.get("type") or x.get("type") == "b"]


def search_subjects(q, limit=15, status=None):
    """搜豆瓣书籍候选，合并三个入口并去重（顺序即相关度：聚合页在前）。

    ① search.douban.com 聚合页：唯一能一次拿到全部同名版本
    ② subject_suggest：补新书/冷门条目（聚合页偶尔漏，且自带干净的作者/年份）
    ③ www 聚合页：前两者都空时只抽 sid 兜底

    ⚠ ①②**必须并行**：豆瓣单请求就要 5s 上下（服务端慢，不是传输量），
    串行会把一次搜索拖到 10s。并行的代价是对豆瓣多一个并发请求，可接受。

    status：可选 dict，回填 {"limited": bool, "reason": str}。被限流时聚合页缺席、
    只剩 suggest 的降级候选（缺副标题），调用方**必须**据此放弃写入与缓存——
    否则会把「被限流」误当「豆瓣上确实没有副标题」。
    """
    q = q.strip()
    out, seen = [], set()
    limited, reason = False, ""

    def add(items):
        for it in items:
            sid = str(it.get("id") or "").strip()
            if not sid or sid in seen:
                continue
            seen.add(sid)
            out.append(it)

    with ThreadPoolExecutor(max_workers=2) as ex:
        f_page, f_sugg = ex.submit(search_douban_page, q), ex.submit(suggest_books, q)
        for f in (f_page, f_sugg):
            try:
                add(f.result())
            except DoubanRateLimited as e:
                limited, reason = True, str(e)
            except Exception:
                pass
    if not out:
        try:
            html = http_get("https://www.douban.com/search?cat=1001&q=" + urllib.parse.quote(q))
            ids = []
            for m in re.finditer(r'sid:\s*(\d+)', html):
                if m.group(1) not in ids:
                    ids.append(m.group(1))
            add([{"id": i, "title": "", "year": "", "author_name": ""} for i in ids])
        except Exception:
            pass
    out = out[:limit]
    remember_cover_urls(out)
    if status is not None:
        status["limited"] = limited
        status["reason"] = reason
    return out


def cmd_search(q):
    data = search_subjects(q)
    print("豆瓣候选（%d）：" % len(data))
    for i, it in enumerate(data, 1):
        print("  [%d] %s %s  id=%s" % (i, it.get("title", ""), it.get("year", "") or "", it.get("id", "")))
        if it.get("author_name"):
            print("        作者: %s" % it["author_name"])
    if not data:
        print("  （无结果）")


def q(s):
    return json.dumps(s, ensure_ascii=False)


def find_entry_span(text, book_id):
    m = re.search(r'\{\s*id:\s*"' + re.escape(book_id) + r'"', text)
    if not m:
        return None
    start = text.rfind("\n", 0, m.start()) + 1  # 从行首替换，避免叠加缩进
    depth, i, in_str = 0, start, None
    while i < len(text):
        ch = text[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in "\"'":
            in_str = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return start, i + 1
        i += 1
    return None


def grab(block, key):
    m = re.search(r"\b" + key + r':\s*"([^"]*)"', block)
    return m.group(1) if m else ""


def grab_int(block, key):
    m = re.search(r"\b" + key + r":\s*(\d+)", block)
    return int(m.group(1)) if m else None


def build_entry(e):
    """按 books.js 既有排版风格重建条目文本。"""
    has_sub = bool(e.get("subtitle"))
    head = '  { id: %s, title: %s,' % (q(e["id"]), q(e["title"]))
    if has_sub:
        head += ' subtitle: %s,' % q(e["subtitle"])
    head += ' author: %s, translator: %s,' % (q(e.get("author", "")), q(e.get("translator", "")))
    lines = [head,
             '    publisher: %s, year: %s, pubDate: %s, pages: %s, binding: %s,' % (
                 q(e.get("publisher", "")),
                 e.get("year") if e.get("year") is not None else "null",
                 q(e.get("pubDate")) if e.get("pubDate") else "null",
                 e.get("pages") if e.get("pages") is not None else "null",
                 q(e.get("binding")) if e.get("binding") else "null"),
             '    isbn: %s, genre: %s, series: %s, status: %s,' % (
                 q(e.get("isbn", "")), q(e.get("genre", "")),
                 q(e.get("series", "")) if e.get("series") else '""',
                 q(e.get("status", "pending"))),
             '    addedAt: %s,' % q(e.get("addedAt", ""))]
    if e.get("doubanUrl"):
        if e.get("cover"):
            lines.append('    cover: %s, doubanUrl: %s }' % (q(e["cover"]), q(e["doubanUrl"])))
        else:
            lines.append('    doubanUrl: %s }' % q(e["doubanUrl"]))
    else:
        lines.append('    doubanUrl: "" }')
    return "\n".join(lines)


def download_cover(cover_url, book_id):
    """下载豆瓣封面到 covers/<book_id>.jpg（走 fetch_image，含换镜像域名绕风控），失败返回 None。"""
    if not cover_url:
        return None
    try:
        data, _ = fetch_image(cover_url)
        covers = ROOT / "covers"
        covers.mkdir(exist_ok=True)
        (covers / (book_id + ".jpg")).write_bytes(data)
        return "covers/%s.jpg" % book_id
    except Exception:
        return None


def entry_from_block(block):
    return {
        "id": grab(block, "id"), "title": grab(block, "title"), "subtitle": grab(block, "subtitle"),
        "author": grab(block, "author"), "translator": grab(block, "translator"),
        "publisher": grab(block, "publisher"), "year": grab_int(block, "year"),
        "pubDate": grab(block, "pubDate"), "pages": grab_int(block, "pages"),
        "binding": grab(block, "binding"), "isbn": grab(block, "isbn"),
        "genre": grab(block, "genre"), "series": grab(block, "series"),
        "status": grab(block, "status") or "pending", "addedAt": grab(block, "addedAt"),
        "cover": grab(block, "cover"),
        "douban": None,
    }


def backup_books(text):
    stamp = time.strftime("%Y%m%d_%H%M%S")
    bak = ROOT / ("_backup_books_%s.js" % stamp)
    bak.write_text(text, encoding="utf-8")
    return bak


def cmd_merge(sid, into=None, new=None):
    d = parse_subject(sid)
    CACHE.mkdir(exist_ok=True)
    (CACHE / ("%s.json" % d["id"])).write_text(
        json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    text = BOOKS_JS.read_text(encoding="utf-8")

    if into:
        span = find_entry_span(text, into)
        if not span:
            print("错误：books.js 中找不到书库条目 %s" % into)
            sys.exit(1)
        old = entry_from_block(text[span[0]:span[1]])
        e = dict(old)
        old_digits = re.sub(r"\D", "", old.get("isbn", ""))
        new_digits = re.sub(r"\D", "", d.get("isbn") or "")
        if old_digits and new_digits and old_digits == new_digits:
            isbn = old.get("isbn", "")  # 数字相同 → 保留书库里的连字符格式
        else:
            isbn = d.get("isbn") or old.get("isbn", "")
        e.update({
            "title": d["title"] or old["title"],
            "subtitle": d.get("subtitle") or (old.get("subtitle") or None),
            "author": d.get("author") or old.get("author", ""),
            "translator": d.get("translator") or old.get("translator", ""),
            "publisher": d.get("publisher") or old.get("publisher", ""),
            "year": d.get("year") or old.get("year"),
            "pubDate": d.get("pubDate") or old.get("pubDate") or None,
            "pages": d.get("pages") if d.get("pages") is not None else old.get("pages"),
            "binding": d.get("binding") or old.get("binding") or None,
            "isbn": isbn,
            "series": d.get("series") or old.get("series") or "",
        })
        e["doubanUrl"] = d["url"]
        if not e.get("cover"):
            e["cover"] = download_cover(d.get("coverUrl"), into) or ""
        entry_text = build_entry(e)
        text = text[:span[0]] + entry_text + text[span[1]:]
        print("已更新条目 %s（%s）← 豆瓣 %s" % (into, e["title"], sid))
    else:
        book_id = new.get("book_id") or ("b-" + str(int(time.time())))
        e = {
            "id": book_id, "title": d["title"], "subtitle": d.get("subtitle"),
            "author": d.get("author", ""), "translator": d.get("translator") or "",
            "publisher": d.get("publisher", ""), "year": d.get("year"),
            "pubDate": d.get("pubDate"), "pages": d.get("pages"),
            "binding": d.get("binding"), "isbn": d.get("isbn", ""),
            "genre": new.get("genre", ""), "series": d.get("series") or new.get("series", ""),
            "status": new.get("status", "pending"),
            "addedAt": time.strftime("%Y-%m-%d"),
            "doubanUrl": d["url"],
            "cover": download_cover(d.get("coverUrl"), book_id) or "",
        }
        m = re.search(r"\n\];", text)
        if not m:
            print("错误：books.js 结构异常（找不到 ];）")
            sys.exit(1)
        seg = text[:m.start()].rstrip()
        if not seg.endswith(","):
            text = seg + "," + text[m.start():]
        else:
            text = text[:m.start()] + text[m.start():]
        text = text.replace("\n];", "\n" + build_entry(e) + "\n];", 1)
        print("已追加新书 %s（%s）← 豆瓣 %s" % (book_id, e["title"], sid))

    bak = backup_books(BOOKS_JS.read_text(encoding="utf-8")) if False else None
    # 备份应在改动前——这里用先前已读的原始 text
    BOOKS_JS.write_text(text, encoding="utf-8")
    print("books.js 已写回（ISBN %s）" % (d.get("isbn") or "—"))
    print("详情 JSON 已存 %s" % (CACHE / ("%s.json" % d["id"])))


def main():
    ap = argparse.ArgumentParser(description="藏书阁 · 豆瓣对接")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("search")
    p1.add_argument("query")
    p2 = sub.add_parser("fetch")
    p2.add_argument("subject")
    p3 = sub.add_parser("merge")
    p3.add_argument("subject")
    p3.add_argument("--into", dest="into")
    p3.add_argument("--new", action="store_true")
    p3.add_argument("--book-id", dest="book_id")
    p3.add_argument("--genre", default="")
    p3.add_argument("--series", default="")
    p3.add_argument("--status", default="pending")
    args = ap.parse_args()
    if args.cmd == "search":
        cmd_search(args.query)
    elif args.cmd == "fetch":
        d = parse_subject(args.subject)
        CACHE.mkdir(exist_ok=True)
        (CACHE / ("%s.json" % d["id"])).write_text(
            json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(d, ensure_ascii=False, indent=2))
    elif args.cmd == "merge":
        # 备份必须发生在任何改动前：先读原文存档
        bak = backup_books(BOOKS_JS.read_text(encoding="utf-8"))
        cmd_merge(args.subject, into=args.into,
                  new={"book_id": args.book_id, "genre": args.genre,
                       "series": args.series, "status": args.status})
        print("备份：", bak.name)


if __name__ == "__main__":
    main()
