/* ============================================================
 * 藏书阁 · 图书管理平台 —— 静态数据源
 * ------------------------------------------------------------
 * 1) 页面用 <script src="data/books.js"> 引入，双击 index.html（file://）也能加载。
 * 2) status 字段：owned = 已购，pending = 未购。
 * 3) 数据维护两条路径：
 *    a) 页面「添加图书」→ 搜索豆瓣 → 选择版本 → 加入书库（写 localStorage 覆盖层，
 *       含状态/题材/封面，刷新与重启都在）；
 *    b) 命令行 python _douban_fetch.py merge --new 写回本文件（写前自动备份）。
 * 4) schema：id / title / subtitle / author / translator / publisher / year /
 *    pubDate("YYYY-MM") / pages / binding / isbn / genre / series / status /
 *    addedAt / doubanUrl / cover。
 * 5) cover 留空显示占位封面；豆瓣入库会自动下载到 covers/<id>.jpg。
 * 6) doubanUrl 豆瓣条目页链接：详情封面隐藏跳转用（无则封面不可点）。
 *    ※ 评分系统已按需求移除，不采集评分/人数/星级分布。
 * ============================================================ */

window.BOOK_META = { updatedAt: "2026-09-25", version: "v1.3" };

/* 书库已于 2026-09-25 清空，正式录入从零开始：
 * 线上页面或本地 index.html 的「添加图书」（豆瓣在线匹配）均可入库。 */
window.BOOKS = [
];
