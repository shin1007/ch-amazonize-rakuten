/* Amazonize Rakuten - セルフチェック（開発版だけで動く）
 *
 * 楽天やAmazonのページの形が変わると、機能は黙って何もしなくなる。普段の利用のついでに
 * 各機能が「期待どおりにできたか」を報告し、失敗をアイコンのバッジとポップアップに出す。
 * ストアから入れた拡張（manifest に update_url がある）では何もしない。
 *
 * 報告は2種類。
 *   check(id, ok, detail) … 成否のある確認。最後の結果が失敗なら「失敗中」。次に成功すれば消える
 *   event(id, detail)     … 起きたことの記録（例外・AZR.warn の警告）。ポップアップで既読にするまで数える
 *   expect(id, fn)        … fn() が真になるまで少し待ってから check する（ページが後から描く要素向け）
 * 記録は service worker が chrome.storage.local の azrHealth に書く。ブラウザの外へは出さない。
 * このファイルは content script・service worker・ポップアップのどれでも読む。
 */
(() => {
  const g = typeof window !== 'undefined' ? window : self;
  const AZR = (g.AZR = g.AZR || {});
  if (AZR.health) return;

  let dev = false;
  try { dev = !('update_url' in chrome.runtime.getManifest()); } catch { /* chrome API が無い（テストなど） */ }
  const inPage = typeof location !== 'undefined' && /^https?:/.test(location.protocol);

  /** 確認の説明（ポップアップに出す）。module: / error: / warn: で始まるものは id から作る */
  const LABELS = {
    'item.appData': '楽天 商品ページ: 商品データのJSON（#item-page-app-data）を読めた',
    'item.titlePrice': '楽天 商品ページ: 商品名と価格を取れた（取れないと元のページのまま）',
    'item.buybox': '楽天 商品ページ: 購入エリアを移設できた',
    'item.video': '楽天 商品ページ: 動画プレーヤーを移設できた',
    'item.ratings': '楽天 商品ページ: 商品・ショップの評価を取れた',
    'rakuten.reviewPage': '楽天 レビューのページから評価を読めた',
    'rakuten.floatingCouponApi': '楽天 フローティングクーポンのAPIが読める形で答えた',
    'rakuten.couponDetailsApi': '楽天 クーポン内容のAPIが読める形で答えた',
    'rakuten.couponAcquireApi': '楽天 クーポン獲得のAPIが想定どおりの応答をした',
    'rakuten.entryApi': '楽天 エントリーのAPIが読める形で答えた',
    'rakuten.topCampaignLinks': '楽天 トップページからキャンペーンのリンクを拾えた',
    'top.campaignLinks': '楽天 トップページ: キャンペーンのリンクを見つけられた（自動スキャンに使う）',
    'orders.found': '楽天 購入履歴: 「配送状況を確認」の折りたたみを見つけられた',
    'orders.expanded': '楽天 購入履歴: 「配送状況を確認」を開けた',
    'search.items': '楽天 検索結果: 商品の枠を見つけられた（広告の判定に使う）',
    'cart.state': '楽天 かご: かごの状態（__INITIAL_STATE__）を受け取れた',
    'checkout.state': '楽天 注文確認: 注文の状態を受け取れた',
    'checkout.apply': '楽天 注文確認: クーポンを適用できた',
    'checkout.verify': '楽天 注文確認: 自動で切り替えた後の割引額を確かめられた',
    'checkout.estimate': '楽天 注文確認: 自動で切り替えたクーポンの割引が推測どおりだった',
    'checkout.revert': '楽天 注文確認: 割引が減ったので前のクーポンに戻せた',
    'campaign.judge': '楽天 キャンペーン: エントリーできるか判定できた',
    'coupon.grabResult': '楽天 クーポン獲得ページ: 獲得の結果を読めた',
    'amazon.searchFetch': 'Amazon 検索結果のページを取れた（弾かれていない）',
    'amazon.searchParse': 'Amazon 検索結果から商品を読み取れた',
    'amazon.productTitle': 'Amazon 商品ページ: 商品名（#productTitle）を見つけられた',
    'amazon.price': 'Amazon 商品ページ: 価格を見つけられた',
    'amazon.slotPlace': 'Amazon 商品ページ: 楽天の欄を価格の下に置けた',
    'amazon.wishlistButton': 'Amazon 商品ページ: ほしい物リストのボタンを見つけられた',
    'amazon.wishlistAdded': 'Amazon 商品ページ: ほしい物リストへの追加を検出できた',
    'amazon.wishlistId': 'Amazon ほしい物リスト: リストのIDを取れた',
    'amazon.galleryThumbs': 'Amazon 商品ページ: 商品画像のサムネイル列（#altImages）を見つけられた',
    'amazon.galleryStep': 'Amazon 商品ページ: 左右キーで商品画像を切り替えられた',
    'amazon.reviewMediaNav': 'Amazon レビューの写真・動画: 左右キーで前後へ送れた',
    'amazon.reviewSearchMove': 'Amazon 商品ページ: レビュー検索・ルーファスの欄をレビューの左ペインへ移せた',
    'relay.rakutenSearch': '楽天検索の中継サーバーが答えた',
    'relay.yahooSearch': 'Yahoo!ショッピング検索の中継サーバーが答えた',
    'yahoo.itemData': 'Yahoo!ショッピング 商品ページ: 商品データ（__NEXT_DATA__）を読めた',
    'yahoo.pricePlace': 'Yahoo!ショッピング 商品ページ: 価格の欄（#prcdsp）を見つけられた',
    'yahoo.galleryThumbs': 'Yahoo!ショッピング 商品ページ: 商品画像のサムネイル列を見つけられた',
    'yahoo.galleryStep': 'Yahoo!ショッピング 商品ページ: 左右キーで商品画像を切り替えられた',
    'yahoo.searchItems': 'Yahoo!ショッピング 検索結果: 商品の枠を見つけられた'
  };
  const label = (id) => LABELS[id]
    || (id.startsWith('module:') ? `楽天 機能「${id.slice(7)}」が例外なく終わった`
      : id.startsWith('error:') ? `例外: ${id.slice(6)}`
        : id.startsWith('warn:') ? `警告: ${id.slice(5)}` : id);

  const text = (d) => {
    if (d instanceof Error) return d.message;
    if (typeof d === 'string') return d;
    try { return JSON.stringify(d) ?? ''; } catch { return String(d); }
  };

  // 記録する側（service worker）は setSink で自分の記録処理に差し替える。ほかからは service worker へ送る
  let sink = (report) => {
    try { chrome.runtime.sendMessage({ type: 'azr:health', report }).catch(() => {}); } catch { /* 拡張が更新された */ }
  };
  // 前回と同じ結果は送らない（描き直しのたびに呼ばれる箇所がある）
  const last = new Map();

  function send(kind, id, ok, detail) {
    if (!dev) return;
    const d = ok ? '' : text(detail).slice(0, 300);
    const key = `${ok}|${d}`;
    if (last.get(`${kind}|${id}`) === key) return;
    last.set(`${kind}|${id}`, key);
    sink({ kind, id, ok, detail: d, url: inPage ? location.href.split('#')[0].slice(0, 300) : '', at: Date.now() });
  }

  const check = (id, ok, detail = '') => send('check', id, Boolean(ok), detail);
  const event = (id, detail = '') => send('event', id, false, detail);

  function expect(id, fn, { timeout = 15000, detail = '' } = {}) {
    if (!dev) return;
    const until = Date.now() + timeout;
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { return check(id, false, e); }
      if (v) return check(id, true);
      if (Date.now() >= until) return check(id, false, detail || `${timeout / 1000}秒待っても見つからない`);
      setTimeout(tick, 500);
    };
    tick();
  }

  // 拡張のスクリプトで起きた例外と、AZR.warn の警告も記録する
  if (dev && inPage) {
    const file = (s) => String(s || '').match(/chrome-extension:\/\/[^/]+\/([^:?#)\s]+)/)?.[1];
    addEventListener('error', (e) => {
      const f = file(e.filename);
      if (f) event(`error:${f}`, `${e.message} (${f}:${e.lineno})`);
    });
    addEventListener('unhandledrejection', (e) => {
      const f = file(e.reason?.stack);
      if (f) event(`error:${f}`, e.reason);
    });
  }
  if (dev && AZR.warn) {
    const warn = AZR.warn;
    AZR.warn = (...args) => {
      warn(...args);
      event(`warn:${text(args[0]).slice(0, 60)}`, args.slice(1).map(text).join(' '));
    };
  }

  AZR.health = { dev, check, event, expect, label, setSink: (fn) => { sink = fn; } };
})();
