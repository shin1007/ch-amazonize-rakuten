/* Chrome ウェブストアに載せる画像を作る
 *
 *   node tools/store-images.mjs          撮影と組版の両方（日本語・英語）
 *   node tools/store-images.mjs compose  撮影は済んでいるものとして、組版だけやり直す
 *   STORE_LANG=en node tools/store-images.mjs   片方の言語だけ
 *
 * 出力は store/assets/（ch-uploader の入稿データの置き方）。
 *   locales/<ja|en>/screenshots/01〜05.jpg  スクリーンショット（1280x800）
 *   promo-tile-440x280.jpg                  小さいプロモーションタイル（既定の言語＝日本語の1組だけ）
 *   marquee-1400x560.jpg                    マーキープロモーションタイル（同上）
 *   icon.png                                ストア用アイコン（96pxの絵に16pxの余白）
 * 英語版は、ブラウザの表示言語を英語にして撮る（拡張の文言が英語になる）。
 * Amazon側の画面は fixtures/amazon_careme.har（harness.mjs record）。楽天の検索は中継Workerの応答を差し替える。
 * Yahoo!ショッピング側の画面は fixtures/yahoo_kojima_scalpd.har。こちらはAmazon・楽天とも実際に引く（差し替えの前に撮る）。
 * スクリーンショットは5枚まで（ストアの上限）なので、かご合計とクーポンは1枚にまとめている。
 *
 * - 商品ページは fixtures/ に保存したページ（harness.mjs record）に拡張を当てて撮る。
 *   STORE_ITEM で使うページを変えられる（既定は hoyuhaircare_cm-shtr-set）。
 * - かご・注文確認はログインが要るので撮らない。パネルは拡張と同じCSSで、見本の金額を入れて組む。
 *   金額は README の「実機での検証状況」で実際に出た数字を使っている。
 * - ストアは透過のあるPNGを受け付けないので、スクリーンショットとタイルはJPEGで出す。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PW_DIR = process.env.PLAYWRIGHT_DIR || join(process.env.USERPROFILE || process.env.HOME, '.claude/tools/browser');
const { chromium } = createRequire(join(PW_DIR, 'package.json'))('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'fixtures');
const ASSETS = join(ROOT, 'store/assets');
// 撮影したままの画像。組版の素材で、ストアには出さない（.gitignore 済み）
const RAW = join(ROOT, 'store/raw');
const ITEM = process.env.STORE_ITEM || 'hoyuhaircare_cm-shtr-set';
const AMAZON_ITEM = process.env.STORE_AMAZON_ITEM || 'amazon_careme';
const YAHOO_ITEM = process.env.STORE_YAHOO_ITEM || 'yahoo_kojima_scalpd';
const LANGS = process.env.STORE_LANG ? [process.env.STORE_LANG] : ['ja', 'en', 'zh_CN', 'zh_TW', 'ko', 'vi', 'id'];
const BCP47 = { ja: 'ja-JP', en: 'en-US', zh_CN: 'zh-CN', zh_TW: 'zh-TW', ko: 'ko-KR', vi: 'vi-VN', id: 'id-ID' };
// 見出しのフォント（Google Fonts）。日本語の字形では中国語・韓国語に見えないので言語ごとに変える
const FONT = { ja: 'Noto Sans JP', en: 'Noto Sans JP', zh_CN: 'Noto Sans SC', zh_TW: 'Noto Sans TC', ko: 'Noto Sans KR', vi: 'Noto Sans', id: 'Noto Sans' };

/** 拡張を ASCII のみのパスへ写す（非ASCIIのパスからは読み込めない） */
function stageExtension() {
  const dir = join(tmpdir(), 'azr-store-ext');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'manifest.json'), join(dir, 'manifest.json'));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'icons'), join(dir, 'icons'), { recursive: true });
  cpSync(join(ROOT, '_locales'), join(dir, '_locales'), { recursive: true });
  return dir;
}

async function launch(lang) {
  const ext = stageExtension();
  const profile = join(tmpdir(), `azr-store-profile-${process.pid}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // 縮めて組むので、倍の解像度で撮っておく
    locale: BCP47[lang],
    timezoneId: 'Asia/Tokyo',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--lang=${BCP47[lang]}`]
  });
  return { ctx, cleanup: () => rmSync(profile, { recursive: true, force: true }) };
}

