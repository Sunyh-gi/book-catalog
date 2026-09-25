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
 * 零第三方依赖：urllib + re。抓取频率低、单线程，带浏览器 UA。
 * ============================================================ """
import argparse, html as H, json, pathlib, re, shutil, sys, time, urllib.parse, urllib.request
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


def http_get(url, tries=2):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=15) as r:
                text = r.read().decode("utf-8", "ignore")
            if "有异常请求" in text:
                raise RuntimeError("豆瓣反爬拦截（异常请求页）")
            return text
        except Exception as e:
            last = e
            if i < tries - 1:
                time.sleep(2)
    raise RuntimeError("请求失败 %s :: %s" % (url, last))


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
    m = re.search(r'<div id="info">(.*?)</div>', html, re.S)
    f = parse_info(m.group(1)) if m else {}

    cov = re.search(r'<img src="(https://img\d\.doubanio\.com/view/subject/[^"]+)"', html)
    pub = f.get("出版年", "")
    mm = re.match(r"(\d{4})-(\d{1,2})", pub)
    pub_date = ("%s-%02d" % (mm.group(1), int(mm.group(2)))) if mm else (pub or None)
    pages_m = re.match(r"(\d+)", f.get("页数", ""))

    return {
        "id": str(sid),
        "url": url,
        "title": title,
        "subtitle": f.get("副标题") or None,
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


def search_douban_page(q):
    """search.douban.com 聚合搜索页 → 候选列表（含同名不同版本的全量）。

    豆瓣的 subject_suggest 只给「最匹配的一条」（搜「波斯札记」只回 2023 版，
    漏掉 2014 版），而这个页面的 window.__DATA__.items 是完整结果集。
    """
    url = ("https://search.douban.com/book/subject_search?search_text=%s&cat=1001"
           % urllib.parse.quote(q))
    m = re.search(r"window\.__DATA__\s*=\s*(\{.*)", http_get(url), re.S)
    if not m:
        return []
    raw = _json_object_at(m.group(1), 0)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return []
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


def suggest_books(q):
    """subject_suggest（输入联想）→ 只取书籍条目。"""
    s = json.loads(http_get("https://book.douban.com/j/subject_suggest?q=" + urllib.parse.quote(q)))
    if not isinstance(s, list):
        return []
    # type == "b" 才是书（同接口也回电影/音乐），无 type 字段时保留
    return [x for x in s if not x.get("type") or x.get("type") == "b"]


def search_subjects(q, limit=15):
    """搜豆瓣书籍候选，合并三个入口并去重（顺序即相关度：聚合页在前）。

    ① search.douban.com 聚合页：唯一能一次拿到全部同名版本
    ② subject_suggest：补新书/冷门条目（聚合页偶尔漏，且自带干净的作者/年份）
    ③ www 聚合页：前两者都空时只抽 sid 兜底

    ⚠ ①②**必须并行**：豆瓣单请求就要 5s 上下（服务端慢，不是传输量），
    串行会把一次搜索拖到 10s。并行的代价是对豆瓣多一个并发请求，可接受。
    """
    q = q.strip()
    out, seen = [], set()

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
    """下载豆瓣封面到 covers/<book_id>.jpg（带 Referer 绕过 418），失败返回 None。"""
    if not cover_url:
        return None
    try:
        hdrs = dict(UA)
        hdrs["Referer"] = "https://book.douban.com/"
        req = urllib.request.Request(cover_url, headers=hdrs)
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
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
