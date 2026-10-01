/* ============================================================
 * 藏书阁 · 移动端触屏交互检查
 * ------------------------------------------------------------
 * 用法（PowerShell）：
 *   $env:NODE_PATH = "$env:USERPROFILE\.workbuddy\binaries\node\workspace\node_modules"
 *   & <node.exe> _touch_check.js
 * 可用环境变量：EDGE_PATH（默认系统 Edge 路径）
 * 被测对象：file://.../index.html?svc=...（svc 指向死端口，强制豆瓣离线）
 *
 * 为什么单独一个：
 *   _layout_check.js 盯版式（1440 定稿口径）、_smoke.js 盯功能（也是 1440 视口），
 *   两个都跑在桌面档 —— ≤1023px 那一整层（抽屉、滑动手势、长按、触屏反馈）
 *   一直没有常驻检查。2026-09-30 那次「CSS 媒体查询写了，但 ☰ 按钮和切换脚本没落地」
 *   就是这么漏过去的：桌面档全绿，手机上导航根本唤不出来。
 *
 * ⚠ 触摸必须用 CDP Input.dispatchTouchEvent 真实派发：page.click / page.tap
 *   走的是鼠标事件，测不到任何 touch 分支（拖不动抽屉、长按不触发）。
 * ⚠ setViewport 会把 touch 模拟关掉，每次切换视口后都要重新开。
 * ============================================================ */
const puppeteer = require('puppeteer-core');
const path = require('path');

const ROOT = __dirname;
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
/* 与 _smoke.js 同一套隔离手法：svc 指向不存在的端口 → 豆瓣探测只试它、不兜底，
   既不依赖本机代理是否在跑，也不会去连内置的云端代理地址 */
const PAGE_URL = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') + '?svc=http://127.0.0.1:59999';

/* 12 本，标题互不相同 —— 长按那条用例要断言「面板指向的正是被按住的那本」 */
const TITLES = ['百年孤独', '人类简史', '活着', '置身事内', '波斯札记', '世界小史',
  '城南旧事', '一九八四', '四川', '青海', '魏晋南北朝', '地道风物003'];
const GENRES = ['文学小说', '历史与人文', '地理', '艺术'];
/* ⚠ 上面 12 本最长 8 字，390 档（卡片 110px / 书名 13px）**一行就放得下** ——
   场景 G 要测「书名折行时绿点位置」，必须有本会折行的书，故另加一本 9 字长书名。
   pubDate 取最早 → 默认排序（出版日期新→旧）把它压到最后，不影响首卡用例 */
