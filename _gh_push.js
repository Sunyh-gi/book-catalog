/* 本地 → GitHub Contents API 同步脚本（不落盘 token，从环境变量 GHPAT 或同目录 .gh_token 读取）
 * 用法: node _gh_push.js [--create] [--pages] [--dry-run] [--msg "提交说明"]
 *   --create   仓库不存在时创建（public，因为免费账号的 Pages 只对 public 仓开放）
 *   --pages    追加启用 GitHub Pages（main / root）
 *   --dry-run  只取远端树比对、列出「有变化」的文件清单，不推送
 *   --msg      覆盖默认提交说明
 * 推送清单: 下方 STATIC 白名单 + 自动扫描 covers/ 下的所有图片
 *   STATIC 是显式白名单，本地文件（如 项目记忆.md）不在其中就不会被推上去。
 * 只推变化文件：先取一次远端全树（git/trees?recursive=1），逐文件算 git blob sha 比对，
 *   与远端一致就跳过 —— 不再全量重推，也不再逐文件 GET 取 sha。
 * 校验：推送完成后重新拉一次树，一次性回读比对本次所有文件的 sha（失败自动重试）。
 * 排除: .gh_token（真实 PAT 永不进仓）、_server_*.txt、_backup_*、__pycache__/
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REPO = process.env.GH_REPO || "Sunyh-gi/book-catalog";
const BRANCH = "main";
const TOKEN = process.env.GHPAT || (function () {
  try { return fs.readFileSync(path.join(__dirname, ".gh_token"), "utf8").trim(); } catch (e) { return ""; }
})();
if (!TOKEN) { console.error("缺少 token：请把 classic PAT 写入同目录 .gh_token 文件，或设置 GHPAT 环境变量"); process.exit(2); }

const STATIC = [
  "index.html",
  "data/books.js",
  "README.md",
  ".gitignore",
  ".gh_token.example",
  "_douban_fetch.py",
  "_douban_server.py",
  "_smoke.js",
  "_gh_push.js",
  "_start_douban_server.cmd"
];
const SCAN_DIRS = ["covers"];

const DEFAULT_MSG = "chore: 同步图书管理平台";

const API = "https://api.github.com";

function listFiles() {
  const out = STATIC.filter(function (f) { return fs.existsSync(path.join(__dirname, f)); });
  SCAN_DIRS.forEach(function (d) {
    const abs = path.join(__dirname, d);
    if (!fs.existsSync(abs)) return;
    fs.readdirSync(abs).sort().forEach(function (f) {
      if (/\.(jpg|jpeg|png|webp)$/i.test(f)) out.push(d + "/" + f);
    });
  });
  return out;
}

function req(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({
    "User-Agent": "gh-push-script",
    "Authorization": "Bearer " + TOKEN,
    "Accept": "application/vnd.github+json"
  }, opts.headers || {});
  return fetch(url, opts);
}

function encPath(f) { return f.split("/").map(encodeURIComponent).join("/"); }

async function ensureRepo() {
  const g = await req(API + "/repos/" + REPO);
  if (g.status === 200) { console.log("仓库已存在: " + REPO); return; }
  if (g.status !== 404) throw new Error("GET repo -> " + g.status + " " + (await g.text()).slice(0, 200));
  if (!process.argv.includes("--create")) { throw new Error("仓库不存在，加 --create 参数可自动创建"); }
  const name = REPO.split("/")[1];
  const p = await req(API + "/user/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: name,
      description: "藏书阁 · 图书管理平台（实体书管理 + 豆瓣在线匹配入库）",
      private: false,
      has_issues: false,
      has_wiki: false,
      has_projects: false,
      auto_init: false
    })
  });
  if (p.status !== 201) throw new Error("POST /user/repos -> " + p.status + " " + (await p.text()).slice(0, 300));
  const pj = await p.json();
  console.log("已创建仓库: " + pj.full_name + "（" + (pj.private ? "private" : "public" + "）"));
}

/* git blob sha（与 GitHub 树里的 sha 同算法）：sha1("blob <字节数>\0" + 内容) */
function gitBlobSha(buf) {
  return crypto.createHash("sha1")
    .update(Buffer.concat([Buffer.from("blob " + buf.length + "\0", "utf8"), buf]))
    .digest("hex");
}