async function openItem(ctx, name = ITEM) {
  const url = readFileSync(join(FIXTURES, `${name}.url`), 'utf8').trim();
  const page = await ctx.newPage();
  await page.routeFromHAR(join(FIXTURES, `${name}.har`), { notFound: 'fallback' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return page;
}

// エントリー済み一覧の見本。README の検証で実際に判定したキャンペーン。
const SAMPLE_CAMPAIGNS = (() => {
  const now = Date.now();
  const rows = [
    ['campaign/mama/', '楽天ママ割', 'entered'],
    ['campaign/point-up/everyday/point/', '5と0のつく日', 'already'],
    ['campaign/supersale/', '楽天スーパーSALE', 'already'],
    ['campaign/supersale/shop/', 'スーパーSALE ショップ買いまわり', 'already'],
    ['campaign/supersale/item/', 'スーパーSALE 半額商品', 'already'],
    ['campaign/supersale/pointup/', 'スーパーSALE ポイントアップ', 'already'],
    ['campaign/special/', 'お買い物特集', 'none']
  ];
  const items = {};
  for (const [path, title, status] of rows) {
    const url = `https://event.rakuten.co.jp/${path}`;
    items[url] = { url, title, status, checkedAt: now };
  }
  return { updatedAt: now, items };
})();

// Amazonの商品ページに出す楽天の候補。中継Workerの応答の形（worker/src/index.js）
const RAKUTEN_STUB = {
  count: 1,
  items: [{
    itemName: '【公式】ケアミー シャンプー ＆ トリートメント [ hoyu ホーユー Ungrid アングリッド care me オーガニック ボトル セット アミノ酸 ケラチン ノンシリコン ウッディハーブ ]',
    itemPrice: 3960,
    itemUrl: 'https://item.rakuten.co.jp/hoyuhaircare/cm-shtr-set/',
    affiliateUrl: 'https://item.rakuten.co.jp/hoyuhaircare/cm-shtr-set/',
    shopName: 'ホーユーヘアケア楽天市場店',
    shopCode: 'hoyuhaircare'
  }],
  searchUrl: 'https://search.rakuten.co.jp/search/mall/care%20me/'
};

async function shoot(lang) {
  for (const name of [ITEM, AMAZON_ITEM, YAHOO_ITEM]) {
    if (!existsSync(join(FIXTURES, `${name}.har`))) {
      throw new Error(`fixtures/${name}.har が無い。先に node tools/harness.mjs record <URL> ${name}`);
    }
  }
  const rawDir = join(RAW, lang);
  mkdirSync(rawDir, { recursive: true });

  const { ctx, cleanup } = await launch(lang);
  try {
    const [sw] = ctx.serviceWorkers().length ? ctx.serviceWorkers() : [await ctx.waitForEvent('serviceworker')];
    const extId = new URL(sw.url()).host;
    await sw.evaluate((data) => chrome.storage.local.set({ azrCampaigns: data }), SAMPLE_CAMPAIGNS);

    // Yahoo!ショッピングの商品ページ（Amazon・楽天の価格）。楽天の検索を差し替える前に撮る
    const yahoo = await openItem(ctx, YAHOO_ITEM);
    // Amazonは続けて引くと空の検索結果を返すことがある。両方の欄が当たるまで2回まで読み直す
    for (let i = 0; i < 3; i++) {
      await yahoo.waitForFunction(() => document.documentElement.dataset.azrAmazon && document.documentElement.dataset.azrRakuten, null, { timeout: 40000 })
        .catch(() => console.warn('  Amazon・楽天の価格が出ない'));
      const ok = await yahoo.evaluate(() => document.documentElement.dataset.azrAmazon === 'ok' && document.documentElement.dataset.azrRakuten === 'ok');
      if (ok || i === 2) break;
      await yahoo.waitForTimeout(3000);
      await yahoo.reload({ waitUntil: 'domcontentloaded' });
    }
    await yahoo.evaluate(() => window.scrollTo(0, document.getElementById('prcdsp').getBoundingClientRect().top + window.scrollY - 110));
    await yahoo.waitForTimeout(800);
    // 拡張が足した欄の位置（画面に対する割合）。組版で囲む
    const added = await yahoo.evaluate(() => {
      const rs = [...document.querySelectorAll('.azr-amazon')].map((b) => b.getBoundingClientRect());
      const left = Math.min(...rs.map((r) => r.left)) - 8, top = Math.min(...rs.map((r) => r.top)) - 8;
      const right = Math.max(...rs.map((r) => r.right)) + 8, bottom = Math.min(Math.max(...rs.map((r) => r.bottom)) + 8, innerHeight - 4);
      const pct = (v, all) => +(v / all * 100).toFixed(1);
      return { left: pct(left, innerWidth), top: pct(top, innerHeight), width: pct(right - left, innerWidth), height: pct(bottom - top, innerHeight) };
    });
    writeFileSync(join(rawDir, 'yahoo.json'), JSON.stringify(added));
    await yahoo.screenshot({ path: join(rawDir, 'yahoo.png') });
    console.log(`raw/${lang}/yahoo.png`);
    await yahoo.close();

    // Amazon側の楽天候補は、公開中のWorkerに問い合わせず見本の応答を返す
    await sw.evaluate((stub) => {
      const real = globalThis.fetch;
      globalThis.fetch = (url, opts) => String(url).startsWith('https://amazon-rakuten-link.shin1007.workers.dev/search')
        ? Promise.resolve(new Response(JSON.stringify(stub), { status: 200, headers: { 'content-type': 'application/json' } }))
        : real(url, opts);
    }, RAKUTEN_STUB);

    // 商品ページ（拡張あり）
    const page = await openItem(ctx);
    const ready = (flag, value) => page.waitForFunction(
      ([f, v]) => (v ? document.documentElement.dataset[f] === v : Boolean(document.documentElement.dataset[f])),
      [flag, value], { timeout: 20000 }
    ).catch(() => console.warn(`  ${flag} が ${value ?? '立た'}ない`));
    await page.waitForSelector('#azr-item-root', { timeout: 20000 });
    await ready('azrBuybox', 'mounted');
    await ready('azrGallery', 'settled');
    await ready('azrRatings', 'settled');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(rawDir, 'item.png') });
    console.log(`raw/${lang}/item.png`);
    await page.close();

    // Amazonの商品ページ（楽天へのリンクと価格）
    const amazon = await openItem(ctx, AMAZON_ITEM);
    await amazon.waitForSelector('#rakuten-link-btn', { timeout: 30000 }).catch(() => console.warn('  楽天のボタンが出ない'));
    await amazon.waitForTimeout(800);
    await amazon.screenshot({ path: join(rawDir, 'amazon.png') });
    console.log(`raw/${lang}/amazon.png`);
    await amazon.close();

    // ポップアップ（キャンペーンの欄）
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 400, height: 1600 }); // キャンペーンの欄は下の方にあるので、切り出す範囲が画面に収まる高さにする
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await popup.waitForSelector('#campaignList li', { state: 'attached' }); // 閉じた details の中なので見えてはいない
    // ベトナム語などはOSの既定フォントだと結合文字がずれるので、見出しと同じフォントで撮る
    if (lang !== 'ja' && lang !== 'en') {
      const font = FONT[lang];
      await popup.addStyleTag({ content: `@import url("https://fonts.googleapis.com/css2?family=${font.replace(/ /g, '+')}:wght@400;500;700&display=block"); body, button, summary, textarea, select { font-family: "${font}", sans-serif !important; }` });
      await popup.evaluate(() => document.fonts.ready);
      await popup.waitForTimeout(500);
    }
    await popup.evaluate((text) => {
      document.getElementById('scanStatus').textContent = text;
    }, TEXT[lang].scanStatus);
    // 全部だとスライドに収まらないので、キャンペーンの欄だけ切り出す（欄の並びが変わってもずれないよう、一覧を持つ欄で探す）
    const box = await popup.locator('section:has(#campaignList)').boundingBox();
    await popup.screenshot({ path: join(rawDir, 'popup.png'), clip: { x: box.x - 16, y: box.y - 4, width: box.width + 32, height: box.height + 14 } });
    console.log(`raw/${lang}/popup.png`);
  } finally {
    await ctx.close();
    cleanup();
  }
}

