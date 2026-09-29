# 藏书阁 · 图书管理平台

本地优先的**实体书管理应用**：记录个人藏书的购入状态（已购 / 未购），支持从豆瓣搜索图书、一键入库并自动抓取封面。

- 纯前端单壳：一个 `index.html`（CSS/JS 全内联）+ 一个数据文件，**无构建、无依赖**
- 数据存浏览器 `localStorage`（封面在 IndexedDB），**改动自动同步**到本仓库，多设备共享
- 浏览器无法直连豆瓣（CORS + 反爬），因此配套了两个代理：本机 Python 服务、Cloudflare Worker
- 云端开箱即用：豆瓣代理地址与同步通道都已内置，任意设备打开就能用，**无需逐台配置**

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
| 多设备同步 | **自动**：改动后约 4 秒自动推上云端，其他设备打开自动拉取并合并。首次在一台设备上打开侧栏「☁ 云同步」填一次**云端口令**即可 |
| 启用豆瓣搜索 | **内置，无需配置**：本机服务在跑就走本机，否则自动回落云端 Worker |

## 数据怎么存

| 层 | 位置 | 说明 |
|---|---|---|
| 底册 | `data/books.js` | 仓库里的初始书目 |
| 本机覆盖层 | `localStorage["booklib.v1"]` | 页面上的一切改动（改标记 / 录书 / 删书 / 题材 / 封面路径）都写这里 |
| 本机封面 | IndexedDB `booklib.covers` | 封面图（dataURL）单独存这里，绕开 localStorage 约 5MB 的配额限制 |
| 云快照 | `data/library.json` + `covers/cloud/` | 改动后自动写入本仓库，其他设备打开即得 |

覆盖层结构：

```js
{ status:  { 书id: "owned" | "pending" },   // 购入状态
  added:   [ 新书 ],
  g:       { list: 题材字典 | null, map: { 书id: 题材 } },
  cover:   { 书id: "covers/x.jpg" | "covers/cloud/x.jpg" },  // 只放小字符串，dataURL 封面在 IndexedDB
  deleted: [ 被删的书 id ] }
```

## 云同步

书库快照存在本仓库，多设备共享同一份数据：

- **写入不碰 GitHub Token**：Cloudflare Worker 代持 Token，页面只需一个**云端口令**（首次填一次，存本机浏览器，不随仓库公开）
- **全自动**：启动时自动拉取并合并云端；本机有改动时约 4 秒防抖后自动推送，不需要点按钮
- **合并而非覆盖**：推之前先拉一次再合并，另一台设备刚录入的书不会被这一台盖掉
- **手动兜底**：「立即同步」= 合并并上传；「从云端恢复」= 放弃本机、强制用云端覆盖（**只在确实要重置本机时用**）
- 其他设备约 1-3 分钟后刷新可见（Pages 重新构建的延迟）

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
- **云端**：Cloudflare Worker，供手机 / 平板使用，**地址已内置**（`https://douban.sunyh.ac.cn`），任意设备打开即用。⚠ `*.workers.dev` 域名在国内被 DNS 污染，**必须绑自定义域名**
- 页面探测顺序 `localhost` → `127.0.0.1` → 云端；代理不在线时平台照常可用（回落为本地查重 + 手动录入）
- 同一个 Worker 还提供云同步写入端点 `/gh/*`（代持 GitHub Token，凭口令鉴权）
- 调试：`index.html?svc=http://127.0.0.1:9999` 可指向其他服务地址

## 文件

```
index.html                # 应用本体（CSS/JS 全内联，单壳）
data/books.js             # 底册数据源
data/library.json         # 云同步快照
covers/<书id>.jpg         # 命令行入库时下载的封面
covers/cloud/<书id>.jpg   # 页面同步到云端的封面（dataURL 转存）
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