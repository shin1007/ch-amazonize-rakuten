/* 保存したページで拡張を動かす検証用ハーネス
 *
 *   node tools/harness.mjs record <URL> [名前]   実ページを開き、通信ごと fixtures/<名前>.har に保存
 *   node tools/harness.mjs run [名前...]          保存したページに拡張を当て、スクショと結果を出す
 *
 * Yahoo!ショッピングの商品ページ・検索結果も保存・検証できる（runYahoo。URLのホストで振り分ける）。
 *
 * 楽天のページは毎回取りに行くと遅く、中身も日々変わる。一度保存しておけば、
 * 同じHTML・同じJSで何度でも試せる（ページ側のReactも保存したJSがそのまま動く）。
 *
 * - 保存しないもの: ログインが要る画面（かご・注文確認・クーポン獲得）。
 *   HARにはクッキーや個人情報が入るので、ログインした状態では record しない。
 * - fixtures/ と tools/out/ は .gitignore 済み（画像込みで数十MBになる）。
 * - playwright はリポジトリに入れない。PLAYWRIGHT_DIR（既定はユーザーのtoolbox）から読む。
 * - 拡張は非ASCIIのパスから読み込めないので、毎回一時フォルダへ写してから読ませる。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PW_DIR = process.env.PLAYWRIGHT_DIR || join(process.env.USERPROFILE || process.env.HOME, '.claude/tools/browser');
const { chromium } = createRequire(join(PW_DIR, 'package.json'))('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'fixtures');
const OUT = join(ROOT, 'tools/out');

/** 拡張を ASCII のみのパスへ写す */
function stageExtension() {
  const dir = join(tmpdir(), 'azr-harness-ext');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'manifest.json'), join(dir, 'manifest.json'));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'icons'), join(dir, 'icons'), { recursive: true });
  cpSync(join(ROOT, '_locales'), join(dir, '_locales'), { recursive: true });
  return dir;
}

