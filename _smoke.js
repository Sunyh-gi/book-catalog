/* ============================================================
 * 藏书阁 · 冒烟测试
 * ------------------------------------------------------------
 * 用法（PowerShell）：
 *   $env:NODE_PATH = "$env:USERPROFILE\.workbuddy\binaries\node\workspace\node_modules"
 *   & <node.exe> _smoke.js
 * 可用环境变量：EDGE_PATH（默认系统 Edge 路径）
 * 被测对象：file://.../index.html（与用户双击打开的方式一致）
 * ============================================================ */
const puppeteer = require('puppeteer-core');
const path = require('path');
const http = require('http');

const ROOT = __dirname;
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
/* 冒烟主流程强制豆瓣离线（svc 指向不存在的端口），避免依赖用户是否启动 _douban_server.py；
   在线路径由场景 H 用 mock 服务单独验证 */
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') + '?svc=http://127.0.0.1:59999';
const MOCK_PORT = 9999;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; const msg = name + (extra ? ' :: ' + extra : ''); fails.push(msg); console.log('  FAIL ' + msg); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 测试数据集：books.js 已清空（真实书库从零开始），冒烟用 localStorage 注入代替种子 */
const FIXTURE = {
  status: {},
  added: [
    { id: "b-1001", title: "百年孤独", author: "[哥伦比亚] 加西亚·马尔克斯", translator: "范晔",
      publisher: "南海出版公司", year: 2011, pubDate: "2011-06", pages: 360, binding: "精装",
      isbn: "978-7-5442-5399-4", genre: "文学小说", series: "理想国译丛", status: "owned",
      addedAt: "2026-09-21", doubanUrl: "https://book.douban.com/subject/6082808/", cover: "" },
    { id: "b-1002", title: "人类简史", subtitle: "从动物到上帝", author: "[以] 尤瓦尔·赫拉利", translator: "林俊宏",
      publisher: "中信出版社", year: 2014, pubDate: "2014-10", pages: 440, binding: "平装",
      isbn: "", genre: "历史与人文", series: "新知文库", status: "owned",
      addedAt: "2026-09-20", doubanUrl: "", cover: "" },
    { id: "b-1003", title: "活着", author: "余华", translator: "",
      publisher: "作家出版社", year: 1993, pubDate: "1993-11", pages: 191, binding: "平装",
      isbn: "", genre: "文学小说", series: "", status: "owned",
      addedAt: "2026-09-19", doubanUrl: "", cover: "" },
    { id: "b-1004", title: "万历十五年", author: "[美] 黄仁宇", translator: "",
      publisher: "生活·读书·新知三联书店", year: 1997, pubDate: "1997-05", pages: 320, binding: "平装",
      isbn: "", genre: "历史与人文", series: "甲骨文丛书", status: "owned",
      addedAt: "2026-09-18", doubanUrl: "", cover: "" },
    { id: "b-1005", title: "挪威的森林", author: "[日] 村上春树", translator: "林少华",
      publisher: "上海译文出版社", year: 2007, pubDate: "2007-09", pages: 380, binding: "平装",
      isbn: "", genre: "文学小说", series: "", status: "pending",
      addedAt: "2026-09-17", doubanUrl: "", cover: "" },
    { id: "b-1006", title: "三体", author: "刘慈欣", translator: "",
      publisher: "重庆出版社", year: 2008, pubDate: "2008-01", pages: 302, binding: "平装",
      isbn: "", genre: "文学小说", series: "", status: "owned",
      addedAt: "2026-09-16", doubanUrl: "", cover: "" },
    { id: "b-1007", title: "乡土中国", author: "费孝通", translator: "",
      publisher: "北京大学出版社", year: 2012, pubDate: "2012-10", pages: 130, binding: "平装",
      isbn: "", genre: "社会科学", series: "汉译世界学术名著", status: "owned",
      addedAt: "2026-09-15", doubanUrl: "", cover: "" },
    { id: "b-1008", title: "美的历程", author: "李泽厚", translator: "",
      publisher: "生活·读书·新知三联书店", year: 2009, pubDate: "2009-01", pages: 320, binding: "平装",
      isbn: "", genre: "历史与人文", series: "", status: "pending",
      addedAt: "2026-09-14", doubanUrl: "", cover: "" },
    { id: "b-1009", title: "枪炮、病菌与钢铁", subtitle: "人类社会的命运", author: "[美] 贾雷德·戴蒙德", translator: "",
      publisher: "上海译文出版社", year: 2016, pubDate: "2016-07", pages: 520, binding: "平装",
      isbn: "", genre: "历史与人文", series: "译文纪实", status: "pending",
      addedAt: "2026-09-13", doubanUrl: "", cover: "" },
    { id: "b-1010", title: "置身事内", subtitle: "中国政府与经济发展", author: "兰小欢", translator: "",
      publisher: "上海人民出版社", year: 2021, pubDate: "2021-08", pages: 320, binding: "平装",
      isbn: "", genre: "经济管理", series: "", status: "owned",
      addedAt: "2026-09-12", doubanUrl: "", cover: "" }
  ],
  g: { list: null, map: {} },
  cover: {},
  deleted: []
};
const nav = page => (kind, value) => page.evaluate((k, v) => {
  const btn = [...document.querySelectorAll('#nav .nav-item')]
    .find(b => b.dataset.kind === k && (b.dataset.value || '') === (v || ''));
  if (btn) btn.click();
}, kind, value);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 800 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await sleep(400);
  await page.evaluate(() => localStorage.removeItem('booklib.v1'));
  await page.evaluate(d => localStorage.setItem('booklib.v1', JSON.stringify(d)), FIXTURE);
  await page.reload({ waitUntil: 'load' });
  await sleep(400);
  const goto_ = nav(page);

  /* ---------- 场景 A：加载与初始状态 ---------- */
  ok('A1 页面标题含「藏书阁」', (await page.title()).includes('藏书阁'));
  const cards1 = await page.$$eval('.grid .card', els => els.length);
  ok('A2 初始卡片 = 10', cards1 === 10, 'got ' + cards1);
  const meta1 = await page.$eval('#pageMeta', n => n.textContent.trim());
  ok('A3 页头统计自洽', meta1 === '共 10 册 · 已购 7 册 · 未购 3 册', meta1);

  const navTexts = await page.$$eval('#nav .nav-item', els => els.map(e => e.textContent.trim()));
  ok('A4 侧栏含 全部/已购/未购', navTexts.some(t => t.indexOf('全部') === 0) &&
    navTexts.some(t => t.indexOf('已购') === 0) && navTexts.some(t => t.indexOf('未购') === 0));
  const groups = await page.$$eval('#nav .nav-group', els => els.length);
  ok('A5 侧栏分组 = 4（书目/题材/作者/丛书）', groups === 4, 'got ' + groups);

  const dots = await page.$$eval('.grid .dot-owned', els => els.length);
  ok('A6 已购圆点 = 7', dots === 7, 'got ' + dots);
  const badgeLeft = await page.$$eval('.grid .badge', els => els.length);
  ok('A7 文字角标已移除（未购无标记）', badgeLeft === 0, 'got ' + badgeLeft);

  const firstTitle = await page.$eval('.grid .card .c-title', n => n.textContent.trim());
  const expectFirst = await page.evaluate(() => {
    const pk = b => b.pubDate ? String(b.pubDate) : (b.year ? b.year + '-00' : '0000-00');
    const d = JSON.parse(localStorage.getItem('booklib.v1') || '{}');
    const bs = (d.added || []).slice().sort((x, y) => pk(y).localeCompare(pk(x)));
    return bs.length ? bs[0].title : '';
  });
  ok('N1 默认排序按出版日期从新到旧', firstTitle === expectFirst, firstTitle + ' vs ' + expectFirst);

  /* ---------- 场景 B：过滤 / 搜索 / 排序 ---------- */
  await goto_('status', 'pending'); await sleep(150);
  ok('B1 未购视图标题', (await page.$eval('#pageTitle', n => n.textContent.trim())) === '未购');
  ok('B2 未购卡片 = 3', (await page.$$eval('.grid .card', els => els.length)) === 3);

  await goto_('genre', '文学小说'); await sleep(150);
  ok('B3 题材「文学小说」= 4', (await page.$$eval('.grid .card', els => els.length)) === 4);

  await goto_('series', '理想国译丛'); await sleep(150);
  ok('B4 丛书「理想国译丛」= 1', (await page.$$eval('.grid .card', els => els.length)) === 1);

  await goto_('all', ''); await sleep(150);
  await page.type('#searchInput', '百年孤独', { delay: 10 }); await sleep(250);
  ok('B5 搜索「百年孤独」命中 1', (await page.$$eval('.grid .card', els => els.length)) === 1);
  const metaSearch = await page.$eval('#pageMeta', n => n.textContent.trim());
  ok('B6 搜索态页头只显数量', metaSearch === '共 1 册', metaSearch);
  await page.evaluate(() => {
    const i = document.getElementById('searchInput');
    i.value = ''; i.dispatchEvent(new Event('input'));
  }); await sleep(150);

  /* ---------- 场景 C：标记状态弹层 ---------- */
  await page.click('.grid .card .info'); await sleep(250);
  ok('C1 点卡片信息区打开弹层', await page.$eval('#statusOverlay', n => !n.hidden));
  const sel1 = await page.$$eval('#statusOverlay .status-opt.selected', els => els.map(e => e.dataset.status));
  ok('C2 默认选中当前状态（已购）', sel1.length === 1 && sel1[0] === 'owned', JSON.stringify(sel1));
  await page.click('#statusOverlay .status-opt[data-status="pending"]'); await sleep(250);
  ok('C3 选后自动关闭', await page.$eval('#statusOverlay', n => n.hidden));
  const ownedNow = await page.$$eval('.grid .dot-owned', els => els.length);
  ok('C4 切换后已购圆点 = 6', ownedNow === 6, 'got ' + ownedNow);
  await page.click('.grid .card .info'); await sleep(200);
  const sel2 = await page.$$eval('#statusOverlay .status-opt.selected', els => els.map(e => e.dataset.status));
  ok('C5 重开弹层选中态已更新（未购）', sel2.length === 1 && sel2[0] === 'pending', JSON.stringify(sel2));
  await page.click('#statusOverlay .status-opt[data-status="owned"]'); await sleep(250);

  await page.click('.grid .card .info'); await sleep(200);
  await page.keyboard.press('Escape'); await sleep(200);
  ok('C6 Esc 关闭弹层', await page.$eval('#statusOverlay', n => n.hidden));

  /* ---------- 场景 D：添加图书 ---------- */
  await page.click('#btnAdd'); await sleep(250);
  ok('D1 添加弹层打开', await page.$eval('#addOverlay', n => !n.hidden));
  await page.type('#addTitle', '测试新书', { delay: 5 });
  await page.click('#btnSearchDouban'); await sleep(250);
  const headTxt = await page.$eval('#addResultHead', n => n.textContent.trim());
  ok('D2 本地查重 0 命中', /本地书库 · (匹配到 )?0 个版本/.test(headTxt), headTxt);
  await page.type('#mTitle', '测试新书', { delay: 5 });
  await page.type('#mAuthor', '测试作者', { delay: 5 });
  await page.type('#mYear', '2020', { delay: 5 });
  await page.click('#btnManualAdd'); await sleep(300);
  ok('D3 录入后跳到全部视图', (await page.$eval('#pageTitle', n => n.textContent.trim())) === '全部藏书');
  ok('D4 新书出现在网格（全部 11 册）', (await page.$$eval('.grid .card', els => els.length)) === 11);
  await goto_('all', ''); await sleep(200);
  const metaAll = await page.$eval('#pageMeta', n => n.textContent.trim());
  ok('D5 总数 = 11', metaAll.indexOf('共 11 册') === 0, metaAll);

  /* ---------- 场景 G：图书详情（点封面） ---------- */
  await page.type('#searchInput', '百年孤独', { delay: 5 }); await sleep(250);
  await page.click('.grid .card .cover'); await sleep(300);
  ok('G1 点封面打开详情', await page.$eval('#detailOverlay', n => !n.hidden));
  const dtext = await page.$eval('#detailPanel', n => n.textContent);
  ok('G2 详情含 出版社/出版年/页数/装帧', dtext.indexOf('南海出版公司') > -1 &&
    dtext.indexOf('2011-06') > -1 && dtext.indexOf('360') > -1 && dtext.indexOf('精装') > -1);
  ok('K1 详情含丛书字段', dtext.indexOf('丛书') > -1 && dtext.indexOf('理想国译丛') > -1);
  ok('G3 评分块与按钮已移除', dtext.indexOf('豆瓣评分') === -1 && dtext.indexOf('访问豆瓣') === -1);
  const coverHref = await page.$eval('#detailPanel .d-cover', n => n.getAttribute('href'));
  ok('G4 点详情封面跳豆瓣（隐藏功能）', coverHref === 'https://book.douban.com/subject/6082808/' &&
    (await page.$eval('#detailPanel .d-cover', n => n.getAttribute('target'))) === '_blank');
  await page.keyboard.press('Escape'); await sleep(200);
  ok('G5 Esc 关闭详情', await page.$eval('#detailOverlay', n => n.hidden));
  await page.evaluate(() => {
    const i = document.getElementById('searchInput');
    i.value = '置身事内'; i.dispatchEvent(new Event('input'));
  }); await sleep(250);
  await page.click('.grid .card .cover'); await sleep(300);
  const dtext2 = await page.$eval('#detailPanel', n => n.textContent);
  ok('G6 副标题豆瓣式小字浅色', dtext2.indexOf('置身事内') > -1 && dtext2.indexOf('中国政府与经济发展') > -1);
  ok('G7 无豆瓣数据时封面不可跳转', (await page.$eval('#detailPanel .d-cover', n => n.tagName)) === 'DIV' &&
    dtext2.indexOf('访问豆瓣') === -1);
  await page.keyboard.press('Escape'); await sleep(200);
  await page.evaluate(() => {
    const i = document.getElementById('searchInput');
    i.value = ''; i.dispatchEvent(new Event('input'));
  }); await sleep(150);

  /* ---------- 场景 N：变更图书题材分类（详情弹层下拉） ---------- */
  const genreCount = k => page.evaluate(key => {
    const b = [...document.querySelectorAll('#nav .nav-item')]
      .find(x => x.dataset.kind === 'genre' && x.dataset.value === key);
    return b ? +b.querySelector('.nav-count').textContent : -1;
  }, k);
  /* 覆盖层里有没有这本书的键、值是什么（null = 没有该键）——题材覆盖的真实落点 */
  const gmapVal = id => page.evaluate(k => {
    const s = JSON.parse(localStorage.getItem('booklib.v1') || '{}');
    const m = (s.g && s.g.map) || {};
    return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;
  }, id);

  await page.type('#searchInput', '百年孤独', { delay: 5 }); await sleep(250);
  await page.click('.grid .card .cover'); await sleep(300);
  ok('N1 详情有题材下拉且显示当前分类',
    (await page.$eval('#dGenre', n => n.value)) === '文学小说',
    await page.$eval('#dGenre', n => n.value));
  const gopts = await page.$$eval('#dGenre option', els => els.map(e => e.value));
  ok('N2 候选 = 未分类 + 全部题材',
    gopts[0] === '' && gopts.indexOf('文学小说') > -1 && gopts.indexOf('经济管理') > -1,
    JSON.stringify(gopts));

  const socBefore = await genreCount('社会科学');
  await page.select('#dGenre', '社会科学'); await sleep(300);
  ok('N3 改分类写入题材覆盖层', (await gmapVal('b-1001')) === '社会科学',
    JSON.stringify(await gmapVal('b-1001')));
  ok('N4 侧栏题材计数随之 +1', (await genreCount('社会科学')) === socBefore + 1,
    socBefore + ' -> ' + (await genreCount('社会科学')));
  ok('N5 下拉保持新分类（详情弹层未被重建）',
    (await page.$eval('#dGenre', n => n.value)) === '社会科学');

  await page.select('#dGenre', ''); await sleep(300);
  ok('N6 可清回「未分类」（覆盖层写空串，不回落成原题材）',
    (await gmapVal('b-1001')) === '', JSON.stringify(await gmapVal('b-1001')));
  ok('N7 清回未分类后计数复原', (await genreCount('社会科学')) === socBefore,
    'got ' + (await genreCount('社会科学')));

  await page.select('#dGenre', '文学小说'); await sleep(300);
  ok('N8 改回原题材不留冗余覆盖（覆盖层键被删）',
    (await gmapVal('b-1001')) === null, JSON.stringify(await gmapVal('b-1001')));

  await page.select('#dGenre', '社会科学'); await sleep(300);
  await page.keyboard.press('Escape'); await sleep(150);
  await page.reload({ waitUntil: 'load' }); await sleep(500);
  ok('N9 题材变更持久化（刷新后覆盖层与侧栏计数都在）',
    (await gmapVal('b-1001')) === '社会科学' && (await genreCount('社会科学')) === socBefore + 1,
    JSON.stringify([await gmapVal('b-1001'), await genreCount('社会科学')]));
  await page.evaluate(() => {
    const i = document.getElementById('searchInput');
    i.value = ''; i.dispatchEvent(new Event('input'));
  }); await sleep(150);

  /* ---------- 场景 I/J：布局调整 + 按钮文案 ---------- */
  const addInFilter = await page.$eval('#btnAdd', n => !!n.closest('.filterrow'));
  ok('I1 添加图书按钮在筛选行', addInFilter);
  const topbarBtns = await page.$$eval('.topbar-actions button', els => els.length);
  ok('I2 页头右侧无按钮（搜索右移）', topbarBtns === 0, 'got ' + topbarBtns);
  ok('I3 年份胶囊已移除', (await page.$('#yearPills')) === null);
  await page.click('#btnAdd'); await sleep(250);
  const addTxt = await page.$eval('#btnManualAdd', n => n.textContent.trim());
  ok('J1 加入书库按钮文案', addTxt === '加入书库', addTxt);
  await page.keyboard.press('Escape'); await sleep(150);

  /* ---------- 场景 E：持久化 ---------- */
  await page.reload({ waitUntil: 'load' }); await sleep(500);
  ok('E1 刷新后仍 11 册（localStorage）', (await page.$$eval('.grid .card', els => els.length)) === 11);

  /* ---------- 场景 L：删除功能（详情弹层两段确认） ---------- */
  await page.click('#btnAdd'); await sleep(250);
  await page.type('#mTitle', '待删除的书');
  await page.click('#btnManualAdd'); await sleep(400);
  await page.type('#searchInput', '待删除'); await sleep(250);
  ok('L1 待删书已入库', (await page.$$eval('.grid .card', els => els.length)) === 1);
  await page.click('.grid .card .cover'); await sleep(300);
  ok('L2 详情有删除按钮', (await page.$('#dDel')) !== null);
  await page.click('#dDel'); await sleep(150);
  const delTxt = await page.$eval('#dDel', n => n.textContent.trim());
  ok('L3 第一次点变确认删除', delTxt === '确认删除', delTxt);
  await page.click('#dDel'); await sleep(300);
  ok('L4 确认后弹层关闭', await page.$eval('#detailOverlay', n => n.hidden));
  await page.evaluate(() => {
    const i = document.getElementById('searchInput');
    i.value = ''; i.dispatchEvent(new Event('input'));
  }); await sleep(250);
  await goto_('all', ''); await sleep(200);
  const cntL5 = await page.$$eval('.grid .card', els => els.length);
  const metaL5 = await page.$eval('#pageMeta', n => n.textContent.trim());
  ok('L5 删除后总数 = 11', cntL5 === 11, 'cards=' + cntL5 + ' meta=' + metaL5);

  /* ---------- 场景 M：题材管理（增删） ---------- */
  await page.click('#genreManageBtn'); await sleep(250);
  ok('M1 题材弹层打开', await page.$eval('#genreOverlay', n => !n.hidden));
  await page.type('#gNew', '测试题材');
  await page.click('#btnGenreAdd'); await sleep(250);
  ok('M2 侧栏出现新题材', (await page.$eval('#nav', n => n.textContent.indexOf('测试题材') > -1)));
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#genreList .genre-row')]
      .find(r => r.dataset.g === '测试题材');
    row.querySelector('[data-act="del"]').click();
  }); await sleep(120);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#genreList .genre-row')]
      .find(r => r.dataset.g === '测试题材');
    row.querySelector('[data-act="del"]').click();
  }); await sleep(250);
  ok('M3 删除后侧栏移除', (await page.$eval('#nav', n => n.textContent.indexOf('测试题材') === -1)));
  await page.click('#btnCloseGenre'); await sleep(150);

  /* ---------- 场景 P：删书后的覆盖层收敛（防云封面残留 / 防其他设备复活） ---------- */
  /* 注入两条覆盖层残留：b-1002 的书内映射，以及一本根本不存在的书的映射 */
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('booklib.v1') || '{}');
    s.cover = s.cover || {}; s.status = s.status || {};
    s.cover['b-1002'] = 'covers/b-1002.jpg';
    s.cover['b-ghost'] = 'covers/ghost.jpg';
    s.status['b-1002'] = 'owned';
    s.status['b-ghost'] = 'owned';
    localStorage.setItem('booklib.v1', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'load' }); await sleep(400);
  const stP0 = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('booklib.v1') || '{}');
    return { cover: Object.keys(s.cover || {}), status: Object.keys(s.status || {}) };
  });
  ok('P0 启动即收敛覆盖层（幽灵书残留不必等云同步），且不误删活书条目',
    stP0.cover.indexOf('b-ghost') === -1 && stP0.status.indexOf('b-ghost') === -1
    && stP0.cover.indexOf('b-1002') > -1 && stP0.status.indexOf('b-1002') > -1,
    stP0.cover.join(',') + ' | ' + stP0.status.join(','));
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.grid .card')].find(c => c.dataset.id === 'b-1002');
    card.querySelector('.cover').click();
  }); await sleep(300);
  await page.click('#dDel'); await sleep(150);
  await page.click('#dDel'); await sleep(300);
  const stP = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('booklib.v1') || '{}');
    return {
      deleted: s.deleted || [],
      cover: Object.keys(s.cover || {}),
      status: Object.keys(s.status || {}),
      stillAdded: (s.added || []).some(x => x.id === 'b-1002'),
    };
  });
  ok('P1 自建书删除留下墓碑（防其他设备并集复活）', stP.deleted.indexOf('b-1002') > -1 && !stP.stillAdded, JSON.stringify(stP.deleted));
  ok('P2 删除后 cover 残留被收敛清掉（云封面才能回收）',
    stP.cover.indexOf('b-1002') === -1 && stP.cover.indexOf('b-ghost') === -1, stP.cover.join(','));
  ok('P3 删除后 status 残留被收敛清掉',
    stP.status.indexOf('b-1002') === -1 && stP.status.indexOf('b-ghost') === -1, stP.status.join(','));

  await page.evaluate(() => localStorage.removeItem('booklib.v1'));

  /* ---------- 场景 S：云同步弹层能真正打开 ----------
     光做语法检查抓不到这类 bug：openCloud() 里引用了已删除的常量，函数在
     `cloudOverlay.hidden = false` 之前就抛 ReferenceError —— 弹层根本打不开，
     于是「云端代理地址」永远没处可填，自愈一直判定豆瓣离线、静默不跑。
     断言必须落在「弹层可见 + 初始化跑到底」，不能只看有没有报错。 */
  await page.click('#btnCloud'); await sleep(300);
  const stS = await page.evaluate(() => ({
    open: !document.getElementById('cloudOverlay').hidden,
    ph: document.getElementById('cloudDoubanUrl').placeholder,
    badge: document.getElementById('badgeDouban').textContent,
    stepsHidden: document.getElementById('cloudSteps').hidden,
  }));
  ok('S1 云同步弹层可打开（openCloud 未中途抛错）', stS.open, JSON.stringify(stS));
  ok('S2 弹层初始化跑到底（地址框有提示语 + 代理徽标已渲染 + 三步说明已折叠）',
    !!stS.ph && !!stS.badge && stS.stepsHidden === true, JSON.stringify(stS));
  await page.keyboard.press('Escape'); await sleep(200);
  ok('S3 Esc 可关闭云同步弹层', await page.evaluate(() => document.getElementById('cloudOverlay').hidden));

  /* ---------- 场景 F：健壮性 ---------- */
  /* 过滤豆瓣离线探测（svc=59999）产生的浏览器网络日志噪音（ERR_CONNECTION_REFUSED），
     其余 pageerror / console error 仍视为真实错误 */
  ok('F1 全程无 JS 报错', errors.filter(function (e) {
    return e.indexOf('ERR_CONNECTION_REFUSED') === -1 &&
      e.indexOf('Failed to load resource') === -1;
  }).length === 0, errors.join(' | ').slice(0, 300));

  /* ---------- 场景 H：豆瓣在线路径（mock 本地代理） ---------- */
  function startMock() {
    return new Promise(function (resolve) {
      var srv = http.createServer(function (req, res) {
        var u = new URL(req.url, 'http://127.0.0.1:' + MOCK_PORT);
        var send = function (o, code) {
          var body = JSON.stringify(o);
          res.writeHead(code || 200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Content-Length': Buffer.byteLength(body),
          });
          res.end(body);
        };
        if (u.pathname === '/health') return send({ ok: true });
        if (u.pathname === '/search') {
          var q = u.searchParams.get('q') || '';
          /* 场景 R（限流）：豆瓣软拦截时聚合页回 {"total":0,"error_info":"搜索访问太频繁。"}，
             代理退化成 subject_suggest —— 候选只剩最匹配一条、没有 abstract、标题没冒号。
             代理识别出限流后在响应里带 limited:true，页面据此提示候选不全 */
          if (q.indexOf('限流测试书') > -1) return send({ candidates: [
            { id: '99993', title: '限流测试书', year: '2020', author_name: '测试作者' },
          ], limited: true, reason: '豆瓣搜索限流：搜索访问太频繁。' });
          return send({ candidates: [
            { id: '6082808', title: '百年孤独', year: '2011', author_name: '[哥伦比亚] 加西亚·马尔克斯',
              pic: 'https://img9.doubanio.com/view/subject/s/public/s9062104.jpg' },
            { id: '70001', title: '百年孤独（另一版本） : 纪念版', year: '2020', author_name: '测试作者',
              abstract: '测试作者 / 测试出版社 / 2020-5 / 45.00元',
              pic: 'https://img9.doubanio.com/view/subject/s/public/s9062104.jpg' },
          ] });
        }
        if (u.pathname === '/cover') {
          // 1x1 透明 PNG：让候选行封面真的加载成功，好断言 img 的 loading 属性
          // （返回 404 会触发页面 onerror 把 img 移除，就查不到 loading 了）
          var png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Access-Control-Allow-Origin': '*',
            'Content-Length': png.length,
          });
          return res.end(png);
        }
        if (u.pathname === '/save_cover') {
          var bid = u.searchParams.get('book_id') || 'unknown';
          return send({ ok: true, cover: 'covers/' + bid + '.jpg' });
        }
        if (u.pathname === '/fetch' && u.searchParams.get('id') === '6082808') {
          return send({ id: '6082808', title: '百年孤独', subtitle: null,
            author: '[哥伦比亚] 加西亚·马尔克斯', translator: '范晔', publisher: '南海出版公司',
            pubDate: '2011-06', year: 2011, pages: 360, binding: '精装',
            isbn: '978-7-5442-5399-4', series: '理想国译丛',
            url: 'https://book.douban.com/subject/6082808/' });
        }
        if (u.pathname === '/fetch' && u.searchParams.get('id') === '70001') {
          // 详情页没有 v:subtitle（真实豆瓣也有这种书）→ 详情卡只能退回候选标题拆出的副标题，
          // 所以 H10 断言「详情接口回 subtitle:null 时仍显示候选拆出的副标题」
          return send({ id: '70001', title: '百年孤独（另一版本）', subtitle: null,
            author: '测试作者', translator: '', publisher: '测试出版社',
            pubDate: '2020-05', year: 2020, pages: 300, binding: '平装',
            isbn: '9780000000001', series: '',
            url: 'https://book.douban.com/subject/70001/' });
        }
        send({ error: 'not found' }, 404);
      });
      srv.listen(MOCK_PORT, '127.0.0.1', function () { resolve(srv); });
    });
  }
  const mock = await startMock();
  const page2 = await browser.newPage();
  const err2 = [];
  page2.on('pageerror', e => err2.push('pageerror: ' + e.message));
  page2.on('console', m => { if (m.type() === 'error') err2.push('console: ' + m.text()); });
  await page2.setViewport({ width: 1440, height: 800 });
  const URL_ONLINE = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') +
    '?svc=http://127.0.0.1:' + MOCK_PORT;
  await page2.goto(URL_ONLINE, { waitUntil: 'load' });
  await sleep(400);
  await page2.evaluate(() => localStorage.removeItem('booklib.v1'));
  await page2.evaluate(d => localStorage.setItem('booklib.v1', JSON.stringify(d)), FIXTURE);
  await page2.reload({ waitUntil: 'load' });
  await sleep(1200);
  const hintH = await page2.$eval('#addHint', n => n.textContent.trim());
  ok('H1 探测到豆瓣在线', hintH.indexOf('豆瓣在线') > -1, hintH);
  await page2.click('#btnAdd'); await sleep(250);
  await page2.type('#addTitle', '百年孤独');
  await page2.click('#btnSearchDouban'); await sleep(400);
  const dbRows = await page2.$$eval('#addResults .db-row', els => els.length);
  ok('H2 豆瓣候选 = 2', dbRows === 2, 'got ' + dbRows);
  const headH = await page2.$eval('#addResultHead', n => n.textContent.trim());
  ok('H3 结果头含候选计数', headH.indexOf('豆瓣候选 2 个') > -1, headH);
  await sleep(600); // 等 prefetch 详情补全
  const more1 = await page2.$eval('#addResults .db-row .db-more', n => n.textContent.trim());
  ok('H3b 候选行预取出版社', more1.indexOf('南海出版公司') > -1, more1);
  const subs = await page2.$$eval('#addResults .db-row .db-sub', els => els.map(e => e.textContent.trim()));
  ok('H3c 副标题拆分显示', subs.length === 1 && subs[0] === '纪念版', JSON.stringify(subs));
  const dbCovers = await page2.$$eval('#addResults .db-row .add-cover', els => els.length);
  ok('H3d 候选行封面容器 = 2', dbCovers === 2, 'got ' + dbCovers);
  const mores = await page2.$$eval('#addResults .db-row .db-more', els => els.map(e => e.textContent.trim()));
  ok('H3e 候选自带摘要直接显示（无需预取详情）', mores[1] && mores[1].indexOf('测试出版社') > -1, JSON.stringify(mores));
  const lazy = await page2.$$eval('#addResults .db-row .add-cover img', els => els.map(e => e.getAttribute('loading')));
  ok('H3f 候选封面懒加载（15 条不全量取图）', lazy.length === 2 && lazy.every(v => v === 'lazy'), JSON.stringify(lazy));
  await page2.click('#addResults .db-pick'); await sleep(400);
  const f = await page2.evaluate(() => ({
    t: document.getElementById('mTitle').value,
    a: document.getElementById('mAuthor').value,
    y: document.getElementById('mYear').value,
    i: document.getElementById('mIsbn').value,
    s: document.getElementById('mSeries').value,
  }));
  ok('H4 表单自动填充（含丛书）', f.t === '百年孤独' && f.a.indexOf('加西亚') > -1 &&
    f.y === '2011' && f.i.indexOf('978') === 0 && f.s === '理想国译丛', JSON.stringify(f));
  await page2.click('#btnManualAdd'); await sleep(800);
  ok('H5 录入后跳全部视图', (await page2.$eval('#pageTitle', n => n.textContent.trim())) === '全部藏书');
  const gridH = await page2.$$eval('.grid .card', els => els.length);
  ok('H6 全部卡片 = 11', gridH === 11, 'got ' + gridH);
  const newCover = await page2.evaluate(() => {
    const cards = [...document.querySelectorAll('.grid .card')];
    for (const c of cards) {
      const img = c.querySelector('.cover img');
      if (img && (img.getAttribute('src') || '').indexOf('covers/') === 0) return img.getAttribute('src');
    }
    return '';
  });
  ok('H6b 入库自动补封面', newCover.indexOf('covers/') === 0, newCover);
  await page2.type('#searchInput', '百年孤独'); await sleep(400);
  await page2.click('.grid .card .cover'); await sleep(400);
  const dH = await page2.$eval('#detailPanel', n => n.textContent);
  const hrefH = await page2.$eval('#detailPanel .d-cover', n => n.getAttribute('href'));
  ok('H7 详情字段来自豆瓣', dH.indexOf('南海出版公司') > -1 && dH.indexOf('360') > -1 && dH.indexOf('精装') > -1);
  ok('H8 详情封面豆瓣链接', hrefH === 'https://book.douban.com/subject/6082808/', hrefH);
  /* H10：副标题链路。第二个候选标题是「百年孤独（另一版本） : 纪念版」，而 mock 的 /fetch
     故意返回 subtitle: null —— 真实豆瓣详情页的 #info 常没有「副标题」字段（如《阿拉伯的
     劳伦斯》只有「原作名」）。这条断言锁死「候选行拆出的副标题要跟着入库并显示在详情卡」。
     ⚠ 标题里的分隔符按豆瓣真实格式写成「 : 」（冒号两侧带空格），别改成紧凑的「:」——
     那样测的就不是线上真实数据了（实测《可能性的艺术》=「可能性的艺术 : 比较政治学30讲」） */
  await page2.keyboard.press('Escape'); await sleep(200);
  await page2.evaluate(() => {
    const i = document.getElementById('searchInput');
    i.value = ''; i.dispatchEvent(new Event('input'));
  }); await sleep(250);
  await page2.click('#btnAdd'); await sleep(250);
  await page2.type('#addTitle', '百年孤独'); await sleep(100);
  await page2.click('#btnSearchDouban'); await sleep(400);
  // 不能用 :nth-child —— 本地查重命中会在候选前面插一行，序号会错位
  const picksH = await page2.$$('#addResults .db-row .db-pick');
  await picksH[1].click(); await sleep(400);
  await page2.click('#btnManualAdd'); await sleep(800);
  await page2.evaluate(() => {
    const i = document.getElementById('searchInput');
    i.value = '另一版本'; i.dispatchEvent(new Event('input'));
  }); await sleep(300);
  await page2.click('.grid .card .cover'); await sleep(400);
  const subH = await page2.$eval('#detailPanel .d-sub', n => n.textContent.trim());
  ok('H10 详情卡显示候选行拆出的副标题', subH === '纪念版', subH);
  const dStyle = await page2.evaluate(() => {
    const m = document.querySelector('#detailPanel .d-meta');
    const s = document.querySelector('#detailPanel .d-meta .m-select');
    const h = document.querySelector('#detailPanel .d-hairline');
    const v = document.querySelector('#detailPanel .d-meta .m-value');
    return { gap: getComputedStyle(m).rowGap, sel: getComputedStyle(s).borderBottomStyle,
             hair: getComputedStyle(h).marginTop,
             selH: Math.round(s.getBoundingClientRect().height),
             valH: Math.round(v.getBoundingClientRect().height) };
  });
  ok('H11 元数据紧凑 + 题材行与文本行等高', dStyle.gap === '6px' && dStyle.sel === 'none' &&
    dStyle.hair === '12px' && dStyle.selH === dStyle.valH, JSON.stringify(dStyle));
  await page2.hover('#detailPanel .d-meta .m-select'); await sleep(200);
  const selHover = await page2.$eval('#detailPanel .d-meta .m-select', n => {
    const c = getComputedStyle(n);
    return c.borderBottomStyle + '/' + c.borderBottomWidth;
  });
  ok('H11b 题材下拉悬停/聚焦也不浮出下划线', selHover === 'none/0px', selHover);
  await page2.keyboard.press('Escape'); await sleep(200);
  ok('H9 在线路径无 JS 报错', err2.filter(function (e) {
    return e.indexOf('Failed to load resource') === -1;
  }).length === 0, err2.join(' | ').slice(0, 300));

  /* ---------- 场景 Q：副标题一次性补丁 ----------
     历史上有一批书是在「搜索降级」时录进来的：候选标题里没有冒号可拆，条目页明明有副标题
     也没取到，落库成了空串 ""；旧版过滤「非 null 即完成」又把空串当成已完成永久跳过 ——
     《置身事内》就是这么卡住的，怎么修都不显示。
     现在不再做后台自愈（代理探测 / 退避重试 / 解析版本号那一整套都删了），改成一张按豆瓣
     条目 ID 精确匹配的补丁表，打开页面补一次就落盘：不请求网络、不依赖代理配置。
     ⚠ 所以这一场景必须断言「补丁不靠网络」：Q1 的书 sid 在表里，而 mock 的 /fetch 并不认
     这个 id —— 只要 Q1 过了，就说明副标题是从表里来的，不是抓来的。 */
  /* index.html 的整段脚本包在 IIFE 里（"use strict"），store/saveStore 都不是全局，
     只能走 localStorage 注入 + 回读，跟场景 H 的 FIXTURE 用法一致 */
  await page2.evaluate(() => {
    localStorage.setItem('booklib.v1', JSON.stringify({
      status: {}, g: { list: null, map: {} }, cover: {}, deleted: [],
      added: [
        // 卡死场景：空串 + 补丁表里有 → 必须补上
        { id: 'b-patch-1', title: '置身事内', author: '', subtitle: '',
          doubanUrl: 'https://book.douban.com/subject/35546622/' },
        // 补丁表里没有 → 豆瓣条目页本来就没有副标题，保持空才是对的
        { id: 'b-patch-2', title: '豆瓣确无副标题的书', author: '', subtitle: '',
          doubanUrl: 'https://book.douban.com/subject/12345678/' },
        // 书名里已经含该副标题（台湾 + 第2版）→ 不重复补，否则显示成「台湾第2版 第2版」
        { id: 'b-patch-3', title: '台湾第2版', author: '', subtitle: null,
          doubanUrl: 'https://book.douban.com/subject/30265016/' },
        // 已经有副标题 → 不许覆盖
        { id: 'b-patch-4', title: '已有副标题的书', author: '', subtitle: '原有副标题',
          doubanUrl: 'https://book.douban.com/subject/35546622/' },
        // 没有豆瓣链接 → 补丁表够不着，保持空
        { id: 'b-patch-5', title: '没有豆瓣链接的书', author: '', subtitle: null,
          doubanUrl: '' },
      ],
    }));
  });
  await page2.reload({ waitUntil: 'load' });
  await sleep(600);   // 补丁在启动时同步生效，不需要等网络
  const patched = await page2.evaluate(() => {
    var parsed = JSON.parse(localStorage.getItem('booklib.v1') || '{}');
    var get = function (id) {
      return (parsed.added || []).filter(function (b) { return b.id === id; })[0];
    };
    return { stuck: get('b-patch-1').subtitle, unknown: get('b-patch-2').subtitle,
             dup: get('b-patch-3').subtitle, kept: get('b-patch-4').subtitle,
             nourl: get('b-patch-5').subtitle };
  });
  ok('Q1 空串书按豆瓣 ID 补上副标题（《置身事内》那个卡死场景，且不靠网络）',
    patched.stuck === '中国政府与经济发展', JSON.stringify(patched));
  ok('Q2 补丁表没有的书保持空（豆瓣条目页本来就没有，不是漏抓）',
    patched.unknown === '', JSON.stringify(patched));
  ok('Q3 书名已含该副标题时不重复补（避免「台湾第2版 第2版」）',
    patched.dup === null, JSON.stringify(patched));
  ok('Q4 已有副标题的书不被覆盖', patched.kept === '原有副标题', JSON.stringify(patched));
  ok('Q5 无豆瓣链接的书不受影响', patched.nourl === null, JSON.stringify(patched));

  /* ---------- 场景 R：搜索限流 ----------
     豆瓣软拦截时聚合页回 {"total":0,"error_info":"搜索访问太频繁。"}，代理退化成 suggest：
     候选只剩最匹配一条、没有 abstract、标题没冒号。页面必须显式提示「限流」，否则用户会
     以为「豆瓣上只有这一版」。
     ⚠ 副标题已改成一张离线补丁表、**完全不碰搜索也不碰网络**，所以限流期间照样补得上 ——
     R1 就是在「/search 被限流」的前提下断言补丁仍然生效，锁死「副标题与限流彻底解耦」。 */
  await page2.evaluate(() => {
    localStorage.setItem('booklib.v1', JSON.stringify({
      status: {}, g: { list: null, map: {} }, cover: {}, deleted: [],
      added: [
        { id: 'b-lim-2', title: '置身事内', author: '', subtitle: null,
          doubanUrl: 'https://book.douban.com/subject/35546622/' },
      ],
    }));
  });
  await page2.reload({ waitUntil: 'load' });
  await sleep(600);
  const limHeal = await page2.evaluate(() => {
    var parsed = JSON.parse(localStorage.getItem('booklib.v1') || '{}');
    var b = (parsed.added || []).filter(function (x) { return x.id === 'b-lim-2'; })[0];
    return b ? b.subtitle : 'MISSING';
  });
  ok('R1 搜索限流不影响副标题（补丁表离线生效，与限流彻底解耦）',
    limHeal === '中国政府与经济发展', JSON.stringify(limHeal));
  await page2.click('#btnAdd'); await sleep(250);
  await page2.type('#addTitle', '限流测试书'); await sleep(100);
  await page2.click('#btnSearchDouban'); await sleep(900);
  const limUI = await page2.evaluate(() => ({
    head: document.getElementById('addResultHead').textContent,
    sub: (document.querySelector('#addResults .db-row .db-sub') || {}).textContent || '',
  }));
  ok('R2 限流时结果头显式提示「限流」', limUI.head.indexOf('限流') > -1, JSON.stringify(limUI));
  ok('R3 限流时降级候选行不显示副标题（不把「没冒号」当成「没有副标题」）',
    limUI.sub === '', JSON.stringify(limUI));

  await page2.evaluate(() => { localStorage.removeItem('booklib.v1'); });
  await page2.close();
  mock.close();

  console.log('\n结果：' + pass + ' PASS / ' + fail + ' FAIL');
  if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exitCode = 1; }
  await browser.close();
})().catch(e => { console.error('SMOKE CRASH: ' + e.message); process.exit(1); });
