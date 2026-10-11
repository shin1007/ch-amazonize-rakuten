/* 楽天の商品名からAmazonを引く部分。
 *
 * 宣伝だらけの商品名から検索語を作り、検索結果のHTMLから商品を拾い、どれが同じ商品かを決める。
 * ここが外れると、違う商品の値段を「Amazonでは」と出してしまう。
 *
 * 検索結果のHTMLは、2026年9月に www.amazon.co.jp の検索結果から写した形
 * （広告の枠のAdHolder・商品名のaria-label・販売価格の後ろに続く参考価格）。
 * 商品名は README の「実機での検証状況」と同じ商品のもの。
 *
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAZR, loadServiceWorker } from './load.mjs';

const AZR = loadAZR(['src/lib/amazon-match.js']);
const { normalizeTitle, buildQuery, scoreMatch, isJan, sizeTokens, matchLabel } = AZR.amazon;

/* 商品名から宣伝を落とす --------------------------------------------------- */

test('煽り文句（＼…／）と宣伝の括弧を落とす', () => {
  const title = '＼9/4～9/11限定ポイント15倍！／［サンプル付き］【公式】ラ・カスタ アロマエステ シャンプー 〈詰替用 570ml〉';
  assert.equal(normalizeTitle(title), 'ラ カスタ アロマエステ シャンプー 詰替用 570ml');
});

test('商品を言い当てている括弧は中身を残す', () => {
  assert.match(normalizeTitle('シャンプー（詰め替え 400ml）'), /詰め替え 400ml/);
});

test('金額・日付・倍率の入った括弧も宣伝として落とす', () => {
  assert.equal(normalizeTitle('【3980円以上送料無料】【9月11日まで】[10倍]入浴剤 20錠'), '入浴剤 20錠');
});

test('<br> で改行する店舗の商品名も1行にする', () => {
  assert.equal(normalizeTitle('YOLU シャンプー<br>ヨル'), 'YOLU シャンプー ヨル');
});

test('検索語は頭から数語だけ使う（長いとAmazonは何も返さない）', () => {
  const title = '【ポイントアップ中】[医薬部外品]スカルプD 薬用スカルプシャンプー 350ml 頭皮タイプ別3種+ニオイ・かゆみ/フケ';
  const q = buildQuery(title);
  assert.ok(q.startsWith('スカルプD 薬用スカルプシャンプー 350ml'));
  assert.ok(q.length <= 60, `検索語が長すぎる: ${q}`);
  assert.ok(q.split(' ').length <= 8);
});

/* JAN ---------------------------------------------------------------------- */

test('JANはチェックディジットまで見る（店舗の品番と取り違えない）', () => {
  assert.equal(isJan('4580688635054'), true);   // 実際の商品のJAN
  assert.equal(isJan('4580688635055'), false);  // 1桁違い
  assert.equal(isJan('648226'), false);         // 店舗の品番
  assert.equal(isJan(''), false);
  assert.equal(isJan(null), false);
});

/* 同じ商品かどうか --------------------------------------------------------- */

test('容量が違うものは大きく下げる（同じ名前の別容量を掴まない）', () => {
  const rakuten = '【公式】ラ・カスタ アロマエステ シャンプー 570ml';
  const same = scoreMatch(rakuten, 'ラ・カスタ アロマエステ ヘアソープ 570ml 詰替用');
  const other = scoreMatch(rakuten, 'ラ・カスタ アロマエステ ヘアソープ 300ml');
  assert.ok(same > other * 2, `同容量 ${same} / 別容量 ${other}`);
});

test('数量の語を拾う', () => {
  assert.equal(sizeTokens('シャンプー 350ml 2本セット').join(','), '350ml,2本');
});

