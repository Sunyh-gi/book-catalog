# 藏书阁 · 图书管理平台

本地优先的**实体书管理应用**：记录个人藏书的购入状态（已购 / 未购），支持从豆瓣搜索图书、一键入库并自动抓取封面。

- 纯前端单壳：一个 `index.html`（CSS/JS 全内联）+ 一个数据文件，**无构建、无依赖**
- 数据存浏览器 `localStorage`，可一键同步到本仓库，实现多设备共享
- 浏览器无法直连豆瓣（CORS + 反爬），因此配套了两个代理：本机 Python 服务、Cloudflare Worker

**在线使用 → https://sunyh-gi.github.io/book-catalog/**
（新设备首次打开会自动加载云端书库）

## 使用

| 我想…… | 怎么做 |
|---|---|
| 打开书库 | 访问上面的线上地址 |
| 本地打开 | 下载后双击 `index.html`（file:// 可用，与线上 localStorage 互不相通） |
| 录入新书 | 「添加图书」→ 输入书名或 ISBN → 搜索豆瓣 → 点候选行「选择」自动填充 → 选题材 → 加入书库 |
| 改已购 / 未购 | 点卡片**文字区**（点封面是打开详情） |
| 删除图书 | 打开详情 → 书名右侧「删除」→ 点两次确认 |
| 管理题材 | 侧栏「题材」分组 → 弹层内增删改 |
| 多设备同步 | 侧栏「☁ 云同步」→ 填 GitHub Fine-grained PAT → 「同步到云端」 |
| 启用豆瓣搜索 | 电脑：`python _douban_server.py`；手机等无 Python 设备：在「☁ 云同步」里填一个 Cloudflare Worker 地址（端点契约见下方「豆瓣代理」，可自行部署） |

## 数据怎么存

| 层 | 位置 | 说明 |
|---|---|---|
| 底册 | `data/books.js` | 仓库里的初始书目 |
| 本机覆盖层 | `localStorage["booklib.v1"]` | 页面上的一切改动（改标记 / 录书 / 删书 / 题材 / 封面）都写这里 |
| 云快照 | `data/library.json` | 点「同步到云端」后全量写入本仓库，其他设备刷新即得 |

覆盖层结构：

```js
{ status:  { 书id: "owned" | "pending" },   // 购入状态
  added:   [ 新书 ],
  g:       { list: 题材字典 | null, map: { 书id: 题材 } },
  cover:   { 书id: "covers/x.jpg" | "covers/cloud/x.jpg" | "data:image/..." },
  deleted: [ 被删的底册书 id ] }
```

## 豆瓣代理

浏览器不能直连豆瓣（CORS + 反爬 + 图片 418），因此走代理。本地与云端两端点集一致：

| 端点 | 作用 |
|---|---|
| `GET /health` | 启动探测 |
| `GET /search?q=书名或ISBN` | 搜索候选 |
| `GET /fetch?id=<subject_id>` | 条目详情（含丛书） |
| `GET /cover?id=<subject_id>` | 封面图片（服务端带 Referer，绕过 418） |
| `GET /save_cover?sid=&book_id=` | 把封面落到 `covers/<book_id>.jpg` |

- **本机**：`_douban_server.py` 监听 `127.0.0.1:8765`（Windows 可双击 `_start_douban_server.cmd` 启动），详情缓存 24 小时
- **云端**：Cloudflare Worker，供手机 / 平板使用。⚠ `*.workers.dev` 域名在国内被 DNS 污染，**必须绑自定义域名**
- 页面探测顺序 `localhost` → `127.0.0.1` → 云端；代理不在线时平台照常可用（回落为本地查重 + 手动录入）
- 调试：`index.html?svc=http://127.0.0.1:9999` 可指向其他服务地址

## 文件

```
index.html                # 应用本体（CSS/JS 全内联，单壳）
data/books.js             # 底册数据源
data/library.json         # 云同步快照
covers/<书id>.jpg         # 封面图（covers/cloud/ 为同步到云端的副本）
_douban_server.py         # 豆瓣本地代理（127.0.0.1:8765）
_start_douban_server.cmd  # 双击启动本地代理（Windows）
_douban_fetch.py          # 豆瓣命令行工具（search / fetch / merge）
_smoke.js                 # 冒烟测试（需 puppeteer-core + 本机 Edge）
_gh_push.js               # 把本地文件同步到本仓库（GitHub Contents API）
```

## 界面约定

- 已购 = 封面左上角 6px 深灰圆点；未购 = 无任何标记
- 默认排序：出版日期从新到旧
- 所有计数从数据派生，页面不写死数量

## 已知约束

- `index.html` 与 `data/` 的**相对位置不能动**（file:// 相对引用）
- 封面必须走 `/cover` 代理，不能直连 `doubanio.com`（无 Referer 会返回 418）
- 豆瓣 suggest 接口的封面字段名是 **`pic`**（不是 `img`）
- 豆瓣未登录详情页没有平均分，因此本项目不做评分

## 关于数据公开

`data/library.json` 与 `covers/` 在本公开仓库中**任何人都能读取**——这是「其他设备免 Token 读取书库」的实现代价。若书单不宜公开，请改用私有仓库。

---

> 本地开发约定、踩过的坑与验证流程见 `项目记忆.md`（该文件不进仓库）。