/* 文言（スライドの見出しと、拡張のパネルの見本） ------------------------------- */

const TEXT = {
  ja: {
    scanStatus: '77件を確認 / 新たに1件エントリー / 既にエントリー済み5件',
    tag: '楽天市場を、見やすく・お得に',
    chips: ['3カラムの商品ページ', 'Amazon⇄楽天の価格比較', 'かご合計', 'クーポン自動適用', '一括エントリー', 'Yahoo!ショッピング対応'],
    s1: ['楽天の商品ページを、<em>見やすい3カラム</em>に', '画像・商品情報・購入エリアを1画面に。Amazonでの価格も、楽天の価格のすぐ下に'],
    s2: ['<em>Amazon</em>の商品ページに、楽天のリンクと価格', 'JAN・ISBN・型番で同じ商品を探し、楽天の価格へワンクリックで'],
    s6: ['<em>Yahoo!ショッピング</em>でも、Amazon・楽天の価格を', '商品ページの価格の下に同じ商品のAmazon・楽天の価格。←→キーで画像送り、検索結果のPRは薄く'],
    s34: ['かごの<em>合計</em>と、いちばん得な<em>クーポン</em>', 'ショップをまたいだ合計とポイント差引後の金額。注文確認では割引額が最大のクーポンに自動で切り替え'],
    s5: ['キャンペーンを探して<em>一括エントリー</em>', 'ボタンひとつで、楽天トップに出ているキャンペーンを調べてエントリー'],
    s5p: [['エントリー漏れを防ぐ', 'キャンペーンページを1つずつ開いて押す手間を省きます'], ['エントリー済み一覧', '楽天には無い「どれにエントリーしたか」の記録を残せます'], ['押せたことを確かめてから記録', '表示が「エントリー済み」に変わったものだけを数えます']],
    cart: { title: 'かご合計', items: '商品合計（4点 / 3ショップ）', v1: '7,604円', ship: '送料', v2: '230円', pay: 'お支払い予定', v3: '7,834円', pts: '獲得予定ポイント', after: 'ポイント差引後', v4: '6,297円', by: 'ショップ別内訳', shops: ['ショップA', 'ショップB', 'ショップC'], amounts: ['3,980円 / 812pt', '2,090円 / 418pt', '1,764円 / 307pt'] },
    co: { title: 'クーポン最適化', now: '適用中の割引', v1: '-352円', note: '最良のクーポンが適用されています（-352円）', usable: '使えるクーポン 3件', rows: [['21%OFFクーポン', '-352円'], ['108円OFFクーポン', '-108円'], ['1,500円以上で100円OFF', '-100円']] }
  },
  en: {
    scanStatus: '77 checked / 1 newly entered / 5 already entered',
    tag: 'Shop Rakuten smarter',
    chips: ['3-column item page', 'Amazon ⇄ Rakuten prices', 'Cart total', 'Best coupon, applied', 'Bulk entry', 'Works on Yahoo! Shopping'],
    s1: ['Rakuten item pages in a <em>clear 3-column layout</em>', 'Images, details and buy box on one screen — with the Amazon price right under the Rakuten price'],
    s2: ['Rakuten links and prices, right on <em>Amazon</em>', 'Finds the same item by JAN, ISBN or model number — one click to the Rakuten price'],
    s6: ['Amazon and Rakuten prices on <em>Yahoo! Shopping</em>', 'Right under the Yahoo! price — plus ←→ to flip images and faded PR items in search'],
    s34: ['<em>Cart total</em> and the best <em>coupon</em>, automatically', 'Totals across shops and the price after points. At checkout, switches to the coupon with the biggest discount'],
    s5: ['Find campaigns and <em>enter them all</em>', 'One button checks the campaigns on the Rakuten top page and enters them'],
    s5p: [['Never miss an entry', 'No more opening campaign pages one by one'], ['A list of what you entered', 'A record Rakuten does not give you'], ['Recorded only after it worked', 'Counts only what switched to "Entered"']],
    cart: { title: 'Cart total', items: 'Items (4 / 3 shops)', v1: '¥7,604', ship: 'Shipping', v2: '¥230', pay: 'Amount to pay', v3: '¥7,834', pts: 'Points to earn', after: 'After points', v4: '¥6,297', by: 'By shop', shops: ['Shop A', 'Shop B', 'Shop C'], amounts: ['¥3,980 / 812pt', '¥2,090 / 418pt', '¥1,764 / 307pt'] },
    co: { title: 'Coupon optimizer', now: 'Current discount', v1: '-¥352', note: 'The best coupon is already applied (-¥352)', usable: '3 usable coupons', rows: [['21% OFF coupon', '-¥352'], ['¥108 OFF coupon', '-¥108'], ['¥100 OFF at ¥1,500 or more', '-¥100']] }
  },
  zh_CN: {
    scanStatus: '已检查77项 / 新报名1项 / 已报名过5项',
    tag: '让乐天购物更清晰、更划算',
    chips: ['三栏商品页', '亚马逊 ⇄ 乐天比价', '购物车合计', '自动使用优惠券', '一键报名', '支持Yahoo!购物'],
    s1: ['把乐天商品页变成<em>清晰的三栏布局</em>', '图片、商品信息、购买区一屏搞定。亚马逊价格就在乐天价格正下方'],
    s2: ['在<em>亚马逊</em>商品页直接看到乐天的链接和价格', '按 JAN 码、ISBN、型号找到同一商品，一键前往乐天价格'],
    s6: ['在<em>Yahoo!购物</em>也能看到亚马逊和乐天的价格', '商品页价格下方显示同一商品的亚马逊、乐天价格。←→键切换图片，搜索结果中的PR商品淡化'],
    s34: ['购物车<em>合计</em>与最划算的<em>优惠券</em>', '跨店铺合计与扣除积分后的金额。订单确认页自动切换为折扣金额最大的优惠券'],
    s5: ['查找活动并<em>一键报名</em>', '一个按钮检查乐天首页上的活动并完成报名'],
    s5p: [['不再漏报名', '省去逐个打开活动页面点击的麻烦'], ['已报名列表', '可以留下乐天没有提供的“报名了哪些”记录'], ['确认成功后才记录', '只统计显示已变为“已报名”的活动']],
    cart: { title: '购物车合计', items: '商品合计（4件 / 3家店铺）', v1: '¥7,604', ship: '运费', v2: '¥230', pay: '应付金额', v3: '¥7,834', pts: '预计获得积分', after: '扣除积分后', v4: '¥6,297', by: '各店铺明细', shops: ['店铺A', '店铺B', '店铺C'], amounts: ['¥3,980 / 812pt', '¥2,090 / 418pt', '¥1,764 / 307pt'] },
    co: { title: '优惠券优化', now: '已使用的折扣', v1: '-¥352', note: '已使用最优优惠券（-¥352）', usable: '可用优惠券 3张', rows: [['21% OFF优惠券', '-¥352'], ['¥108 OFF优惠券', '-¥108'], ['满¥1,500减¥100', '-¥100']] }
  },
  zh_TW: {
    scanStatus: '已檢查77項 / 新報名1項 / 已報名過5項',
    tag: '讓樂天購物更清晰、更划算',
    chips: ['三欄商品頁', '亞馬遜 ⇄ 樂天比價', '購物車合計', '自動套用優惠券', '一鍵報名', '支援Yahoo!購物'],
    s1: ['把樂天商品頁變成<em>清晰的三欄版面</em>', '圖片、商品資訊、購買區一個畫面搞定。亞馬遜價格就在樂天價格正下方'],
    s2: ['在<em>亞馬遜</em>商品頁直接看到樂天的連結與價格', '以 JAN 碼、ISBN、型號找到同一商品，一鍵前往樂天價格'],
    s6: ['在<em>Yahoo!購物</em>也能看到亞馬遜與樂天的價格', '商品頁價格下方顯示同一商品的亞馬遜、樂天價格。←→鍵切換圖片，搜尋結果中的PR商品淡化'],
    s34: ['購物車<em>合計</em>與最划算的<em>優惠券</em>', '跨店鋪合計與扣除點數後的金額。訂單確認頁自動切換為折抵金額最大的優惠券'],
    s5: ['尋找活動並<em>一鍵報名</em>', '一個按鈕檢查樂天首頁上的活動並完成報名'],
    s5p: [['不再漏報名', '省去逐一開啟活動頁面點擊的麻煩'], ['已報名清單', '可以留下樂天沒有提供的「報名了哪些」記錄'], ['確認成功後才記錄', '只統計顯示已變為「已報名」的活動']],
    cart: { title: '購物車合計', items: '商品合計（4件 / 3家店鋪）', v1: '¥7,604', ship: '運費', v2: '¥230', pay: '應付金額', v3: '¥7,834', pts: '預計獲得點數', after: '扣除點數後', v4: '¥6,297', by: '各店鋪明細', shops: ['店鋪A', '店鋪B', '店鋪C'], amounts: ['¥3,980 / 812pt', '¥2,090 / 418pt', '¥1,764 / 307pt'] },
    co: { title: '優惠券最佳化', now: '已使用的折扣', v1: '-¥352', note: '已使用最優惠的優惠券（-¥352）', usable: '可用優惠券 3張', rows: [['21% OFF優惠券', '-¥352'], ['¥108 OFF優惠券', '-¥108'], ['滿¥1,500折¥100', '-¥100']] }
  },
  ko: {
    scanStatus: '77건 확인 / 신규 응모 1건 / 이미 응모 5건',
    tag: '라쿠텐 쇼핑을 더 보기 쉽고 알뜰하게',
    chips: ['3단 상품 페이지', '아마존 ⇄ 라쿠텐 가격 비교', '장바구니 합계', '쿠폰 자동 적용', '일괄 응모', 'Yahoo! 쇼핑 지원'],
    s1: ['라쿠텐 상품 페이지를 <em>보기 쉬운 3단 구성</em>으로', '이미지·상품 정보·구매 영역을 한 화면에. 아마존 가격도 라쿠텐 가격 바로 아래에'],
    s2: ['<em>아마존</em> 상품 페이지에서 바로 라쿠텐 링크와 가격을', 'JAN 코드·ISBN·모델 번호로 같은 상품을 찾아 한 번에 라쿠텐 가격으로'],
    s6: ['<em>Yahoo! 쇼핑</em>에서도 아마존·라쿠텐 가격을', '상품 페이지 가격 아래에 같은 상품의 아마존·라쿠텐 가격. ←→ 키로 이미지 넘기기, 검색 결과의 PR은 흐리게'],
    s34: ['장바구니 <em>합계</em>와 가장 유리한 <em>쿠폰</em>', '상점을 넘나든 합계와 포인트 차감 후 금액. 주문 확인에서는 할인액이 가장 큰 쿠폰으로 자동 전환'],
    s5: ['캠페인을 찾아 <em>일괄 응모</em>', '버튼 하나로 라쿠텐 첫 페이지의 캠페인을 조사해 응모'],
    s5p: [['응모 누락 방지', '캠페인 페이지를 하나씩 열어 누르는 수고를 덜어 줍니다'], ['응모 완료 목록', '라쿠텐에는 없는 "어디에 응모했는지" 기록을 남길 수 있습니다'], ['응모된 것을 확인한 뒤 기록', '표시가 "응모 완료"로 바뀐 것만 셉니다']],
    cart: { title: '장바구니 합계', items: '상품 합계(4점 / 3개 상점)', v1: '¥7,604', ship: '배송비', v2: '¥230', pay: '결제 예정 금액', v3: '¥7,834', pts: '적립 예정 포인트', after: '포인트 차감 후', v4: '¥6,297', by: '상점별 내역', shops: ['상점A', '상점B', '상점C'], amounts: ['¥3,980 / 812pt', '¥2,090 / 418pt', '¥1,764 / 307pt'] },
    co: { title: '쿠폰 최적화', now: '적용 중인 할인', v1: '-¥352', note: '최적의 쿠폰이 적용되어 있습니다(-¥352)', usable: '사용 가능한 쿠폰 3개', rows: [['21% OFF 쿠폰', '-¥352'], ['¥108 OFF 쿠폰', '-¥108'], ['¥1,500 이상 구매 시 ¥100 OFF', '-¥100']] }
  },
  vi: {
    scanStatus: 'Đã kiểm tra 77 / đăng ký mới 1 / đã đăng ký từ trước 5',
    tag: 'Mua sắm Rakuten rõ ràng và tiết kiệm hơn',
    chips: ['Trang sản phẩm 3 cột', 'So giá Amazon ⇄ Rakuten', 'Tổng giỏ hàng', 'Tự áp dụng phiếu giảm giá', 'Đăng ký hàng loạt', 'Hỗ trợ Yahoo! Shopping'],
    s1: ['Trang sản phẩm Rakuten theo <em>bố cục 3 cột dễ nhìn</em>', 'Hình ảnh, thông tin và khu vực mua hàng trên một màn hình — giá Amazon ngay dưới giá Rakuten'],
    s2: ['Liên kết và giá Rakuten ngay trên trang <em>Amazon</em>', 'Tìm cùng sản phẩm theo mã JAN, ISBN, mã model — một cú nhấp để đến giá Rakuten'],
    s6: ['Giá Amazon, Rakuten trên <em>Yahoo! Shopping</em>', 'Ngay dưới giá Yahoo! — thêm phím ←→ để chuyển ảnh, làm mờ sản phẩm PR trong kết quả tìm kiếm'],
    s34: ['<em>Tổng giỏ hàng</em> và <em>phiếu giảm giá</em> tốt nhất', 'Tổng qua nhiều cửa hàng và giá sau khi trừ điểm. Khi xác nhận đơn, tự chuyển sang phiếu giảm nhiều nhất'],
    s5: ['Tìm chiến dịch và <em>đăng ký hàng loạt</em>', 'Một nút để kiểm tra các chiến dịch trên trang chủ Rakuten và đăng ký'],
    s5p: [['Không bỏ sót chiến dịch nào', 'Bớt công mở từng trang chiến dịch rồi bấm'], ['Danh sách đã đăng ký', 'Lưu lại "đã đăng ký chiến dịch nào" — thứ Rakuten không có'], ['Chỉ ghi lại sau khi xác nhận thành công', 'Chỉ tính những chiến dịch đã chuyển sang "Đã đăng ký"']],
    cart: { title: 'Tổng giỏ hàng', items: 'Tổng sản phẩm (4 món / 3 cửa hàng)', v1: '¥7,604', ship: 'Phí vận chuyển', v2: '¥230', pay: 'Số tiền phải trả', v3: '¥7,834', pts: 'Điểm dự kiến nhận', after: 'Sau khi trừ điểm', v4: '¥6,297', by: 'Chi tiết theo cửa hàng', shops: ['Cửa hàng A', 'Cửa hàng B', 'Cửa hàng C'], amounts: ['¥3,980 / 812pt', '¥2,090 / 418pt', '¥1,764 / 307pt'] },
    co: { title: 'Tối ưu phiếu giảm giá', now: 'Giảm giá đang áp dụng', v1: '-¥352', note: 'Phiếu tốt nhất đã được áp dụng (-¥352)', usable: '3 phiếu dùng được', rows: [['Phiếu giảm 21%', '-¥352'], ['Phiếu giảm ¥108', '-¥108'], ['Giảm ¥100 khi từ ¥1,500', '-¥100']] }
  },
  id: {
    scanStatus: '77 diperiksa / 1 baru diikuti / 5 sudah diikuti sebelumnya',
    tag: 'Belanja Rakuten lebih jelas dan hemat',
    chips: ['Halaman produk 3 kolom', 'Bandingkan harga Amazon ⇄ Rakuten', 'Total keranjang', 'Kupon otomatis', 'Ikut sekaligus', 'Mendukung Yahoo! Shopping'],
    s1: ['Halaman produk Rakuten dalam <em>tata letak 3 kolom yang jelas</em>', 'Gambar, detail, dan area pembelian dalam satu layar — harga Amazon tepat di bawah harga Rakuten'],
    s2: ['Tautan dan harga Rakuten langsung di halaman <em>Amazon</em>', 'Temukan produk yang sama lewat kode JAN, ISBN, atau nomor model — satu klik ke harga Rakuten'],
    s6: ['Harga Amazon dan Rakuten di <em>Yahoo! Shopping</em>', 'Tepat di bawah harga Yahoo! — plus ←→ untuk ganti gambar dan produk PR dipudarkan di hasil pencarian'],
    s34: ['<em>Total keranjang</em> dan <em>kupon</em> terbaik', 'Total lintas toko dan harga setelah poin. Saat checkout, otomatis beralih ke kupon dengan potongan terbesar'],
    s5: ['Temukan kampanye dan <em>ikuti sekaligus</em>', 'Satu tombol memeriksa kampanye di halaman utama Rakuten lalu mengikutinya'],
    s5p: [['Tak ada kampanye terlewat', 'Tidak perlu lagi membuka halaman kampanye satu per satu'], ['Daftar yang sudah diikuti', 'Catatan "kampanye apa yang sudah diikuti" yang tidak disediakan Rakuten'], ['Dicatat setelah dipastikan berhasil', 'Hanya menghitung yang statusnya berubah menjadi "Sudah diikuti"']],
    cart: { title: 'Total keranjang', items: 'Total barang (4 item / 3 toko)', v1: '¥7,604', ship: 'Ongkos kirim', v2: '¥230', pay: 'Jumlah yang dibayar', v3: '¥7,834', pts: 'Poin yang akan didapat', after: 'Setelah dikurangi poin', v4: '¥6,297', by: 'Rincian per toko', shops: ['Toko A', 'Toko B', 'Toko C'], amounts: ['¥3,980 / 812pt', '¥2,090 / 418pt', '¥1,764 / 307pt'] },
    co: { title: 'Optimalisasi kupon', now: 'Diskon yang berlaku', v1: '-¥352', note: 'Kupon terbaik sudah diterapkan (-¥352)', usable: '3 kupon dapat dipakai', rows: [['Kupon 21% OFF', '-¥352'], ['Kupon ¥108 OFF', '-¥108'], ['Potongan ¥100 untuk belanja ¥1,500 ke atas', '-¥100']] }
  }
};