test('短い語だけ重なる別ブランドより、商品名を言い当てている方が上に来る', () => {
  // 「薬用」「頭皮」「フケ」はどのシャンプーにも出てくる。語の数だけで見ると、この2つが同点になった。
  const rakuten = '【ポイントアップ中】[医薬部外品]スカルプD 薬用スカルプシャンプー 350ml 頭皮タイプ別3種+ニオイ・かゆみ/フケ';
  const same = scoreMatch(rakuten, '[医薬部外品] アンファー (ANGFA) スカルプD シャンプー ダンドラフオイリー 350ml 男性用 薬用 スカルプシャンプー フケ かゆみ 脂性肌用');
  const other = scoreMatch(rakuten, 'h&s scalp ドライスカルプ [頭皮ケア・フケかゆみ] 薬用シャンプー ポンプ 350mL 【医薬部外品】');
  assert.ok(same > other, `本物 ${same} / 別ブランド ${other}`);
});

test('ブランド名（先頭の語）が合っている方を選ぶ', () => {
  // h&s の方が「薬用」「頭皮」「フケ」「350ml」と数は重なるが、スカルプDではない。
  // 「スカルプD」を「スカルプ」と「D」に割ると、h&s の「ドライスカルプ」にも当たってしまう。
  const rakuten = '【ポイントアップ中】[医薬部外品]スカルプD 薬用スカルプシャンプー 350ml 頭皮タイプ別3種+ニオイ・かゆみ/フケ';
  const same = scoreMatch(rakuten, 'スカルプD シャンプー メンズ オイリー 脂性肌用 ボリュームアップ ノンシリコン 医薬部外品 350ml アンファー');
  const other = scoreMatch(rakuten, 'h&s scalp ドライスカルプ [頭皮ケア・フケかゆみ] 薬用シャンプー ポンプ 350mL 【医薬部外品】');
  assert.ok(same > other, `スカルプD ${same} / h&s ${other}`);
  assert.ok(other < 0.3, `別ブランドが候補に残る: ${other}`);
});

test('関係のない商品は0点に近い', () => {
  assert.ok(scoreMatch('スカルプD 薬用スカルプシャンプー 350ml', 'ソニー ワイヤレスイヤホン WF-1000XM5') < 0.3);
});

/* 画面に出す見出し --------------------------------------------------------- */

test('JANで引いたものは「似た商品」ではなく同じ商品', () => {
  const r = matchLabel({ byJan: true, score: 0.25, variants: 3 });
  assert.equal(r.label, 'の同じ商品');
  assert.equal(r.badge, 'JANコード一致');
  assert.equal(r.sure, true);
});

test('名前で引いて重なりが厚ければ、そのまま価格として出す', () => {
  assert.deepEqual({ ...matchLabel({ score: 0.6 }) }, { label: 'での価格', badge: null, sure: true });
});

test('重なりが薄い、または選択肢のある商品は「似た商品（参考）」', () => {
  assert.equal(matchLabel({ score: 0.35 }).label, 'の似た商品');
  assert.equal(matchLabel({ score: 0.9, variants: 2 }).badge, '参考');
});

/* 検索結果のHTMLから商品を拾う --------------------------------------------- */

/** 実機の検索結果と同じ形の枠を作る。ad:true は広告（AdHolder）。 */
function result({ asin, title, price, listPrice, rating, count, ad = false }) {
  return `<div role="listitem" data-asin="${asin}" data-index="3" data-uuid="u-${asin}" id="u-${asin}" data-component-type="s-search-result" class="sg-col-4-of-4 s-result-item s-asin${ad ? ' AdHolder' : ''} sg-col">
  <span data-component-type="s-product-image"><a class="a-link-normal" href="/dp/${asin}"><img class="s-image" src="https://m.media-amazon.com/images/I/${asin}._AC_UL320_.jpg" alt=""></a></span>
  <h2 aria-label="${title}" class="a-size-base-plus a-spacing-none a-color-base a-text-normal"><span>${title}</span></h2>
  <div class="a-row"><a class="a-link-normal" aria-label="${count}件のレビューから5つ星のうち${rating}と評価されました"><i class="a-icon a-icon-star-small"><span class="a-icon-alt">5つ星のうち${rating}</span></i></a>
  <a class="a-link-normal s-underline-text s-link-style"><span class="a-size-base s-underline-text">(${count})</span></a></div>
  <div data-cy="price-recipe"><a class="a-link-normal" href="/dp/${asin}"><span class="a-price" data-a-size="l" data-a-color="price"><span class="a-offscreen">￥${price}</span><span aria-hidden="true"><span class="a-price-symbol">￥</span><span class="a-price-whole">${price}</span></span></span>
  <span class="a-size-base a-color-base">(<span class="a-price a-text-price"><span class="a-offscreen">￥${listPrice}</span></span>)</span></a></div>
</div>`;
}