/* 一次拉取远端全树，得到 path -> blob sha 映射 */
async function fetchRemoteTree() {
  const r = await req(API + "/repos/" + REPO + "/git/trees/" + BRANCH + "?recursive=1");
  if (r.status === 404 || r.status === 409) return {};   // 空仓库 / 还没有提交
  if (r.status !== 200) throw new Error("GET tree -> " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const map = {};
  (j.tree || []).forEach(function (n) { if (n.type === "blob") map[n.path] = n.sha; });
  return map;
}

/* 单个 PUT；sha 来自远端树（新建不传），不再逐文件 GET */
async function putFile(f, content, remoteSha, msg) {
  const p = await req(API + "/repos/" + REPO + "/contents/" + encPath(f), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: msg + (remoteSha ? " [update " + f + "]" : " [add " + f + "]"),
      branch: BRANCH,
      sha: remoteSha || undefined,
      content: content.toString("base64")
    })
  });
  if (p.status !== 200 && p.status !== 201) {
    throw new Error("PUT " + f + " -> " + p.status + " " + (await p.text()).slice(0, 300));
  }
  console.log((remoteSha ? "更新" : "新建") + " " + f + " (" + content.length + " B)");
}

async function enablePages() {
  const p = await req(API + "/repos/" + REPO + "/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: { branch: BRANCH, path: "/" } })
  });
  if (p.status === 201) { console.log("Pages: 201（已启用 main / root）"); return; }
  if (p.status === 409) { console.log("Pages: 409（已启用，跳过）"); return; }
  throw new Error("POST pages -> " + p.status + " " + (await p.text()).slice(0, 300));
}

async function main() {
  await ensureRepo();
  const files = listFiles();
  const msg = (function () {
    const i = process.argv.indexOf("--msg");
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : DEFAULT_MSG;
  })();

  /* 1) 取远端树，逐文件比对本地 blob sha —— 一致的跳过，不全量重推 */
  const remoteTree = await fetchRemoteTree();
  const plan = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(__dirname, f));
    const sha = gitBlobSha(content);
    const remoteSha = remoteTree[f] || null;
    if (remoteSha === sha) continue;
    plan.push({ f: f, content: content, sha: sha, remoteSha: remoteSha });
  }

  console.log("比对完成：" + files.length + " 个文件里 " + plan.length + " 个有变化"
    + (files.length - plan.length ? "，跳过 " + (files.length - plan.length) + " 个未改动" : ""));
  if (!plan.length) { console.log("远端已是最新，无需推送。"); return; }
  plan.forEach(function (p) {
    console.log("  " + (p.remoteSha ? "M" : "A") + " " + p.f + "  (" + p.content.length + " B)");
  });
  if (process.argv.includes("--dry-run")) { console.log("（--dry-run：仅列出变化，未推送）"); return; }

  /* 2) 逐个推送 */
  for (const p of plan) await putFile(p.f, p.content, p.remoteSha, msg);

  /* 3) 回读校验：重新拉树，一次性比对本次全部文件（树偶有极短延迟，不一致时重试） */
  for (let i = 1; i <= 3; i++) {
    const after = await fetchRemoteTree();
    const bad = plan.filter(function (p) { return after[p.f] !== p.sha; });
    if (!bad.length) { console.log("回读校验通过：" + plan.length + " 个文件 sha 全部一致"); break; }
    if (i === 3) throw new Error("回读校验失败：" + bad.map(function (p) { return p.f; }).join(", "));
    await new Promise(function (r) { setTimeout(r, 2000); });
  }

  if (process.argv.includes("--pages")) await enablePages();
  const owner = REPO.split("/")[0], name = REPO.split("/")[1];
  console.log("全部完成: " + plan.length + " 个文件已同步到 " + REPO + "@" + BRANCH
    + "（扫描 " + files.length + " 个）");
  console.log("线上地址: https://" + owner.toLowerCase() + ".github.io/" + name + "/");
}

main().catch(e => { console.error("失败: " + e.message); process.exit(1); });