/* 組版 ---------------------------------------------------------------------- */

const css = (p) => readFileSync(join(ROOT, p), 'utf8');
const icon = pathToFileURL(join(ROOT, 'icons/icon.svg')).href;

const BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    font-family: var(--font), "Noto Sans JP", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif;
    color: #0f1111;
    -webkit-font-smoothing: antialiased;
  }
  .slide {
    position: relative;
    width: 1280px; height: 800px; overflow: hidden;
    background: linear-gradient(180deg, #eef1f4 0%, #dfe4ea 100%);
  }
  .band {
    height: 168px; padding: 34px 64px 0;
    background: linear-gradient(180deg, #232f3e 0%, #131921 100%);
    color: #fff;
  }
  .band h1 { margin: 0; font-size: 44px; font-weight: 800; letter-spacing: .01em; line-height: 1.25; }
  .band h1 em { font-style: normal; color: #febd69; }
  .band p { margin: 10px 0 0; font-size: 21px; color: #c9d1d9; font-weight: 500; }
  .window {
    position: absolute; left: 64px; right: 64px; top: 200px; bottom: -8px;
    border-radius: 12px 12px 0 0; overflow: hidden; background: #fff;
    box-shadow: 0 18px 50px rgba(15, 17, 17, .28);
  }
  .window::before {
    content: ""; display: block; height: 28px; background: #e8eaed;
    background-image: radial-gradient(circle at 18px 14px, #ff5f57 5px, transparent 6px),
      radial-gradient(circle at 38px 14px, #febc2e 5px, transparent 6px),
      radial-gradient(circle at 58px 14px, #28c840 5px, transparent 6px);
  }
  .window img { display: block; width: 100%; }
  /* どのサイトの画面かを示すバッジ（ウィンドウ右上） */
  .site-badge { position: absolute; top: 3px; right: 14px; z-index: 2; padding: 2px 14px; border-radius: 999px; font-size: 15px; font-weight: 800; color: #fff; letter-spacing: .02em; }
  .band.has-site h1 { font-size: 36px; white-space: nowrap; width: max-content; }
  .band h1 .site { color: #ff9c9c; font-weight: 800; }
  .site-badge.is-rakuten { background: #bf0000; }
  .site-badge.is-amazon { background: #ff9900; color: #131921; }
  .site-badge.is-yahoo { background: #ff0033; }
  /* かご合計とクーポンを1枚に並べる */
  .split.is-pair { justify-content: center; }
  .split.is-pair .panel-stage { width: auto; }
  /* 拡張が足した部分の強調（画像の位置に対する割合で囲む） */
  .shot { position: relative; }
  .added { position: absolute; border: 4px solid #e47911; border-radius: 10px; box-shadow: 0 0 0 6px rgba(254, 189, 105, .55), 0 8px 24px rgba(0, 0, 0, .25); }
  .added-label { position: absolute; left: -4px; bottom: 100%; margin-bottom: 10px; white-space: nowrap; padding: 5px 14px; border-radius: 8px; background: #e47911; color: #fff; font-size: 19px; font-weight: 800; }
  .added-label::after { content: ""; position: absolute; left: 28px; top: 100%; border: 8px solid transparent; border-top-color: #e47911; }
  /* 画面全体を見せたいとき（拡大表示）は、切らずに縮めて中央に置く */
  .window.is-fit { left: calc(50% - 460px); right: auto; width: 920px; top: 192px; bottom: auto; border-radius: 12px; }
  .points { list-style: none; margin: 0; padding: 0; display: grid; gap: 22px; }
  .points li { position: relative; padding-left: 40px; font-size: 24px; line-height: 1.5; font-weight: 600; }
  .points li small { display: block; font-size: 17px; font-weight: 400; color: #565959; margin-top: 2px; }
  .points li::before {
    content: "✓"; position: absolute; left: 0; top: 3px;
    width: 28px; height: 28px; border-radius: 50%;
    background: #febd69; color: #131921; font-size: 17px; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
  }
  .split { position: absolute; top: 168px; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 56px; padding: 0 64px; }
  .split .points { flex: 1; }
  /* 拡張のパネルはページの右下に固定で出る。ここでは置き場所だけ変える */
  .panel-stage { flex: none; width: 520px; display: flex; justify-content: center; }
  .panel-stage .azr-panel { position: static; max-height: none; zoom: 1.45; box-shadow: 0 10px 36px rgba(15, 17, 17, .22); }
`;

const PANEL_CSS = css('src/styles/common.css') + css('src/styles/cart.css');

// 1行に収まるまで見出しの文字を縮める
const FIT = `<script>{const h=document.querySelector('.band h1');let f=36;while(h.scrollWidth>1152&&f>20){f--;h.style.fontSize=f+'px'}}</script>`;

const points = (list) => `<ul class="points">${list.map(([a, b]) => `<li>${a}<small>${b}</small></li>`).join('')}</ul>`;
const band = ([h1, p], badge = '') => `<div class="band${badge ? " has-site" : ""}"><h1>${badge}${h1}</h1><p>${p}</p>${badge ? FIT : ''}</div>`;

const SITE = {
  ja: { rakuten: '楽天市場', amazon: 'Amazon.co.jp', yahoo: 'Yahoo!ショッピング', added: '✦ この拡張機能が追加' },
  en: { rakuten: 'Rakuten', amazon: 'Amazon', yahoo: 'Yahoo! Shopping', added: '✦ Added by this extension' },
  zh_CN: { rakuten: '乐天', amazon: '亚马逊', yahoo: 'Yahoo!购物', added: '✦ 此扩展程序新增' },
  zh_TW: { rakuten: '樂天', amazon: '亞馬遜', yahoo: 'Yahoo!購物', added: '✦ 此擴充功能新增' },
  ko: { rakuten: '라쿠텐', amazon: '아마존', yahoo: 'Yahoo! 쇼핑', added: '✦ 이 확장 프로그램이 추가' },
  vi: { rakuten: 'Rakuten', amazon: 'Amazon', yahoo: 'Yahoo! Shopping', added: '✦ Tiện ích này thêm vào' },
  id: { rakuten: 'Rakuten', amazon: 'Amazon', yahoo: 'Yahoo! Shopping', added: '✦ Ditambahkan ekstensi ini' },
};

const slides = (lang) => {
  const T = TEXT[lang];
  const raw = (name) => pathToFileURL(join(RAW, lang, name)).href;
  const { cart, co } = T;
  const yahooAdded = (() => {
    try { return JSON.parse(readFileSync(join(RAW, lang, 'yahoo.json'), 'utf8')); } catch { return { left: 0, top: 0, width: 0, height: 0 }; }
  })();
  const rakutenBadge = `<span class="site">${SITE[lang].rakuten}${lang === 'ja' || lang.startsWith('zh') ? '：' : ': '}</span>`;
  return {
    'screenshot-1': `
    <div class="slide">
      ${band(T.s1)}
      <div class="window"><span class="site-badge is-rakuten">${SITE[lang].rakuten}</span><img src="${raw('item.png')}"></div>
    </div>`,

    'screenshot-2': `
    <div class="slide">
      ${band(T.s2)}
      <div class="window"><span class="site-badge is-amazon">${SITE[lang].amazon}</span>
        <div class="shot"><img src="${raw('amazon.png')}">
          <div class="added" style="left:51.2%;top:47.4%;width:29%;height:19.6%"><span class="added-label">${SITE[lang].added}</span></div>
        </div>
      </div>
    </div>`,

    'screenshot-3': `
    <div class="slide">
      ${band(T.s6)}
      <div class="window"><span class="site-badge is-yahoo">${SITE[lang].yahoo}</span>
        <div class="shot"><img src="${raw('yahoo.png')}">
          <div class="added" style="left:${yahooAdded.left}%;top:${yahooAdded.top}%;width:${yahooAdded.width}%;height:${yahooAdded.height}%"><span class="added-label">${SITE[lang].added}</span></div>
        </div>
      </div>
    </div>`,

    'screenshot-4': `
    <div class="slide">
      ${band(T.s34, rakutenBadge)}
      <div class="split is-pair">
        <div class="panel-stage">
          <div class="azr-panel azr-cart-panel">
            <div class="azr-panel-head"><span class="azr-panel-title">${cart.title}</span><button class="azr-panel-close">×</button></div>
            <div class="azr-panel-body">
              <div class="azr-total-row is-main"><span>${cart.items}</span><strong>${cart.v1}</strong></div>
              <div class="azr-total-row"><span>${cart.ship}</span><span>${cart.v2}</span></div>
              <div class="azr-total-row is-grand"><span>${cart.pay}</span><strong>${cart.v3}</strong></div>
              <div class="azr-total-row is-point"><span>${cart.pts}</span><span>1,537pt</span></div>
              <div class="azr-total-row is-effective"><span>${cart.after}</span><strong>${cart.v4}</strong></div>
              <details class="azr-breakdown" open>
                <summary>${cart.by}</summary>
                <ul>
                  ${cart.shops.map((n, i) => `<li><span class="azr-shop-name">${n}</span><span class="azr-shop-amount">${cart.amounts[i]}</span></li>`).join('')}
                </ul>
              </details>
            </div>
          </div>
        </div>
        <div class="panel-stage">
          <div class="azr-panel azr-checkout-panel">
            <div class="azr-panel-head"><span class="azr-panel-title">${co.title}</span><button class="azr-panel-close">×</button></div>
            <div class="azr-panel-body">
              <div class="azr-total-row is-grand"><span>${co.now}</span><strong>${co.v1}</strong></div>
              <div class="azr-coupon-status">${co.note}</div>
              <details class="azr-breakdown" open>
                <summary>${co.usable}</summary>
                <ul>
                  ${co.rows.map(([n, v]) => `<li><span class="azr-shop-name">${n}</span><span>${v}</span></li>`).join('')}
                </ul>
              </details>
            </div>
          </div>
        </div>
      </div>
    </div>`,

    'screenshot-5': `
    <div class="slide">
      ${band(T.s5, rakutenBadge)}
      <div class="split">
        ${points(T.s5p)}
        <div class="panel-stage"><img class="popup" src="${raw('popup.png')}"></div>
      </div>
    </div>`,

    'promo-small': `
    <div class="tile small">
      <img class="logo" src="${icon}">
      <div class="name">Amazonize Rakuten</div>
      <div class="tag">${T.tag}</div>
    </div>`,

    'promo-marquee': `
    <div class="tile marquee">
      <div class="copy">
        <img class="logo" src="${icon}">
        <div class="name">Amazonize Rakuten</div>
        <div class="tag">${T.tag}</div>
        <div class="chips">${T.chips.map((c) => `<span>${c}</span>`).join('')}</div>
      </div>
      <div class="shot"><img src="${raw('item.png')}"></div>
    </div>`
  };
};

const SLIDE_EXTRA_CSS = `
  .popup { width: 400px; border-radius: 10px; box-shadow: 0 10px 36px rgba(15, 17, 17, .22); border: 1px solid #d5d9d9; }

  .tile { position: relative; overflow: hidden; color: #fff; background: radial-gradient(120% 140% at 0% 0%, #37475a 0%, #131921 62%); }
  .tile .name { font-weight: 800; letter-spacing: .01em; }
  .tile .tag { color: #febd69; font-weight: 700; }
  .small { width: 440px; height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .small .logo { width: 104px; height: 104px; filter: drop-shadow(0 0 1px rgba(255,255,255,.5)) drop-shadow(0 6px 16px rgba(0,0,0,.45)); }
  .small .name { font-size: 34px; margin-top: 16px; }
  .small .tag { font-size: 19px; margin-top: 6px; }
  .marquee { width: 1400px; height: 560px; display: flex; align-items: center; }
  .marquee .copy { flex: none; width: 660px; padding-left: 80px; }
  .marquee .logo { width: 96px; height: 96px; filter: drop-shadow(0 0 1px rgba(255,255,255,.5)) drop-shadow(0 6px 16px rgba(0,0,0,.45)); }
  .marquee .name { font-size: 50px; margin-top: 18px; white-space: nowrap; }
  .marquee .tag { font-size: 28px; margin-top: 8px; }
  .marquee .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; }
  .marquee .chips span { font-size: 17px; font-weight: 600; padding: 6px 14px; border-radius: 999px; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.22); }
  .marquee .shot { position: absolute; left: 700px; top: 64px; width: 820px; border-radius: 12px; overflow: hidden; box-shadow: 0 24px 60px rgba(0,0,0,.5); transform: rotate(-2deg); transform-origin: left top; }
  .marquee .shot img { display: block; width: 100%; }
`;

async function compose(lang) {
  const SHOTS = join(ASSETS, 'locales', lang, 'screenshots');
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(RAW, lang), { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const head = `<meta charset="utf-8">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${FONT[lang].replace(/ /g, "+")}:wght@400;500;600;700;800&display=block">
      <style>:root { --font: "${FONT[lang]}"; }${PANEL_CSS}${BASE_CSS}${SLIDE_EXTRA_CSS}</style>`;
    for (const [name, body] of Object.entries(slides(lang))) {
      const promo = name.startsWith('promo-');
      if (promo && lang !== 'ja') continue; // タイルは既定の言語（日本語）の1組だけ
      const size = name === 'promo-small' ? [440, 280] : name === 'promo-marquee' ? [1400, 560] : [1280, 800];
      const file = name === 'promo-small' ? join(ASSETS, 'promo-tile-440x280.jpg')
        : name === 'promo-marquee' ? join(ASSETS, 'marquee-1400x560.jpg')
        : join(SHOTS, `0${name.slice(-1)}.jpg`);
      await page.setViewportSize({ width: size[0], height: size[1] });
      // 撮った画像を file: で読むので、setContent（about:blank）ではなくファイルとして開く
      const html = join(RAW, lang, `${name}.html`);
      writeFileSync(html, `<!doctype html><html lang="${lang}"><head>${head}</head><body>${body}</body></html>`);
      await page.goto(pathToFileURL(html).href, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: file, type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: size[0], height: size[1] } });
      console.log(file);
    }

    // ストア用アイコン: 128pxのうち絵は96px、周りに16pxの透明な余白（ストアのガイドライン）
    await page.setViewportSize({ width: 128, height: 128 });
    const html = join(RAW, lang, 'store-icon.html');
    writeFileSync(html, `<style>html,body{margin:0;background:transparent}img{display:block;width:96px;height:96px;margin:16px}</style><img src="${icon}">`);
    await page.goto(pathToFileURL(html).href);
    await page.waitForFunction(() => document.querySelector('img').complete);
    await page.screenshot({ path: join(ASSETS, 'icon.png'), omitBackground: true });
    console.log('store/assets/icon.png');
  } finally {
    await browser.close();
  }
}

const [cmd] = process.argv.slice(2);
for (const lang of LANGS) {
  if (cmd !== 'compose') await shoot(lang);
  await compose(lang);
}