const SEARCH_HTML = `<!doctype html><html><body><div class="s-main-slot">
${result({ asin: 'B00AD00001', title: '別メーカーの育毛シャンプー 500ml', price: '9,800', listPrice: '12,000', rating: '3.9', count: '12', ad: true })}
${result({ asin: 'B0BFBBD71R', title: 'スカルプD シャンプー メンズ つけかえ用 ストロングオイリー 超脂性肌用 アミノ酸 日本製 医薬部外品 350ml アンファー', price: '4,300', listPrice: '5,500', rating: '4.4', count: '157' })}
${result({ asin: 'B0DVT1XQFK', title: 'スカルプD ネクストプラス シャンプー メンズ オイリー 詰め替え 300mL', price: '1,793', listPrice: '2,200', rating: '4.3', count: '214' })}
</div></body></html>`;

const sw = loadServiceWorker();

test('広告の枠（AdHolder）は外す', () => {
  const items = sw.parseAmazonSearch(SEARCH_HTML);
  // 配列は service worker 側（別のrealm）のものなので、中身を文字にして比べる
  assert.equal(items.map((i) => i.asin).join(','), 'B0BFBBD71R,B0DVT1XQFK');
});

/** 実機の見出し。「結果」の後に本来の検索結果、「その他の結果」の後に一致しなかった商品が続く。 */
const header = (text) => `<span data-component-type="s-messaging-widget-results-header" class="rush-component">
  <div class="a-section a-spacing-none s-messaging-widget-results-header"><h2 class="a-size-medium-plus a-spacing-none a-color-base a-text-bold">${text}</h2></div></span>`;

const OTHER_RESULTS_HTML = `<!doctype html><html><body><div class="s-main-slot">
${header('結果')}
${result({ asin: 'B0BFBBD71R', title: 'スカルプD シャンプー メンズ つけかえ用 ストロングオイリー 350ml アンファー', price: '4,300', listPrice: '5,500', rating: '4.4', count: '157' })}
${header('その他の結果')}
${result({ asin: 'B0OTHER001', title: 'まったく別の入浴剤 20錠', price: '599', listPrice: '800', rating: '4.0', count: '30' })}
</div></body></html>`;

test('「その他の結果」から先は拾わない（本人の検索結果には出てこない商品）', () => {
  const items = sw.parseAmazonSearch(OTHER_RESULTS_HTML);
  assert.equal(items.map((i) => i.asin).join(','), 'B0BFBBD71R');
});

test('「結果」が空で「その他の結果」しか無いページは、読み直さずに「見つからない」', async () => {
  const calls = [];
  const onlyOther = `<!doctype html><html><body><div class="s-main-slot">
${header('その他の結果')}
${result({ asin: 'B0OTHER001', title: 'まったく別の入浴剤 20錠', price: '599', listPrice: '800', rating: '4.0', count: '30' })}
</div></body></html>`;
  const storage = {};
  const s = loadServiceWorker({ fetch: stubFetch(onlyOther, calls), storage });
  const res = await s.amazonPrice({ title: '温泡 炭酸バブルで発泡入浴 5個セット 入浴剤' });
  assert.equal(res.status, 'none');
  assert.equal(res.empty, undefined);   // 応答の不調ではないので読み直さない
  assert.equal(calls.length, 1);
  assert.ok(storage.azrAmazon, '「無い」という答えは覚えてよい');
});

