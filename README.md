# 图书管理平台（藏书阁）

> 本目录是图书管理平台的**唯一正式工作目录**，结构与文档面向 AI 与人类双重可读。
> 任何 AI 接手时：先读本 README，再看 `项目记忆.md`（规则与坑），需要历史细节查 `docs/`。

## 这是什么

一个**本地优先的实体书管理应用**：记录个人藏书的购入状态（已购/未购），支持从**豆瓣在线搜索图书并一键入库**（自动填充书目信息 + 下载封面）。

- 纯前端单壳应用，**双击 `index.html` 即可用**（file:// 协议，无需服务器）
- 豆瓣匹配通过本地代理服务实现（绕过浏览器 CORS 与豆瓣反爬）

## 快速上手

| 操作 | 方法 |
|---|---|
| **线上使用** | **https://sunyh-gi.github.io/book-catalog/**（GitHub Pages；新设备首次打开自动加载云端书库） |
| 本地使用 | 双击 `index.html`（file://，与线上 localStorage 互不相通） |
| **云同步（多设备）** | 侧栏「☁ 云同步」→ 粘贴 GitHub Fine-grained PAT（生成步骤见弹层内说明）→「上传到云端」；其他设备刷新即得。恢复/读取不需要 Token |
| 启用豆瓣在线搜索 | 电脑：运行 `python _douban_server.py`（需 Python）；**手机等无 Python 设备**：在「☁ 云同步」里配置豆瓣云端服务 URL（Cloudflare Worker，部署见 `cloudflare\部署说明.md`），全设备可用 |
| 同步 books.js 到线上 | `node _gh_push.js`（幂等只推变化文件；token 在 `.gh_token`） |
| 录入新书 | 添加图书 → 输入书名或 ISBN → 搜索豆瓣 → 点候选行的「选择」（自动填充）→ 选题材 → 加入书库（封面自动下载到 `covers/`） |
| 改已购/未购 | 点卡片**文字区**（点封面是打开详情） |
| 删除图书 | 打开图书详情 → 书名右侧「删除」→ 点两次确认 |
| 管理题材 | 侧栏「题材」分组标签（可点击文字）→ 弹层内增删改 |
| 跑测试 | `NODE_PATH=<node_modules路径> node _smoke.js`（60 断言） |
| 命令行豆瓣操作 | `python _douban_fetch.py search 书名` / `fetch <id>` / `merge <id> --new --book-id b-XXX --genre 题材` |

## 文件结构

```
图书管理平台\
├── index.html                  # 主页面（CSS/JS 全内联，单壳）
├── data\books.js               # 底册数据源（<script src> 引入，相对位置勿动）
├── data\library.json           # 云同步快照（页面「上传到云端」写入，新设备自动加载）
├── covers\<书id>.jpg           # 本地封面图（豆瓣入库自动下载 / 「上传封面」转 dataURL）
├── covers\cloud\<书id>.jpg     # 云同步上传的封面（线上/所有设备可见）
├── cloudflare\                 # 豆瓣云端代理（Workers）：worker.js + 部署说明.md
├── _douban_server.py           # 豆瓣本地代理服务（127.0.0.1:8765）
├── _start_douban_server.cmd    # 双击启动豆瓣服务
├── _douban_fetch.py            # 豆瓣命令行工具（search/fetch/merge，零第三方依赖）
├── _douban_cache\              # 豆瓣抓取缓存（详情 JSON 24h / 封面图）
├── _smoke.js                   # 冒烟测试（puppeteer + Edge，60 断言，内置 FIXTURE 测试数据）
├── _gh_push.js / .gh_token     # GitHub 推送（幂等只推变化；⚠ token 永不进仓）
├── _backup_books_*.js          # books.js 写回前自动备份
├── 设计稿-01~04.png            # Ardot 设计稿导出（画布 729245977334789）
├── README.md                   # 本文件
├── 项目记忆.md                 # 长期规则与坑（供 AI 快速对齐口径）
└── docs\
    ├── 开发日志-2026-09-24.md  # 完整开发历程（设计稿 15 轮 + HTML 工程 19 轮）
    └── 日志\2026-09-25.md      # 上线与云同步/云端代理历程（此后日志直写本目录）
```

