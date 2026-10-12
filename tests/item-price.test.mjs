/* 商品ページの「クーポン適用後の価格」。
 *
 * 価格は本人が買うかどうかを決める数字なので、条件を満たさないクーポンを効かせて
 * 実際より安く見せてはいけない。条件（最低購入金額・個数・定期購入限定・上限額）を
 * 満たさないクーポンを落とせているかを、フローティングクーポンの実物の形で確かめる。
 *
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAZR, loadServiceWorker } from './load.mjs';

const AZR = loadAZR([
  'src/lib/settings.js', 'src/lib/i18n.js', 'src/lib/dom.js', 'src/lib/coupon-model.js', 'src/content/item-coupons.js'
]);
const { itemPrice } = AZR.coupons;
const { fromFloating, affectsPrice } = AZR.itemCoupons;

/** 検索APIが返すフローティングクーポン1件（service_worker.js が整えた後の形） */
const floating = (over = {}) => fromFloating({
  getKey: 'K1',
  name: '【テスト店】500円OFFクーポン',
  discount: '500円OFF',
  minSpend: null,
  minUnits: null,
  salesMethod: null,
  acquired: false,
  ...over
});

test('条件の無いクーポンは、そのまま価格から引く', () => {
  const r = itemPrice([floating()], 1680);
  assert.equal(r.discount, 500);
  assert.equal(r.price, 1180);
});

test('最低購入金額に届かない商品には使わない', () => {
  const c = floating({ discount: '700円OFF', minSpend: 4000 });
  assert.equal(itemPrice([c], 3980), null);       // 2個買えば届くが、出しているのは1個の価格
  assert.equal(itemPrice([c], 4000).price, 3300);
});

test('2個以上でないと使えないクーポンは、1個の価格には効かせない', () => {
  assert.equal(itemPrice([floating({ minUnits: 2 })], 1680), null);
  assert.equal(itemPrice([floating({ minUnits: 1 })], 1680).price, 1180);
});

test('定期購入限定のクーポンは、通常購入の価格には効かせない', () => {
  assert.equal(itemPrice([floating({ salesMethod: 'subscription' })], 1680), null);
  assert.equal(itemPrice([floating({ salesMethod: 'normal' })], 1680).price, 1180);
});

test('率OFFの上限は、名前に書かれた「最大」から拾う（APIの条件には入らない）', () => {
  const c = floating({ name: '【テスト店】10%OFF(最大500円)クーポン', discount: '10%OFF' });
  assert.equal(c.cap, 500);
  assert.equal(itemPrice([c], 10000).price, 9500); // 上限が無ければ1,000円引きになってしまう
  assert.equal(itemPrice([c], 1680).price, 1512);  // 168.0 → 168円引き
});

test('名前にだけ条件が書かれているクーポンも、条件として読む', () => {
  const c = floating({ name: '【テスト店】3,000円以上で500円OFFクーポン' });
  assert.equal(c.minSpend, 3000);
  assert.equal(itemPrice([c], 1680), null);
});

test('使えるものが複数あるときは、いちばん安くなる1枚だけを使う', () => {
  const r = itemPrice([
    floating({ getKey: 'A', name: '200円OFF', discount: '200円OFF' }),
    floating({ getKey: 'B', name: '20%OFF', discount: '20%OFF' }),
    floating({ getKey: 'C', name: '1,000円OFF', discount: '1,000円OFF', minSpend: 5000 })
  ], 2000);
  assert.equal(r.discount, 400); // 20%OFF。1,000円OFFは条件未達なので使えない
  assert.equal(r.price, 1600);
});

test('送料無料クーポンは商品の価格を動かさない', () => {
  assert.equal(itemPrice([floating({ name: '送料無料クーポン', discount: '送料無料' })], 1680), null);
});

test('価格に効かせるのは、この商品ページで獲得できるクーポンだけ', () => {
  assert.equal(affectsPrice(floating()), true);
  assert.equal(affectsPrice({ href: 'https://coupon.rakuten.co.jp/get?getkey=abc' }), true);
  // 店舗のお知らせ。対象商品も条件も分からない。
  assert.equal(affectsPrice({ href: 'https://www.rakuten.co.jp/shop/' }), false);
  assert.equal(affectsPrice({ href: null }), false);
});

test('獲得済みと分かっているクーポンは、自動獲得で獲得APIを呼び直さない', async () => {
  const calls = [];
  const storage = {};
  const fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ is_already_acquired: false }) }; };
  const sw = loadServiceWorker({ fetch, storage });
  const url = 'https://coupon.rakuten.co.jp/getCoupon?getkey=ABC-123&rt=';
  assert.equal((await sw.grabCoupon(url, { apiOnly: true })).status, 'acquired');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(storage.azrGotCoupons['ABC-123']);
  assert.equal((await sw.grabCoupon(url, { apiOnly: true })).status, 'already');
  assert.equal(calls.length, 1);
});