test('AdHolder が無くても、商品名が「スポンサー広告 -」で始まる枠は外す', () => {
  const sponsored = result({
    asin: 'B00AD00002', title: 'スポンサー広告 - 別メーカーの育毛シャンプー 500ml',
    price: '9,800', listPrice: '12,000', rating: '3.9', count: '12'
  });
  const items = sw.parseAmazonSearch(`<div class="s-main-slot">${sponsored}${SEARCH_HTML}</div>`);
  assert.ok(!items.some((i) => i.asin === 'B00AD00002'), '広告を拾っている');
});

test('価格は販売価格を取る（後ろに続く参考価格ではない）', () => {
  const [item] = sw.parseAmazonSearch(SEARCH_HTML);
  assert.equal(item.price, 4300);
  assert.equal(item.rating, 4.4);
  assert.equal(item.count, 157);
  assert.equal(item.url, 'https://www.amazon.co.jp/dp/B0BFBBD71R/');
  assert.match(item.image, /^https:\/\/m\.media-amazon\.com\//);
  assert.match(item.title, /^スカルプD シャンプー メンズ つけかえ用/);
});

test('人手の閲覧に見えないと弾かれるページを見分ける', () => {
  assert.equal(sw.amazonBlocked('<html><body>...validateCaptcha...</body></html>'), true);
  assert.equal(sw.amazonBlocked(SEARCH_HTML), false);
});

/* 検索から1件を選ぶまで ----------------------------------------------------- */

/** 常に同じ検索結果を返すネットワーク */
function stubFetch(html, calls = []) {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => html };
  };
}

test('JANがあるときはJANで引き、広告を除いた先頭を採る', async () => {
  const calls = [];
  const s = loadServiceWorker({ fetch: stubFetch(SEARCH_HTML, calls) });
  const res = await s.amazonLookup({ title: 'スカルプD 薬用スカルプシャンプー 350ml', jan: '4580688635054' });
  assert.equal(res.status, 'ok');
  assert.equal(res.byJan, true);
  assert.equal(res.item.asin, 'B0BFBBD71R');
  assert.match(calls[0], /k=4580688635054/);
});

test('JANが無いときは商品名がいちばん重なるものを選ぶ', async () => {
  const s = loadServiceWorker({ fetch: stubFetch(SEARCH_HTML) });
  const res = await s.amazonLookup({ title: 'スカルプD シャンプー つけかえ用 ストロングオイリー 350ml' });
  assert.equal(res.status, 'ok');
  assert.equal(res.byJan, false);
  assert.equal(res.item.asin, 'B0BFBBD71R');
  assert.ok(res.item.score >= 0.5, `重なりが低い: ${res.item.score}`);
});

test('どれも似ていなければ「見つからない」（違う商品の値段を出さない）', async () => {
  const s = loadServiceWorker({ fetch: stubFetch(SEARCH_HTML) });
  const res = await s.amazonLookup({ title: 'ソニー ワイヤレスイヤホン WF-1000XM5 ブラック' });
  assert.equal(res.status, 'none');
  // 表示するリンクは中継ページ経由（タグは中継側で付く）
  assert.ok(res.searchUrl.startsWith('https://nesage.party/go?q='));
});

test('弾かれたときは blocked を返す（検索への導線だけ出す）', async () => {
  const s = loadServiceWorker({ fetch: async () => ({ ok: true, status: 200, text: async () => 'validateCaptcha' }) });
  const res = await s.amazonLookup({ title: 'スカルプD シャンプー 350ml' });
  assert.equal(res.status, 'blocked');
});

test('同じ商品を開き直しても読みに行かない（結果は覚えておく）', async () => {
  const calls = [];
  const storage = {};
  const s = loadServiceWorker({ fetch: stubFetch(SEARCH_HTML, calls), storage });
  const args = { title: 'スカルプD シャンプー つけかえ用 ストロングオイリー 350ml', jan: '4580688635054' };
  const first = await s.amazonPrice(args);
  const second = await s.amazonPrice(args);
  assert.equal(calls.length, 1);
  assert.equal(second.cached, true);
  assert.equal(second.item.asin, first.item.asin);
  assert.ok(storage.azrAmazon['v3:jan:4580688635054']);
});