const LONG_TITLE_BOOK = {
  id: 'b-2999', title: '地道风物012·火锅', subtitle: '', author: '[中] 中国国家地理', translator: '',
  publisher: '中信出版社', year: 2019, pubDate: '2019-01', pages: 260, binding: '平装', isbn: '',
  genre: '地理', series: '', status: 'owned', addedAt: '2026-09-21', doubanUrl: '', cover: ''
};
const FIXTURE = {
  status: {},
  added: TITLES.map(function (t, i) {
    return {
      id: 'b-' + (2001 + i), title: t, subtitle: '', author: '[美] 作者' + (i + 1), translator: '',
      publisher: '南海出版公司', year: 2020, pubDate: '2020-' + String(12 - i).padStart(2, '0'),
      pages: 300, binding: '平装', isbn: '', genre: GENRES[i % 4], series: '',
      status: i % 3 === 0 ? 'pending' : 'owned', addedAt: '2026-09-21', doubanUrl: '', cover: ''
    };
  }).concat([LONG_TITLE_BOOK]),
  g: { list: null, map: {} }, cover: {}, deleted: []
};

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; const msg = name + (extra ? ' :: ' + extra : ''); fails.push(msg); console.log('  FAIL ' + msg); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await sleep(300);
  await page.evaluate(() => localStorage.removeItem('booklib.v1'));
  await page.evaluate(d => localStorage.setItem('booklib.v1', JSON.stringify(d)), FIXTURE);
  await page.reload({ waitUntil: 'load' });
  await sleep(500);

  const cdp = await page.target().createCDPSession();
  async function useMobile(w, h) {
    await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true });
    /* setViewport 会顺带关掉 touch 模拟，必须补开，否则派发的 touch 事件被丢弃 */
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await sleep(400);
  }
  const tStart = (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  const tMove = (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
  const tEnd = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  /* 12 步 × 16ms ≈ 200ms —— 慢速拖动。快甩会走「速度 > 0.45 即关」那条分支，
     想测「位移不够就弹回」的用例必须用慢速，否则量到的是速度而不是位移 */
  async function swipe(x0, y0, x1, y1, steps = 12, delay = 16) {
    await tStart(x0, y0);
    for (let i = 1; i <= steps; i++) {
      await tMove(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
      await sleep(delay);
    }
    await tEnd();
    await sleep(140);
  }
  async function tap(x, y) {
    await tStart(x, y); await sleep(40); await tEnd(); await sleep(200);
  }
  const state = () => page.evaluate(() => {
    const sb = document.querySelector('.sidebar').getBoundingClientRect();
    const mk = getComputedStyle(document.getElementById('navMask'));
    return {
      navOpen: document.body.classList.contains('nav-open'),
      sbLeft: Math.round(sb.left), sbRight: Math.round(sb.right),
      maskOpacity: mk.opacity, maskPE: mk.pointerEvents,
      status: !document.getElementById('statusOverlay').hidden,
      detail: !document.getElementById('detailOverlay').hidden,
      statusTitle: document.getElementById('statusBookTitle').textContent,
      pressing: !!document.querySelector('.card.pressing'),
    };
  });
  const reset = async () => {
    await page.evaluate(() => {
      ['statusOverlay', 'detailOverlay', 'addOverlay', 'genreOverlay', 'cloudOverlay']
        .forEach(id => { document.getElementById(id).hidden = true; });
      document.body.classList.remove('nav-open');
    });
    await sleep(350);
  };
  const geom = () => page.evaluate(() => {
    const c = document.querySelector('.grid .card');
    const mid = e => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    return {
      card: mid(c), cover: mid(c.querySelector('.cover')), info: mid(c.querySelector('.info')),
      title: c.querySelector('.c-title').textContent.trim(),
    };
  });

  await useMobile(390, 844);
  const g = await geom();

  /* ---------- 场景 A：抽屉边缘滑动 ---------- */
  console.log('\n[1/6] 场景 A：抽屉边缘滑动');
  await reset();
  await swipe(10, 400, 240, 400);
  await sleep(320);
  let s = await state();
  ok('A1 左边缘右滑 → 抽屉拉出', s.navOpen && s.sbLeft === 0 && s.sbRight === 280,
    'navOpen=' + s.navOpen + ' left=' + s.sbLeft + ' right=' + s.sbRight);
  ok('A2 遮罩随之亮起且可点', s.maskOpacity === '1' && s.maskPE === 'auto',
    'opacity=' + s.maskOpacity + ' pe=' + s.maskPE);

  await swipe(240, 400, 20, 400);
  await sleep(320);
  s = await state();
  ok('A3 左滑 → 抽屉收起', !s.navOpen && s.sbRight <= 0, 'navOpen=' + s.navOpen + ' right=' + s.sbRight);

  await swipe(10, 300, 12, 120);
  await sleep(200);
  s = await state();
  ok('A4 纵向滑动不误开抽屉（滚动优先）', !s.navOpen, 'navOpen=' + s.navOpen);

  await swipe(10, 400, 100, 400);
  await sleep(320);
  s = await state();
  ok('A5 拉不到一半 → 弹回关闭', !s.navOpen, 'navOpen=' + s.navOpen);

  /* ---------- 场景 B：卡片长按 ---------- */
  console.log('\n[2/6] 场景 B：卡片长按');
  await reset();
  await tStart(g.card.x, g.card.y);
  await sleep(160);
  s = await state();
  ok('B1 按住 160ms 出现按压态', s.pressing, 'pressing=' + s.pressing);
  await sleep(500);
  s = await state();
  ok('B2 长按 480ms → 标记面板弹出', s.status, 'statusOverlay=' + s.status);
  ok('B3 面板指向被长按的那本', s.statusTitle === g.title, '"' + s.statusTitle + '" vs "' + g.title + '"');
  ok('B4 弹出后按压态已撤', !s.pressing, 'pressing=' + s.pressing);
  await tEnd();
  await sleep(250);
  await reset();

  await tStart(g.card.x, g.card.y);
  await sleep(120);
  await tEnd();
  await sleep(300);
  s = await state();
  ok('B5 短按（120ms）不误触发长按', !s.status, 'statusOverlay=' + s.status);

  /* ---------- 场景 C：短按两条老路径未被长按改变 ---------- */
  console.log('\n[3/6] 场景 C：短按语义回归');
  await reset();
  await tap(g.cover.x, g.cover.y);
  s = await state();
  ok('C1 点封面 → 详情弹层', s.detail, 'detailOverlay=' + s.detail);
  await reset();
  await tap(g.info.x, g.info.y);
  s = await state();
  ok('C2 点文字区 → 标记面板', s.status, 'statusOverlay=' + s.status);
  await reset();

  /* ---------- 场景 D：弹层下滑关闭 ---------- */
  console.log('\n[4/6] 场景 D：弹层下滑关闭');
  const panelTop = sel => page.evaluate(q => Math.round(document.querySelector(q).getBoundingClientRect().top), sel);
  await tap(g.cover.x, g.cover.y);
  await sleep(150);
  if (!(await state()).detail) {
    ok('D0 详情弹层未打开，本场景跳过', false);
  } else {
    let top = await panelTop('#detailPanel');
    await swipe(195, top + 30, 195, top + 30 + 240);
    await sleep(400);
    s = await state();
    ok('D1 面板下滑 240px → 详情关闭', !s.detail, 'detailOverlay=' + s.detail);

    await tap(g.cover.x, g.cover.y);
    await sleep(250);
    top = await panelTop('#detailPanel');
    const h = await page.evaluate(() => Math.round(document.querySelector('#detailPanel').getBoundingClientRect().height));
    await swipe(195, top + h - 60, 195, top + h - 60 - 220);
    await sleep(400);
    s = await state();
    ok('D2 面板上滑 → 不关闭（上滑是看内容）', s.detail, 'detailOverlay=' + s.detail);
    await reset();

    await tap(g.cover.x, g.cover.y);
    await sleep(250);
    top = await panelTop('#detailPanel');
    await swipe(195, top + 30, 195, top + 60);
    await sleep(400);
    s = await state();
    ok('D3 只下滑 30px → 弹回不关闭', s.detail, 'detailOverlay=' + s.detail);
    await reset();

    /* 关闭时若漏清内联样式，下次打开面板会停在屏外 —— 这条专门守它 */
    await tap(g.cover.x, g.cover.y);
    await sleep(250);
    const back = await page.evaluate(() => {
      const p = document.querySelector('#detailPanel');
      return { top: Math.round(p.getBoundingClientRect().top), inline: p.style.transform };
    });
    ok('D4 重开面板回到原位（内联样式已清）',
      back.top >= 0 && back.top < 200 && back.inline === '', 'top=' + back.top + ' inline="' + back.inline + '"');
    await reset();
  }

  await tap(g.info.x, g.info.y);
  await sleep(250);
  const spTop = await panelTop('.status-panel');
  await swipe(195, spTop + 20, 195, spTop + 240);
  await sleep(400);
  s = await state();
  ok('D5 标记面板下滑 → 关闭', !s.status, 'statusOverlay=' + s.status);
  await reset();

  /* ---------- 场景 E：跟手（拖动过程中实时跟随，不是松手才动） ---------- */
  console.log('\n[5/6] 场景 E：跟手');
  await reset();
  await tStart(10, 400);
  await tMove(60, 400); await sleep(40);
  await tMove(140, 400); await sleep(60);
  const mid = await page.evaluate(() => {
    const sb = document.querySelector('.sidebar').getBoundingClientRect();
    return { left: Math.round(sb.left), opacity: parseFloat(getComputedStyle(document.getElementById('navMask')).opacity) };
  });
  ok('E1 抽屉跟手：松手前已半开', mid.left > -280 && mid.left < 0 && mid.opacity > 0 && mid.opacity < 1,
    'left=' + mid.left + ' opacity=' + mid.opacity);
  await tEnd();
  await sleep(320);
  await reset();

  await tap(g.cover.x, g.cover.y);
  await sleep(250);
  const dpTop = await panelTop('#detailPanel');
  /* 手指总位移取 120px（> 96px 阈值）—— 别停在 90px 附近：
     那样关闭与否就只由「速度 > 0.45」决定，而速度取决于这两次 sleep 之外的真实耗时，
     机器一忙就翻转，是个假红 */
  await tStart(195, dpTop + 30);
  await tMove(195, dpTop + 70); await sleep(40);
  await tMove(195, dpTop + 150); await sleep(60);
  const midp = await page.evaluate(() => {
    const p = document.querySelector('#detailPanel');
    return { tf: p.style.transform, shift: Math.round(p.getBoundingClientRect().top) };
  });
  ok('E2 弹层跟手：位移 = 手指位移', midp.shift - dpTop >= 115 && midp.shift - dpTop <= 125,
    'transform=' + midp.tf + ' 位移=' + (midp.shift - dpTop) + 'px');
  await tEnd();
  await sleep(400);
  s = await state();
  ok('E3 拉过 96px → 松手后关闭', !s.detail, 'detailOverlay=' + s.detail);
  await reset();

  /* ---------- 场景 G：书名折行时，已购绿点必须紧跟最后一个字 ----------
     2026-10-01 用户报障（手机截图）：两行的「地道风物012·火锅」绿点跑到卡片最右侧。
     根因是 .c-head 当时是 display:flex、.c-title 作 flex item —— 书名一折行，
     item 宽度就撑满整行，点被顶到最右、还相对整个多行块垂直居中。
     修法 = 点写进 <h3> 内随文字流。这里用 Range 取「末字」的真实矩形来卡位置。 */
  console.log('\n[6/7] 场景 G：折行书名的已购绿点');
  const dotRows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.grid .card').forEach(card => {
      const h3 = card.querySelector('.c-title'), dot = card.querySelector('.dot-owned');
      if (!h3 || !dot) return;
      const tn = h3.firstChild;
      const r = document.createRange();
      r.setStart(tn, tn.length - 1); r.setEnd(tn, tn.length);
      const last = r.getBoundingClientRect(), d = dot.getBoundingClientRect(), hb = h3.getBoundingClientRect();
      out.push({
        title: tn.data, inH3: h3.contains(dot),
        lines: hb.height / parseFloat(getComputedStyle(h3).lineHeight),
        gap: d.left - last.right,
        dy: (d.top + d.height / 2) - (last.top + last.height / 2),
      });
    });
    return out;
  });
  /* 先确认夹具真的覆盖到「折行」—— 全是单行的话这条用例等于没测
     （同 A5 只数分组个数、顺序怎么排都能过的教训） */
  const wrapped = dotRows.filter(r => r.lines >= 1.5);
  ok('G0 夹具含折行书名（用例真覆盖折行）', wrapped.length > 0,
    '折行 ' + wrapped.length + '/' + dotRows.length + ' 本');
  ok('G1 绿点在书名文字流内（不是并排的兄弟节点）',
    dotRows.length > 0 && dotRows.every(r => r.inH3),
    dotRows.filter(r => !r.inH3).map(r => r.title).join('/'));
  const badGap = dotRows.filter(r => !(r.gap >= 2 && r.gap <= 12));
  ok('G2 绿点紧跟末字（间距 ≈ 6px，不是卡片最右）', badGap.length === 0,
    badGap.map(r => r.title + ' gap=' + Math.round(r.gap)).join(' / '));
  /* 折行时「整块垂直居中」会让 dy ≈ 行高/2 ≈ 9.5px，这里卡 3px */
  const badDy = dotRows.filter(r => Math.abs(r.dy) > 3);
  ok('G3 绿点与末字同行居中（不是整块居中）', badDy.length === 0,
    badDy.map(r => r.title + ' dy=' + Math.round(r.dy)).join(' / '));

  /* ---------- 场景 F：桌面档不受影响 ---------- */
  console.log('\n[7/7] 场景 F：桌面档不受影响');
  await page.setViewport({ width: 1440, height: 900, isMobile: false, hasTouch: false });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(500);
  const gd = await geom();

  /* ⚠ 宽屏档不能用「左边缘长距离横滑」来测：这里我们的代码不做 preventDefault，
     Chrome 会把这个手势识别成浏览器的「后退」，直接把页面导航到 about:blank
     （DOM 全空，连 .sidebar 都取不到）。那是浏览器自己的手势，不归我们管 ——
     390 档之所以没事，只是因为我们的手势先接管并 preventDefault 了。
     改用短距离拖动（35px）：不足以触发浏览器手势，但足以观测我们的手势层有没有接管 ——
     真接管了就会往 .sidebar 写内联 transform，这里断言它自始至终为空。 */
  await tStart(10, 400);
  for (let i = 1; i <= 4; i++) { await tMove(10 + 35 * i / 4, 400); await sleep(16); }
  await sleep(120);
  const wide = await page.evaluate(() => ({
    navOpen: document.body.classList.contains('nav-open'),
    inline: document.querySelector('.sidebar').style.transform,
    samePage: /index\.html/.test(location.href),
  }));
  ok('F1 1440 下横向拖动不拉抽屉（手势层未接管）',
    wide.samePage && !wide.navOpen && wide.inline === '',
    'samePage=' + wide.samePage + ' navOpen=' + wide.navOpen + ' inline="' + wide.inline + '"');
  await tEnd();
  await sleep(320);
  s = await state();
  const lay = await page.evaluate(() => {
    const sb = document.querySelector('.sidebar');
    return {
      pos: getComputedStyle(sb).position, w: Math.round(sb.getBoundingClientRect().width),
      toggle: getComputedStyle(document.getElementById('navToggle')).display,
      mask: getComputedStyle(document.getElementById('navMask')).display,
    };
  });
  ok('F2 1440 下侧栏仍是桌面定宽（抽屉样式没漏到宽屏）',
    !s.navOpen && lay.pos !== 'fixed' && lay.w === 320,
    'navOpen=' + s.navOpen + ' position=' + lay.pos + ' width=' + lay.w);
  ok('F3 1440 下 ☰ 与遮罩均隐藏', lay.toggle === 'none' && lay.mask === 'none',
    'toggle=' + lay.toggle + ' mask=' + lay.mask);
  /* 桌面用鼠标事件测真实交互路径，坐标按 1440 重新取 */
  await page.mouse.click(gd.cover.x, gd.cover.y);
  await sleep(300);
  s = await state();
  ok('F4 1440 下点封面仍开详情（click 未被误吞）', s.detail, 'detailOverlay=' + s.detail);
  await reset();

  const realErrors = errors.filter(e =>
    e.indexOf('ERR_CONNECTION_REFUSED') === -1 && e.indexOf('Failed to load resource') === -1);
  ok('F5 全程无 JS 报错', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  console.log('\n结果：' + pass + ' PASS / ' + fail + ' FAIL');
  if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exitCode = 1; }
  await browser.close();
})().catch(e => { console.error('TOUCH CHECK CRASH: ' + (e.stack || e.message)); process.exit(1); });