async function launch({ withExtension, recordHar } = {}) {
  const ext = withExtension ? stageExtension() : null;
  const profile = join(tmpdir(), `azr-harness-profile-${process.pid}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', // 拡張はこのチャンネルなら headless でも動く
    headless: !process.env.HEADED,
    viewport: { width: 1400, height: 1000 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    recordHar,
    args: ext ? [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] : []
  });
  return { ctx, cleanup: () => rmSync(profile, { recursive: true, force: true }) };
}

async function record(url, name) {
  mkdirSync(FIXTURES, { recursive: true });
  name = name || new URL(url).pathname.split('/').filter(Boolean).join('_');
  const har = join(FIXTURES, `${name}.har`);
  // 拡張なしで取る。拡張が足した通信（クーポン照会など）まで固定されると、次の検証を歪める。
  const { ctx, cleanup } = await launch({ recordHar: { path: har, content: 'embed' } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  // 購入エリアはReactが後から描く。描かれるまで待ってから閉じる。
  if (isYahoo(url)) await page.waitForSelector('#prcdsp, [class*="imageIcon--pr"]', { timeout: 20000 }).catch(() => {});
  else await page.waitForSelector('#rakutenLimitedId_aroundCart', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  writeFileSync(join(FIXTURES, `${name}.url`), url);
  await ctx.close();
  cleanup();
  fixHar(har);
  console.log(`saved ${har}`);
}

/**
 * Playwright の HAR はそのままでは再生できない所がある（実際に詰まった）。
 * - 途中で打ち切られた通信は status -1 で残り、再生すると応答が来ないまま止まる。
 *   head の中の CSS がこれに当たると、DOMContentLoaded まで永遠に届かない。消して本物へ回す。
 * - 文字列で保存された本文は、再生時に UTF-8 で送られる。楽天の商品ページは EUC-JP なので、
 *   Content-Type の charset を UTF-8 に書き換えないと全体が文字化けする。
 */
function fixHar(path) {
  const har = JSON.parse(readFileSync(path, 'utf8'));
  har.log.entries = har.log.entries.filter((e) => e.response.status !== -1);
  for (const e of har.log.entries) {
    const c = e.response.content;
    if (c.encoding === 'base64' || typeof c.text !== 'string') continue;
    for (const hd of e.response.headers) {
      if (hd.name.toLowerCase() === 'content-type') hd.value = hd.value.replace(/charset=[^;]+/i, 'charset=UTF-8');
    }
    if (c.mimeType) c.mimeType = c.mimeType.replace(/charset=[^;]+/i, 'charset=UTF-8');
  }
  writeFileSync(path, JSON.stringify(har));
}

async function run(names) {
  if (!names.length) {
    names = existsSync(FIXTURES)
      ? readdirSync(FIXTURES).filter((f) => f.endsWith('.har')).map((f) => f.slice(0, -4))
      : [];
  }
  if (!names.length) throw new Error('fixtures/ に保存したページがない。先に record する。');
  mkdirSync(OUT, { recursive: true });

  const { ctx, cleanup } = await launch({ withExtension: true });
  // 拡張の設定はストレージの既定値で動く。debug だけ立てて AZR.log を出させる。
  // HARNESS_LANG=en のように言語を渡すと、表示言語を切り替えて試せる（訳を service worker から受け取る道を通る）
  const [sw] = ctx.serviceWorkers().length ? ctx.serviceWorkers() : [await ctx.waitForEvent('serviceworker')];
  await sw.evaluate((language) => chrome.storage.sync.set({ debug: true, ...(language ? { language } : {}) }), process.env.HARNESS_LANG || '');

  for (const name of names) {
    const url = readFileSync(join(FIXTURES, `${name}.url`), 'utf8').trim();
    const page = await ctx.newPage();
    // 保存に無い通信（拡張が足した画像の縮小版など）は本物へ取りに行く
    await page.routeFromHAR(join(FIXTURES, `${name}.har`), { notFound: 'fallback' });

    const logs = [];
    page.on('console', (m) => {
      if (m.type() === 'error' || /\[AZR\]/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (isYahoo(url)) {
      await runYahoo(page, name, url, logs);
      await page.close();
      continue;
    }
    await page.waitForSelector('#azr-item-root', { timeout: 20000 }).catch(() => logs.push('harness: azr-item-root が出ない'));
    // レイアウトは先に出て、購入エリアはReactが描いてから移設される
    await page.waitForFunction(() => document.documentElement.dataset.azrBuybox === 'mounted', null, { timeout: 20000 })
      .catch(() => logs.push('harness: 購入エリアが移設されない'));
    // 画像の選別は非同期で進むので、落ち着くまで待つ
    await page.waitForFunction(() => document.documentElement.dataset.azrGallery === 'settled', null, { timeout: 20000 })
      .catch(() => logs.push('harness: ギャラリーが settled にならない'));
    // 商品とショップの評価は service worker が商品レビューのページから取ってくる
    await page.waitForFunction(() => document.documentElement.dataset.azrRatings === 'settled', null, { timeout: 15000 })
      .catch(() => logs.push('harness: 評価が settled にならない'));
    // Amazonでの価格は service worker が amazon.co.jp の検索結果を読んで返す
    // （保存したページには入っていないので、ここだけは実際にAmazonへ通信する）
    await page.waitForFunction(() => document.documentElement.dataset.azrAmazon, null, { timeout: 25000 })
      .catch(() => logs.push('harness: Amazonの価格が返らない'));
    await page.waitForFunction(() => document.documentElement.dataset.azrYahoo, null, { timeout: 25000 })
      .catch(() => logs.push('harness: Yahoo!ショッピングの価格が返らない'));
    // 商品動画のプレーヤーは楽天の動画スクリプトが後から描き、それを動画の枠へ移設する
    if (await page.$('.azr-gallery-video')) {
      await page.waitForFunction(() => document.documentElement.dataset.azrVideo, null, { timeout: 20000 })
        .catch(() => logs.push('harness: 動画が移設されない'));
    }
    await page.waitForTimeout(500); // ロゴの読み込み

    const report = await page.evaluate(() => {
      const q = (s) => Array.from(document.querySelectorAll(s));
      return {
        buybox: Boolean(document.querySelector('.azr-buybox-slot #rakutenLimitedId_aroundCart')),
        // 枠はHTML、ボタンはReactが後から描く。移設した枠の中に描かれたか。
        buyboxButtons: q('.azr-buybox-slot button').map((b) => (b.getAttribute('aria-label') || b.textContent).trim()).filter(Boolean),
        gallery: q('.azr-thumb').map((t) => (t.classList.contains('is-video') ? 'video' : t.currentSrc || t.src)),
        // 移設した動画。勝手に再生されていないこと（paused）
        video: document.querySelector('.azr-gallery-video') ? {
          state: document.documentElement.dataset.azrVideo || null,
          paused: document.querySelector('.azr-gallery-video video')?.paused ?? null
        } : null,
        descriptionImages: q('.azr-detail-body img').map((i) => ({
          src: i.currentSrc || i.src,
          link: i.closest('a[href]')?.href || null
        })),
        descriptionShown: Boolean(document.querySelector('.azr-detail:not([hidden])')),
        // スクロールバーが出ている要素（左ペインのサムネイル枠は意図したもの）
        scrollbars: q('#azr-item-root, #azr-item-root *').flatMap((el) => {
          const cs = getComputedStyle(el);
          const bars = [];
          if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth) bars.push(`x ${el.scrollWidth}>${el.clientWidth}`);
          if (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) bars.push(`y ${el.scrollHeight}>${el.clientHeight}`);
          return bars.length ? [`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${bars.join(' ')}`] : [];
        }),
        // 中央ペインからはみ出して隠れている幅
        infoOverflow: (() => {
          const info = document.querySelector('.azr-info');
          return info ? info.scrollWidth - info.clientWidth : null;
        })(),
        // 右ペインの枠からはみ出した幅（楽天のカートフォームが min-width 等で広がるとここに出る）。
        // 隠れているダイアログ類（position:fixed）は数えない。
        buyboxOverflow: (() => {
          const box = document.querySelector('.azr-buybox');
          if (!box) return null;
          const right = box.getBoundingClientRect().right;
          let max = 0;
          for (const el of box.querySelectorAll('*')) {
            const r = el.getBoundingClientRect();
            if (!r.width || getComputedStyle(el).position === 'fixed') continue;
            max = Math.max(max, Math.round(r.right - right));
          }
          return max;
        })(),
        itemReview: document.querySelector('.azr-review')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
        // 価格。クーポンが効いているときは「適用後 / 元の価格 / クーポン適用後」が並ぶ
        price: document.querySelector('.azr-price-block')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
        coupons: q('.azr-item-coupons li').map((li) => li.innerText.replace(/\s+/g, ' ').trim()),
        amazon: {
          state: document.documentElement.dataset.azrAmazon || null,
          text: document.querySelector('.azr-amazon')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
          href: document.querySelector('.azr-amazon-item')?.href ?? null
        },
        yahoo: {
          state: document.documentElement.dataset.azrYahoo || null,
          text: document.querySelector('.azr-amazon[data-site="yahoo"]')?.innerText.replace(/\s+/g, ' ').trim() ?? null,
          href: document.querySelector('.azr-amazon[data-site="yahoo"] .azr-amazon-item')?.href ?? null
        },
        shopCard: document.querySelector('.azr-shop-card')?.innerText.replace(/\s+/g, ' ').trim() ?? null
      };
    });
    // item.js が debug 時に出す整理結果（{"moved":n,"dropped":[…],"left":[…]}）
    const galleryLog = logs.map((l) => l.match(/ gallery (\{.*\})$/)?.[1]).find(Boolean);
    Object.assign(report, galleryLog ? JSON.parse(galleryLog) : {});
    // 表示までの時間（boot.js が付ける目印と、ページ側の DOMContentLoaded）
    report.timing = await page.evaluate(() => {
      const d = document.documentElement.dataset;
      const nav = performance.getEntriesByType('navigation')[0];
      return { boot: Number(d.azrBootMs), ready: Number(d.azrReadyMs), shown: Number(d.azrShownMs), dcl: Math.round(nav?.domContentLoadedEventStart || 0) };
    });
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    await page.screenshot({ path: join(OUT, `${name}-full.png`), fullPage: true });
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ url, report, logs }, null, 2));
    console.log(`\n== ${name}  ${url}`);
    console.log(`購入エリア ${report.buybox ? `移設済み（ボタン: ${report.buyboxButtons.join(' / ') || 'なし'}）` : 'なし'} / ギャラリー ${report.gallery.length}枚 / 説明に残った画像 ${report.descriptionImages.length}枚 / 重複で消した ${report.dropped?.length ?? '?'}枚`);
    const t = report.timing;
    console.log(`  時間  起動 ${t.boot}ms / 商品データ ${t.ready}ms / 表示 ${t.shown}ms / DOMContentLoaded ${t.dcl}ms`);
    const short = (u) => (u || '').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
    if (report.video) console.log(`  動画  ${report.video.state ?? '未移設'}${report.video.paused === false ? '（再生中！）' : ''}`);
    for (const s of report.scrollbars) console.log(`  スクロールバー  ${s}`);
    if (report.infoOverflow) console.log(`  中央ペインのはみ出し ${report.infoOverflow}px`);
    if (report.buyboxOverflow) console.log(`  右ペインのはみ出し ${report.buyboxOverflow}px`);
    console.log(`  商品評価  ${report.itemReview ?? '(なし)'}`);
    console.log(`  Amazon  ${report.amazon.state ?? '(なし)'}  ${report.amazon.text ?? ''}`);
    console.log(`  ショップ  ${report.shopCard ?? '(なし)'}`);
    for (const d of report.dropped || []) console.log(`  重複  ${short(d.src)}  = ${d.sameAs}`);
    const why = new Map((report.left || []).map((l) => [short(l.src), l.why]));
    for (const i of report.descriptionImages) {
      console.log(`  残り  ${short(i.src)}  (${i.link ? 'リンク' : why.get(short(i.src)) || '楽天以外'})`);
    }
    // 楽天のページ自体が出すエラーは毎回同じなので、拡張のものだけ出す
    for (const l of logs) {
      if (/^harness:|\[AZR\]/.test(l) && !/ (gallery|harvested|boot|run) /.test(l)) console.log('  ' + l.slice(0, 300));
    }
    await page.close();
  }
  await ctx.close();
  cleanup();
  console.log(`\n結果: ${OUT}`);
}

const isYahoo = (url) => /(^|\.)shopping\.yahoo\.co\.jp$/.test(new URL(url).host);

/**
 * Yahoo!ショッピング: 商品ページは価格の欄（Amazon・楽天）と左右キー・Esc、検索結果はPRの薄表示を確かめる。
 * Amazon・楽天の価格は保存したページに入っていないので、ここだけは実際に通信する。
 */
async function runYahoo(page, name, url, logs) {
  const report = { url };
  if (/^\/(search|category)/.test(new URL(url).pathname)) {
    await page.waitForSelector('.azr-ad-item', { timeout: 15000 }).catch(() => logs.push('harness: PRの商品が薄くならない'));
    Object.assign(report, await page.evaluate(() => ({
      pr: document.querySelectorAll('[class*="imageIcon--pr"]').length,
      dimmed: document.querySelectorAll('.azr-ad-item').length
    })));
    console.log(`
== ${name}  ${url}
  PR ${report.pr}件 / 薄くした ${report.dimmed}件`);
  } else {
    await page.waitForFunction(() => document.documentElement.dataset.azrAmazon && document.documentElement.dataset.azrRakuten, null, { timeout: 40000 })
      .catch(() => logs.push('harness: Amazon・楽天の価格が返らない'));
    const current = () => page.evaluate(() => [...document.querySelectorAll('button[class*="thumbnailButton"]')].findIndex((b) => /isCurrent/.test(b.className)));
    const before = await current();
    await page.mouse.move(1390, 5); // サムネイルの上にマウスがあると、そちらに切り替わる
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    report.arrowKey = { before, after: await current() };
    await page.locator('.splide__slide.is-active button').first().click().catch(() => {});
    await page.waitForTimeout(800);
    const modalOpen = () => page.evaluate(() => Boolean(document.querySelector('.ModalView--open')));
    const modalImg = () => page.evaluate(() => document.querySelector('.ModalView--open [class*="selectedImage"] img')?.src || null);
    const imgBefore = await modalImg();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    report.modal = { opened: await modalOpen(), stepped: imgBefore !== null && imgBefore !== (await modalImg()) };
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    report.modal.closedByEsc = !(await modalOpen());
    Object.assign(report, await page.evaluate(() => ({
      boxes: [...document.querySelectorAll('.azr-amazon')].map((b) => ({
        site: b.dataset.site, state: b.dataset.state, text: b.innerText.replace(/\s+/g, ' ').trim()
      }))
    })));
    await page.locator('#prcdsp').scrollIntoViewIfNeeded().catch(() => {});
    console.log(`
== ${name}  ${url}`);
    console.log(`  左右キー ${report.arrowKey.before}→${report.arrowKey.after} / 拡大表示 ${report.modal.opened ? '開いた' : '開かない'}・${report.modal.stepped ? '送れた' : '送れない'}・Esc ${report.modal.closedByEsc ? 'で閉じた' : 'で閉じない'}`);
    for (const b of report.boxes) console.log(`  ${b.site} ${b.state}  ${b.text.slice(0, 200)}`);
  }
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ url, report, logs }, null, 2));
  for (const l of logs) if (/^harness:|\[AZR\]|pageerror/.test(l)) console.log('  ' + l.slice(0, 300));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'record') await record(rest[0], rest[1]);
else if (cmd === 'run') await run(rest);
else {
  console.log('usage: node tools/harness.mjs record <URL> [名前] | run [名前...]');
  process.exit(1);
}