## 架构要点（30 秒版）

1. **数据三层**：`data/books.js` 是底册（手改或 merge 脚本写回）；页面上的一切改动（改标记/录书/删书/题材/封面）写 **localStorage `booklib.v1` 覆盖层**；点「上传到云端」后全量快照写入 **GitHub `data/library.json`**（其他设备刷新/自动加载即得）
2. **覆盖层结构**：`{ status: {书id: owned|pending}, added: [新书], g: {list: 题材字典|null, map: {书id: genre}}, cover: {书id: "covers/x.jpg" | "covers/cloud/x.jpg" | "data:image/..."}, deleted: [种子书id] }`
3. **计数全部从数据派生**，页面不写死数量
4. **默认排序 = 按出版日期从新到旧**（pubDate → year 兜底），所有分类视图统一
5. **状态标记**：已购 = 封面左上角 6px 灰黑圆点（#4F4F4F）；未购 = 无任何标记

## 豆瓣本地代理（_douban_server.py）

监听 `127.0.0.1:8765`（仅本机），全部带 CORS 头（file:// 页面可用）：

| 端点 | 作用 | 缓存 |
|---|---|---|
| `GET /health` | 页面启动探测 | — |
| `GET /search?q=书名或ISBN` | 搜索候选（suggest 接口 + 聚合页兜底） | 内存 10 分钟 |
| `GET /fetch?id=<subject_id>` | 条目详情（标题/作者/出版社/出版年/页数/装帧/丛书/ISBN/封面URL） | `_douban_cache/<id>.json`，24 小时 |
| `GET /cover?id=<subject_id>` | 封面图片代理（服务端带 Referer 下载，绕过豆瓣 418） | `_douban_cache/covers/<sid>.jpg` |
| `GET /save_cover?sid=&book_id=` | 把封面落到 `covers/<book_id>.jpg`（入库自动调用） | — |

页面启动时探测 `/health`；**服务不在线时平台照常可用**（豆瓣搜索自动回落为本地查重 + 手动录入）。测试或并行开发可用 `index.html?svc=http://127.0.0.1:9999` 指向其他服务地址。

## 豆瓣云端代理（Cloudflare Workers）

本机服务只在跑它的设备上可用；**手机/平板等设备**由云端代理兜底（部署于 `https://douban.sunyh.ac.cn`，已实测豆瓣放行）：

| 端点 | 与本地服务一致 | 备注 |
|---|---|---|
| `/health` `/search` `/fetch` `/save_cover` | 相同（`save_cover` 返回 dataUrl，Workers 无文件系统） | 无状态零缓存 |

- 探测顺序：本机 localhost → 127.0.0.1 → 云端（在「☁ 云同步」弹层配置云端 URL，存本浏览器）
- ⚠ `*.workers.dev` 域名国内被 DNS 污染不可达，**必须绑自定义域名**（部署与验证详见 `cloudflare\部署说明.md`）

## 重要约束与已知坑

- `index.html` 与 `data/` 的**相对位置不能动**（file:// 相对引用）
- 豆瓣未登录详情页**没有平均分**，评分系统已按需求移除（doubanUrl 保留：详情封面是隐藏的豆瓣跳转锚点）
- 豆瓣 CDN 图片对无 Referer 请求返回 418 → 页面封面必须走 `/cover` 代理，不能直连 doubanio.com
- 豆瓣 suggest 接口封面字段名是 **`pic`**（不是 img）
- 「丛书」解析曾因 `&nbsp;`(\xa0) 栽过：字段名清洗必须先 `.rstrip()` 再 `.rstrip(" :：")`
- **本机验证 HTTP 接口用 `curl.exe`**：PowerShell `Invoke-RestMethod/WebRequest` 走系统代理，对 127.0.0.1 也可能挂 2 分钟
- 同一文件多处编辑必须串行 + grep 复核（并行 Edit 会静默丢失）
- 改完 JS 跑 `node --check` + `_smoke.js`（60 断言）再交付
- **`*.workers.dev` 域名国内被 DNS 污染**（解析到错误 IP，连接超时）——豆瓣云端代理必须绑自定义域名
- 「上传到云端」的 Fine-grained PAT 只存在当前浏览器 localStorage——换浏览器/清数据需重新粘贴