const EMPTY_HTML = '<!doctype html><html><body><div class="s-main-slot"></div></body></html>';

test('商品の枠が無いページが返ったら、1度だけ読み直す', async () => {
  const calls = [];
  // 1回目は空、2回目は普通の検索結果
  let first = true;
  const s = loadServiceWorker({
    fetch: async (url) => {
      calls.push(url);
      const html = first ? EMPTY_HTML : SEARCH_HTML;
      first = false;
      return { ok: true, status: 200, text: async () => html };
    }
  });
  const res = await s.amazonLookup({ title: 'スカルプD シャンプー つけかえ用 ストロングオイリー 350ml' });
  assert.equal(calls.length, 2);
  assert.equal(res.status, 'ok');
  assert.equal(res.item.asin, 'B0BFBBD71R');
});

test('読み直しても空なら、その結果は覚えない（Amazonに無いとは限らない）', async () => {
  const storage = {};
  const calls = [];
  const s = loadServiceWorker({ fetch: stubFetch(EMPTY_HTML, calls), storage });
  const res = await s.amazonPrice({ title: 'スカルプD シャンプー 350ml' });
  assert.equal(res.status, 'none');
  assert.equal(res.empty, true);
  assert.deepEqual(storage, {});
  await s.amazonPrice({ title: 'スカルプD シャンプー 350ml' });
  assert.equal(calls.length, 4); // 2回とも読み直しているので4
});

test('弾かれた結果は覚えない（次に開いたときは読みに行く）', async () => {
  const storage = {};
  const s = loadServiceWorker({ fetch: async () => ({ ok: false, status: 503, text: async () => '' }), storage });
  const res = await s.amazonPrice({ title: 'スカルプD シャンプー 350ml' });
  assert.equal(res.status, 'blocked');
  assert.deepEqual(storage, {});
});

/* まとめ売りの数 ----------------------------------------------------------- */

test('まとめ売りの数を商品名から拾う（宣伝の括弧の中も見る）。書いていなければ1', () => {
  const { packCount } = AZR.amazon;
  assert.equal(packCount('【2点セット【Amazon.co.jp限定】】バッファロー USB3.2(Gen1)対応 LANアダプター'), 2);
  assert.equal(packCount('バッファロー（Buffalo） Giga対応 Type-A USB 3.2 (Gen1)用 LANアダプター LUA6-U3-AGTE-BK'), 1);
  assert.equal(packCount('お茶 500ml×24本'), 24);
  assert.equal(packCount('温泡 5個セット（20錠×5個入）'), 5);
  assert.equal(packCount('ティッシュ 5箱組'), 5);
  assert.equal(packCount('USB-C ケーブル 1m 2.4A'), 1);
  assert.equal(packCount('モニター 1920x1080 27インチ'), 1);
});

test('1個売りに2点セットが当たったら、名前の一致度を下げ、JANが合っていても値段は比べない', () => {
  const one = 'バッファロー Giga対応 Type-A USB3.2(Gen1) LANアダプター LUA6-U3-AGTE-BK';
  const two = '【2点セット【Amazon.co.jp限定】】バッファロー Giga対応 Type-A USB3.2(Gen1) LANアダプター LUA6-U3-AGTE-BK';
  assert.ok(scoreMatch(one, two) < scoreMatch(one, one) / 2 + 0.01);
  const r = matchLabel({ byJan: true, pack: AZR.amazon.samePack(one, two) });
  assert.equal(r.sure, false);
  assert.equal(r.badge, 'セット数が違う');
  assert.equal(matchLabel({ byJan: true, pack: AZR.amazon.samePack(one, one) }).sure, true);
});
