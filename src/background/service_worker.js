/* Amazonize Rakuten - service worker */

// 商品名の正規化と突き合わせ。商品ページと同じ判断を使いたいので、同じファイルを読む。
importScripts("/src/lib/amazon-match.js");
// セルフチェック（開発版だけ）。記録とバッジはこのファイルの末尾
importScripts("/src/lib/health.js");
const health = AZR.health;
// 表示文言の訳（全言語）。content script には入れず、ここから自分の言語の分だけ渡す（i18n.js の loadMessages）
importScripts("/src/lib/i18n-data.js");

// session storage は content script に開かない（以前は開いていた。その設定が残っていれば戻す）。
// content script が要る記録（キャンペーンの自動エントリーを1回にする印）は azr:entryOnce で service worker が持つ。
chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch?.(() => {});

/*
 * 自動で行う操作（クーポンの自動獲得・自動切り替え・キャンペーンの自動エントリー）は、同意を取るまで動かさない。
 * 入れた直後（と、同意の前から使っている人の更新時）に1度だけ、選んでもらうページを開く。
 * 閉じられても、ポップアップに同じページへの案内が出る。
 */
const WELCOME_PAGE = '/src/welcome/welcome.html';
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  try {
    const { consentAt } = await chrome.storage.sync.get({ consentAt: 0 });
    const { azrWelcomeShown } = await chrome.storage.local.get('azrWelcomeShown');
    if (consentAt || azrWelcomeShown) return;
    await chrome.storage.local.set({ azrWelcomeShown: Date.now() });
    await chrome.tabs.create({ url: WELCOME_PAGE });
  } catch (e) {
    console.warn('[AZR] 同意のページを開けない:', e);
  }
});

// Amazonの商品ページのYahoo!の価格は yahooPrice、Yahoo!の商品ページの楽天の価格は yahooItem と一緒だった。
// 分けた設定に、切っていた人の選択を引き継ぐ
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'update') return;
  try {
    const s = await chrome.storage.sync.get(['yahooPrice', 'yahooItem', 'amazonPageYahoo', 'yahooPageRakuten']);
    const patch = {};
    if (s.yahooPrice === false && s.amazonPageYahoo === undefined) patch.amazonPageYahoo = false;
    if (s.yahooItem === false && s.yahooPageRakuten === undefined) patch.yahooPageRakuten = false;
    if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
  } catch { /* 引き継げなくても既定（出す）で動く */ }
});

// 商品ページの欄の「表示の設定」から、設定の画面をタブで開く（content script からは開けない）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'azr:openOptions') chrome.runtime.openOptionsPage().catch(() => {});
});

// 店舗ごとのキー（shop:<店舗>）で持っていた閉店判定は azrShops にまとめた。古いキーを消す
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const all = await chrome.storage.local.get(null);
    const old = Object.keys(all || {}).filter((k) => k.startsWith('shop:'));
    if (old.length) await chrome.storage.local.remove(old);
  } catch { /* 消せなくても動きは変わらない */ }
});

// service worker が止まってスキャンが途中で消えたとき、残りの件数がバッジに残らないようにする
chrome.action.setBadgeText({ text: '' }).catch(() => {});

// 裏のタブはブラウザに実行を絞られるため、獲得ページの遷移が数十秒かかることがある。
// 早すぎる打ち切りで「失敗」と言わないよう、長めに待つ（成功時は数秒で返る）。
const COUPON_TIMEOUT_MS = 45000;

/*
 * service worker は、拡張のイベントもAPIの呼び出しも30秒ほど無いと止められる。
 * 止まるとメモリにある待ち（裏タブの結果・打ち切りのタイマー・スキャンの進み具合）が消え、
 * 裏タブが開いたまま残り、スキャンは途中で終わる。裏タブの1ページは45秒まで待つので、
 * その間にイベントが途切れることがありうる。裏タブを待っている間だけ、20秒ごとに
 * 拡張のAPIを呼んで起こしておく（Chrome 110 以降、APIの呼び出しで止めるまでの時間が延びる）。
 */
const KEEP_ALIVE_MS = 20000;
let awakeHolders = 0;
let keepAliveTimer = null;

async function holdAwake(work) {
  if (awakeHolders++ === 0) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), KEEP_ALIVE_MS);
  }
  try {
    return await work();
  } finally {
    if (--awakeHolders === 0) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }
}

const COUPON_PAGE = /^https:\/\/coupon\.rakuten\.co\.jp\//;
const COUPON_API = 'https://coupon.rakuten.co.jp/api/v2/coupons/';
// ログインや結果不明は本人に見てもらうしかない。それ以外は裏で閉じる。
const KEEP_TAB = new Set(['login', 'unknown', 'timeout']);

/** 獲得ページのURLから getkey を取り出す */
function couponGetKey(url) {
  const m = String(url).match(/[?&]getkey=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/*
 * 獲得ページ（Next.js製）が実際に叩いているのと同じAPIを、そのまま呼ぶ。
 *
 *   PUT /api/v2/coupons/{getkey}/acquire
 *     200        → 本文の is_already_acquired で「獲得」と「獲得済み」を分ける
 *     401        → 未ログイン
 *     400/404/410→ 本文の reason に COUPON_STATUS_INVALID 等の理由コード
 *
 * ここから呼べる理由（実機で確認済み）:
 *   - host_permissions があるので service worker からの fetch はCORSの対象外。
 *     商品ページの content script から直接呼ぶと、このAPIは 403 で弾く。
 *   - 拡張からの fetch には Origin が付かず、SameSite付きのCookieも送られる。
 */
async function acquireByApi(key) {
  const res = await fetch(`${COUPON_API}${encodeURIComponent(key)}/acquire`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  if (res.status === 401) return { ok: false, status: 'login' };

  const data = await res.json().catch(() => null);
  const expected = res.ok || [400, 404, 410].includes(res.status);
  health.check('rakuten.couponAcquireApi', expected, `HTTP ${res.status}`);
  if (res.ok) return { ok: true, status: data?.is_already_acquired ? 'already' : 'acquired' };
  if ([400, 404, 410].includes(res.status)) {
    return { ok: false, status: 'rejected', reason: typeof data?.reason === 'string' ? data.reason : '' };
  }
  return null; // 想定外の応答。呼び出し側でタブ方式に落とす。
}

/** クーポンの内容。認証不要で、名前・割引・獲得済みかどうかが取れる。 */
async function couponDetails(key) {
  const res = await fetch(`${COUPON_API}${encodeURIComponent(key)}/details`, { credentials: 'include' });
  if (!res.ok) {
    health.check('rakuten.couponDetailsApi', false, `HTTP ${res.status}`);
    return null;
  }
  const d = await res.json();
  health.check('rakuten.couponDetailsApi', typeof d?.coupon_name === 'string', '応答に coupon_name が無い');
  return {
    name: d?.coupon_name || '',
    discountType: d?.discount_type ?? null,
    discountFactor: d?.discount_factor ?? null,
    acquired: d?.acquire_status === 'ACQUIRED',
    endDate: d?.coupon_end_date || null
  };
}

/* 商品ページのフローティングクーポン -------------------------------------------
 * 元の商品ページで右下に出る「100円OFF … クーポンを獲得する」の枠。
 * 商品ページのバンドル（item-pc の pc.bundle.js、fetchFloatingCoupon / acquireFloatingCoupon）が
 * 呼んでいるのと同じAPIを、同じ引数で呼ぶ。どちらもJSONP。
 *   GET api.coupon.rakuten.co.jp/search?items=["itemId=…&price=…&shopId=…"]&locId=101&options=["incAcqCond=true"]
 *     → { code, items: [{ coupons: [{ getKey, couponName, discountType, discountFactor, otherConds, acquired, … }] }] }
 *     未ログインだと { code: 2 } だけが返り、クーポンは出ない。
 *   GET api.coupon.rakuten.co.jp/acquireCoupon/json?getKey=…&key=<商品ページ用のキー>
 *     → { code, alreadyAcquired }  code: 1 成功 / 2 未ログイン / 3 期限切れ / 4 配布終了 / 0 失敗 / 9 メンテナンス
 * 商品ページのオリジンから呼ぶと Cookie の扱いがページ次第になるので、service worker から呼ぶ。
 *
 * **このAPIは Referer が商品ページでないと、ログインしていても {"code":2}（未ログイン）を返す。**
 * Cookie は届いていても駄目だった（実機で Referer の有無だけを変えて確認）。拡張からの fetch には
 * Referer が付かず、fetch の referrer 指定も別オリジンは効かないので、ヘッダーの書き換え規則で付ける。
 * 対象はタブに属さない通信（= この service worker からの通信）だけにし、ページの通信には触らない。
 */
const REFERER_RULE_ID = 1;
async function installCouponRefererRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [REFERER_RULE_ID],
      addRules: [{
        id: REFERER_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://item.rakuten.co.jp/' }]
        },
        condition: {
          urlFilter: '||api.coupon.rakuten.co.jp/',
          tabIds: [chrome.tabs.TAB_ID_NONE],
          resourceTypes: ['xmlhttprequest']
        }
      }]
    });
  } catch (e) {
    console.warn('[AZR] Referer の規則を入れられない:', e);
  }
}
// 規則はブラウザを閉じると消えるので、service worker が起きるたびに入れ直す
const refererRuleReady = installCouponRefererRule();

const FLOATING_SEARCH = 'https://api.coupon.rakuten.co.jp/search';
const FLOATING_ACQUIRE = 'https://api.coupon.rakuten.co.jp/acquireCoupon/json';
const FLOATING_ITEM_PAGE_KEY = 'wIIcsUeYctybYOMyuJn8V040KBPNF5ee'; // 商品ページのバンドルに埋め込まれている ITEM_PAGE_KEY
const FLOATING_LOC_ID = '101'; // 同じく COUPON_LOC_ID（PCの商品ページ）

/** JSONPの応答 cb({...}) から中身を取り出す */
async function fetchJsonp(url) {
  await refererRuleReady;
  const u = new URL(url);
  u.searchParams.set('callback', 'azr');
  const res = await fetch(u.href, { credentials: 'include', cache: 'no-cache' });
  if (!res.ok) return null;
  const text = await res.text();
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) return null;
  return JSON.parse(text.slice(start + 1, end));
}

async function floatingCoupons({ itemId, shopId, price, hasSubscription }) {
  const u = new URL(FLOATING_SEARCH);
  u.searchParams.set('items', `["itemId=${itemId}&price=${price}&shopId=${shopId}"]`);
  u.searchParams.set('locId', FLOATING_LOC_ID);
  u.searchParams.set('options', '["incAcqCond=true"]');
  // 定期購入の無い商品では、定期購入専用のクーポンを除く（商品ページと同じ）
  if (!hasSubscription) {
    u.searchParams.set('otherCondFilters', '[{"typeCode": "RS002","startValue": "1","isExcluded": true}]');
  }
  const data = await fetchJsonp(u.href);
  if (!data) {
    health.check('rakuten.floatingCouponApi', false, 'JSONPの応答を読めない');
    return null;
  }
  if (Number(data.code) === 2) return { login: true, coupons: [] };
  health.check('rakuten.floatingCouponApi', Array.isArray(data.items), `items が無い（code: ${data.code}）`);
  const list = Array.isArray(data.items) && Array.isArray(data.items[0]?.coupons) ? data.items[0].coupons : [];
  return {
    login: false,
    coupons: list.filter((c) => c?.getKey).map((c) => {
      const conds = Array.isArray(c.otherConds) ? c.otherConds : [];
      const amount = conds.find((o) => o?.otherCondTypeCd === 'RS003' || o?.otherCondTypeCd === 'RS004');
      const sales = conds.find((o) => o?.otherCondTypeCd === 'RS002')?.startValue;
      return {
        getKey: String(c.getKey),
        name: String(c.couponName || ''),
        // 1: 円引き / 2: %引き
        discount: Number(c.discountType) === 1 ? `${Number(c.discountFactor).toLocaleString('ja-JP')}円OFF` : `${c.discountFactor}%OFF`,
        minSpend: amount?.otherCondTypeCd === 'RS003' ? Number(amount.startValue) || null : null,
        minUnits: amount?.otherCondTypeCd === 'RS004' ? Number(amount.startValue) || null : null,
        salesMethod: sales === '0' ? 'normal' : sales === '1' ? 'subscription' : null,
        endDate: c.couponEndDate || null,
        acquired: Boolean(c.acquired)
      };
    })
  };
}

async function acquireFloatingCoupon(getKey) {
  const u = new URL(FLOATING_ACQUIRE);
  u.searchParams.set('getKey', getKey);
  u.searchParams.set('key', FLOATING_ITEM_PAGE_KEY);
  const data = await fetchJsonp(u.href);
  const code = Number(data?.code);
  if (code === 1) return { ok: true, status: data.alreadyAcquired ? 'already' : 'acquired' };
  if (code === 2) return { ok: false, status: 'login' };
  if (code === 3) return { ok: false, status: 'rejected', reason: 'COUPON_VALIDITY_PERIOD_OVER' };
  if (code === 4) return { ok: false, status: 'rejected', reason: 'COUPON_STATUS_FINISHED' };
  return { ok: false, status: 'error', reason: Number.isFinite(code) ? `CODE_${code}` : '' };
}

/* 商品とショップの評価 -------------------------------------------------------
 * 商品ページのJSONにはレビューの件数しか無く（評価点が入らなくなった）、店舗の評価はどこにも無い。
 * 商品レビューのページは window.__INITIAL_STATE__ に両方を埋め込んでいるので、そこを読む。
 *   "itemInfo":{"itemId":…,"reviewRatings":{"average":4.32,"totalCount":78479,…}
 *   "shopInfo":{"reviewRatings":{"average":4.78,"totalCount":127449,…}
 * 状態全体はJSONとして解析できない形で書かれているので、必要な所だけ切り出す。
 * 1ページ300KB余りあるので、商品ごとに覚えておく。評価は日単位でしか動かない。
 */
const RATINGS_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * 応答の本文を少しずつ読み、enough(読んだ文字列) が true になったら通信を切って、そこまでを返す。
 * レビューやAmazonの検索結果のページは数百KBあるが、要るのは前の方だけなので、全部は受け取らない。
 * 本文を少しずつ読めない応答（テストの差し替えなど）は丸ごと読む。
 */
async function readUntil(res, enough) {
  const reader = res.body?.getReader?.();
  if (!reader) return res.text();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
    if (enough(text)) {
      reader.cancel().catch(() => {});
      return text;
    }
  }
}

/** 'itemInfo' / 'shopInfo' の reviewRatings。楽天自身が出さないもの（shouldBeDisplayed:false）は null。 */
const ratingStart = (html, section) => new RegExp(`"${section}":\\{[^{}]*"reviewRatings":\\{`).exec(html);
const RATING_TAIL = 600;
/** その節の評価を読み切れるところまで届いたか（読み切ったら、ページの残りは読まない） */
const ratingReady = (html, section) => {
  const m = ratingStart(html, section);
  return Boolean(m && html.length >= m.index + m[0].length + RATING_TAIL);
};

function parseRating(html, section) {
  // reviewRatings がその節の直下にあるものだけを拾う。ページには空の "itemInfo":{} も先に出てくるので、
  // 単に次の reviewRatings を探すと、後ろの shopInfo の評価を商品の評価と取り違える。
  const m = ratingStart(html, section);
  if (!m) return undefined;
  // 評価の分布（distribution）が続くが、そこには average / totalCount の名前は出てこない
  const s = html.slice(m.index + m[0].length, m.index + m[0].length + RATING_TAIL);
  if (/"shouldBeDisplayed":false/.test(s)) return null;
  const avg = Number(s.match(/"average":([\d.]+)/)?.[1]);
  const count = Number(s.match(/"totalCount":(\d+)/)?.[1]);
  if (!Number.isFinite(avg) || avg <= 0) return null;
  return { score: Math.round(avg * 100) / 100, count: Number.isFinite(count) ? count : null };
}

/** 商品IDが無ければショップレビューのページで店舗の評価だけ取る */
async function reviewRatings(shopId, itemId) {
  const key = itemId ? `${shopId}_${itemId}` : `${shopId}_${shopId}`;
  const { azrRatings: cache = {} } = await chrome.storage.local.get('azrRatings');
  const now = Date.now();
  const hit = cache[key];
  if (hit && now - hit.at < RATINGS_TTL_MS) return hit.ratings;

  const url = itemId
    ? `https://review.rakuten.co.jp/item/1/${key}/1.1/`
    : `https://review.rakuten.co.jp/shop/4/${key}/1.1/`;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) {
    health.check('rakuten.reviewPage', false, `HTTP ${res.status} ${url}`);
    return null;
  }
  // 商品とショップの評価が両方読めたら、残り（ほとんどがレビュー本文）は受け取らない
  const html = await readUntil(res, (t) => ratingReady(t, 'shopInfo') && (!itemId || ratingReady(t, 'itemInfo')));
  const item = itemId ? parseRating(html, 'itemInfo') : null;
  const shop = parseRating(html, 'shopInfo');
  // どちらも見つからない = ページの形が変わった。覚えずに次も読みに行く。
  health.check('rakuten.reviewPage', item !== undefined || shop !== undefined, `reviewRatings が見つからない ${url}`);
  if (item === undefined && shop === undefined) return null;
  const ratings = { item: item ?? null, shop: shop ?? null };

  // 期限切れはここで捨てる（見た商品の数だけ溜まり続けないように）。
  // 読み直してから書く（複数のタブから同時に来ると、先に書いた分を古い一覧で消すため）
  await saveCacheSerially(async () => {
    const { azrRatings: all = {} } = await chrome.storage.local.get('azrRatings');
    for (const [k, v] of Object.entries(all)) if (now - v.at >= RATINGS_TTL_MS) delete all[k];
    all[key] = { at: now, ratings };
    await chrome.storage.local.set({ azrRatings: all });
  });
  return ratings;
}

/* Amazonで同じ商品はいくらか -------------------------------------------------
 * 楽天の商品ページから「これはAmazonではいくらか」を知りたい。Amazonには
 * 商品を引くための公開APIが無い（Product Advertising API はアソシエイトの登録と売上が要る）ので、
 * 検索結果のページを1枚読んで、商品を取り出す。
 *
 * 引き方は2通り。
 *   JANがある商品  → JANで検索する。ほぼ一意に当たる。
 *   JANが無い商品  → 商品名から宣伝を落とした検索語で引き、商品名の重なり（scoreMatch）で選ぶ。
 *
 * 当たりかどうかは本人が確かめられるよう、商品ページにはAmazon側の商品名と
 * 検索結果へのリンクも必ず出す（item-amazon.js）。
 *
 * Cookieは送らない（credentials:'omit'）。本人のAmazonのアカウントには触らず、
 * 誰が見ても同じ棚を読む。ログインしていなくても価格は出る。
 * 拡張からのfetchにはOriginが付かないので、CORSで弾かれることもない。
 */
const AMAZON_TTL_MS = 6 * 60 * 60 * 1000;
const AMAZON_CACHE_MAX = 200;
const AMAZON_TIMEOUT_MS = 12000;
const AMAZON_RETRY_MS = 800;

const amazonSearchUrl = (query) =>
  `https://www.amazon.co.jp/s?k=${encodeURIComponent(query)}&i=aps&language=ja_JP`;

const amazonItemUrl = (asin) => `https://www.amazon.co.jp/dp/${asin}/`;

/** HTMLの実体参照。商品名にしか使わないので、よく出るものだけ戻す。 */
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** 検索結果の1件を、HTMLの切れ端から組み立てる。service worker に DOMParser は無いので、文字で拾う。 */
function parseAmazonResult(asin, chunk) {
  // 価格は a-offscreen（読み上げ用の "￥1,234"）に入る。先頭が販売価格で、参考価格はその後ろ。
  const price = chunk.match(/class="a-offscreen">\s*[¥￥]\s*([\d,]+)/);
  if (!price) return null;

  // 商品名は h2 の aria-label、無ければ h2 の中の最初の span
  const title = chunk.match(/<h2[^>]*\saria-label="([^"]+)"/)
    || chunk.match(/<h2[\s\S]{0,400}?<span[^>]*>([^<]{4,})<\/span>/);
  if (!title) return null;

  const rating = chunk.match(/5つ星のうち\s*([\d.]+)/);
  // 件数は「157件のレビューから5つ星のうち4.4と評価されました」(aria-label) か、リンクの "(157)"
  const count = chunk.match(/aria-label="([\d,]+)\s*件の(?:評価|レビュー)/)
    || chunk.match(/s-underline-text[^>]*>\s*\(?([\d,]+)\)?\s*</);
  const image = chunk.match(/<img[^>]+class="s-image"[^>]+src="([^"]+)"/);
  const num = (m) => (m ? Number(m[1].replace(/,/g, '')) : null);

  return {
    asin,
    title: decodeEntities(title[1]).replace(/\s+/g, ' ').trim(),
    price: num(price),
    rating: rating ? Number(rating[1]) : null,
    count: num(count),
    image: image ? image[1] : null,
    url: amazonItemUrl(asin),
    shipping: amazonShipping(chunk)
  };
}

/*
 * 検索結果のページは2段になっている。
 *
 *   <h2>結果</h2>          ← 検索語に一致した商品。本人が画面で見るのはここ
 *   <h2>その他の結果</h2>   ← 一致しなかったときの寄せ集め。同じ形の枠で何十件も続く
 *
 * 「その他の結果」の商品は、本人が検索結果を見ても出てこない（楽天24の温泡の詰め合わせで、
 * 画面には3件しか出ないのに、拡張は「その他の結果」から拾った別の商品を出していた）。
 * 実測でも、枠60件のうち「結果」に属するのは7件だけだった。ここから先は読まない。
 */
const OTHER_RESULTS = /<h2[^>]*>(?:その他の結果|関連する検索結果|他の検索結果)<\/h2>/;
function mainResults(html) {
  const m = html.match(OTHER_RESULTS);
  return m ? html.slice(0, m.index) : html;
}

/**
 * 検索結果のHTMLから商品を並べる。
 *
 * 1件は data-component-type="s-search-result" の div で、ASINは同じタグの data-asin にある。
 * data-asin だけを目印にすると、検索結果の上に出る広告の枠（商品を横に並べるもの）まで拾ってしまい、
 * 次の data-asin までが1件の切れ端にならない（実機のHTMLで確認）。
 * 広告（AdHolder / スポンサー）は、その値段がその商品の値段とは限らないので外す。
 */
const AMAZON_CHUNK_MAX = 20000;

function parseAmazonSearch(fullHtml) {
  const html = mainResults(fullHtml);
  const re = /data-component-type="s-search-result"/g;
  const starts = [];
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const at = html.lastIndexOf("<div", m.index);
    if (at >= 0) starts.push(at);
  }

  const items = [];
  const seen = new Set();
  for (let i = 0; i < starts.length; i++) {
    const at = starts[i];
    const end = Math.min(starts[i + 1] ?? html.length, at + AMAZON_CHUNK_MAX);
    const chunk = html.slice(at, end);
    const asin = chunk.match(/^<div[^>]*\sdata-asin="([A-Z0-9]{10})"/);
    if (!asin || seen.has(asin[1])) continue;
    // 広告の印は3通り見る。実測では枠の class の AdHolder が付いていた（60件中12件、すべて外せた）が、
    // 商品名（h2 の aria-label）が「スポンサー広告 - …」で始まるものもあるので、それも弾く。
    if (/AdHolder|sp-sponsored-result|aria-label="スポンサー広告|>スポンサー</.test(chunk)) continue;
    const item = parseAmazonResult(asin[1], chunk);
    if (!item) continue;
    seen.add(asin[1]);
    items.push(item);
    if (items.length >= 8) break;
  }
  return items;
}

/**
 * 商品の枠がページのどこかに1つでもあるか（「その他の結果」の分も数える）。
 * 1つも無いのは「この商品はAmazonに無い」ではなく、応答がおかしいとき（空で返ることが実際にある）。
 */
function hasAnyResultFrame(html) {
  return /data-component-type="s-search-result"/.test(html);
}

/** 人手の閲覧に見えない通信は弾かれることがある。弾かれたと分かる形で返し、商品ページでは検索への導線だけ出す。 */
function amazonBlocked(html) {
  return /validateCaptcha|api-services-support@amazon\.com|自動化されたアクセス/.test(html);
}

/*
 * 検索結果のページは1MB近くあるが、使うのは「結果」の欄の先頭の数件だけ（parseAmazonSearch は8件まで）。
 * 「その他の結果」の見出しが来たか、商品の枠が十分な数届いたら、残りは受け取らない。
 * 枠の数は、広告を除いて8件そろうよう余裕を見る（最後の枠は途中で切れていることがある）。
 */
const AMAZON_ENOUGH_FRAMES = 20;
function amazonEnough(html) {
  if (OTHER_RESULTS.test(html)) return true;
  return (html.match(/data-component-type="s-search-result"/g) || []).length > AMAZON_ENOUGH_FRAMES;
}

async function amazonFetch(url) {
  const res = await fetch(url, {
    credentials: 'omit',
    signal: AbortSignal.timeout(AMAZON_TIMEOUT_MS),
    headers: { 'Accept-Language': 'ja-JP,ja;q=0.9' }
  });
  if (!res.ok) return { status: res.status === 503 ? 'blocked' : 'error' };
  const html = await readUntil(res, amazonEnough);
  if (amazonBlocked(html)) return { status: 'blocked' };
  return { status: 'ok', html };
}

/*
 * 名前で引いたときの合格点。同じ商品でも楽天側の商品名には余計な語が残るので満点は出ない
 * （実測で0.5前後）。0.3に満たないものは別の商品とみなして出さない。
 *
 * 候補は「結果」の欄のものだけ（mainResults）。Amazon自身が検索語に一致すると言っている商品なので、
 * この点は低めでよい。「その他の結果」まで見ていたときは、まるで関係の無い商品が0.3〜0.4で混ざっていた。
 */
const AMAZON_MIN_SCORE = 0.3;

// 表示するリンクは中継ページ経由にする（アソシエイトのタグは中継側が付ける。Amazonの取得そのものは直接）
const AMAZON_GO = 'https://nesage.party/go';

// 開発用: アフィリエイト/アソシエイトIDを含めない（ポップアップの設定 noAffiliate）
async function noAffiliate() {
  try { return Boolean((await chrome.storage.sync.get({ noAffiliate: false })).noAffiliate); } catch { return false; }
}

/**
 * JANで引いて見つからなければ、型番で引き直す（Amazonは扱っていない商品のJANには何も返さないが、
 * 同じ商品が型番違い（色・販路の記号違い）で並んでいることがある）。lookup は amazonLookupRaw・yahooPrice・rakutenPrice。
 */
async function janThenModel(lookup, args) {
  const r = await lookup(args);
  if (r.status !== 'none' || !AZR.amazon.isJan(args.jan) || !args.model) return r;
  const byModel = await lookup({ ...args, jan: '' });
  return byModel.status === 'ok' ? byModel : r;
}

async function amazonLookup(args) {
  return withAmazonLinks(await amazonLookupRaw(args));
}

/** 表示するリンクを決める（キャッシュには書き換える前の結果を置く。noAffiliate を切り替えてもすぐ効くように） */
async function withAmazonLinks(raw) {
  const r = { ...raw };
  if (await noAffiliate()) {
    if (r.item?.asin) r.item = { ...r.item, url: `https://www.amazon.co.jp/dp/${r.item.asin}` };
    return r;
  }
  if (r.searchUrl && r.query) r.searchUrl = `${AMAZON_GO}?q=${encodeURIComponent(r.query)}`;
  if (r.item?.asin) r.item = { ...r.item, url: `${AMAZON_GO}?asin=${r.item.asin}` };
  return r;
}

/*
 * 送料。{ kind, fee }。kind は free（送料無料・送料込み）/ fee（金額が分かる）/ conditional（条件付き送料無料）/
 * separate（送料別。金額は分からない）。楽天・Yahoo!の検索APIは金額を返さないので、分かるのは区分だけのことが多い。
 */
function rakutenShipping(postageFlag) {
    if (postageFlag === 0) return { kind: 'free', fee: 0 };
    if (postageFlag === 1) return { kind: 'separate', fee: null };
    return null;
}
function yahooShipping(code) {
    if (code === 2) return { kind: 'free', fee: 0 };
    if (code === 3) return { kind: 'conditional', fee: null };
    return null;
}
/**
 * Amazonの検索結果の枠に書かれた配送料（Cookieなしで読むので、プライム会員ではない人の表示）。
 *   「配送料 ￥440」→ 440 / 「無料配送 … 初回のご注文の場合」→ 条件付き / 「無料配送」→ 無料
 */
function amazonShipping(chunk) {
    const text = decodeEntities(String(chunk).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
    const fee = text.match(/配送料\s*[¥￥]\s*([\d,]+)/);
    if (fee) return { kind: 'fee', fee: Number(fee[1].replace(/,/g, '')) };
    if (/無料配送|配送料無料/.test(text)) return /初回のご注文|以上の注文|以上のご注文/.test(text) ? { kind: 'conditional', fee: null } : { kind: 'free', fee: 0 };
    return null;
}

const AMAZON_NO_RESULTS = /検索クエリに一致する結果はありません|No results for/;

async function amazonLookupRaw({ title, jan, model, hint = '' }) {
  const useJan = AZR.amazon.isJan(jan);
  const useModel = !useJan && Boolean(model);
  const query = useJan ? String(jan) : useModel ? String(model) : AZR.amazon.buildQuery(title);
  if (!query) return { status: 'none', query: '', searchUrl: null };

  const searchUrl = amazonSearchUrl(query);
  let got = await amazonFetch(searchUrl);
  health.check('amazon.searchFetch', got.status === 'ok', got.status);
  if (got.status !== 'ok') return { status: got.status, query, searchUrl };

  /*
   * 商品の枠がページのどこにも無いことがある。同じ検索語をすぐ引き直すと48件返るので、
   * 「その商品はAmazonに無い」わけではない（実機で確認）。1度だけ読み直す。
   *
   * 「結果」の欄が空なだけ（枠は「その他の結果」にしかない）のときは読み直さない。
   * それは応答の不調ではなく、検索語に一致する商品が無いという答えそのもの。
   */
  let items = parseAmazonSearch(got.html);
  // 「検索クエリに一致する結果はありません」と答えた（JANで引いて、Amazonがその商品を扱っていない）。読み直しても同じ
  if (!items.length && AMAZON_NO_RESULTS.test(got.html)) return { status: 'none', query, searchUrl };
  if (!items.length && !hasAnyResultFrame(got.html)) {
    await new Promise((r) => setTimeout(r, AMAZON_RETRY_MS));
    got = await amazonFetch(searchUrl);
    if (got.status !== 'ok') return { status: got.status, query, searchUrl };
    items = parseAmazonSearch(got.html);
    if (!items.length && !hasAnyResultFrame(got.html)) return { status: 'none', empty: true, query, searchUrl };
  }
  // 「結果」の欄に商品の枠があるのに1件も読めない = 枠の中の形（価格・商品名）が変わった
  if (items.length || hasAnyResultFrame(mainResults(got.html))) {
    health.check('amazon.searchParse', items.length > 0, `商品の枠はあるのに読めない（${query}）`);
  }
  items = AZR.amazon.sameCondition(title, items);
  if (!items.length) return { status: 'none', query, searchUrl };

  if (useJan) {
    // JANは一意なので、広告を除いた先頭がその商品。重なりは参考として付けるだけにする。
    const item = items[0];
    return {
      status: 'ok', query, searchUrl, byJan: true,
      item: { ...item, score: AZR.amazon.scoreMatch(title, item.title) }
    };
  }

  if (useModel) {
    // 型番で引いたときは、商品名に型番がそのまま入っているものだけが同じ商品。無ければ名前の重なりで選ぶ。
    let hit = null;
    for (const it of items) {
      if (!AZR.amazon.titleHasModel(model, it.title)) continue;
      const score = AZR.amazon.scoreMatch(title, it.title);
      if (!hit || score > hit.score) hit = { ...it, score };
    }
    if (hit) return { status: 'ok', query, searchUrl, byModel: true, item: hit };
  }

  // 名前で引いたとき、こちらの型番が商品名に入っている候補があれば、それが同じ商品。違う型番の候補は外す
  const { exact, rest } = AZR.amazon.splitByModel(items, hint);
  if (exact.length) {
    const hit = exact.map((it) => ({ ...it, score: AZR.amazon.scoreMatch(title, it.title) })).reduce((a, b) => (b.score > a.score ? b : a));
    return { status: 'ok', query, searchUrl, byModel: true, item: hit };
  }

  // 名前で引いたときは、商品名がいちばん重なるものを選ぶ（先頭が一番近いとは限らない）
  let best = null;
  for (const it of rest) {
    const score = AZR.amazon.scoreMatch(title, it.title);
    if (!best || score > best.score) best = { ...it, score };
  }
  if (!best || best.score < AMAZON_MIN_SCORE) return { status: 'none', query, searchUrl };
  return { status: 'ok', query, searchUrl, byJan: false, item: best };
}

/** 価格は日単位で動くが、同じ商品ページを開き直すたびに読みに行く必要は無い。 */
async function amazonPrice({ title, jan, model, hint = '' }) {
  // v2: リンクを中継ページ経由にした（v1 のキャッシュには、Amazon直リンクが入っている）
  // v3: まとめ売りの数が違う商品の一致度を下げた（v2 のキャッシュには、1個売りに当てた「2点セット」が残っている）
  // JANで引くときも型番（JANで無いときの引き直しに使う）を、名前で引くときも型番の手がかり（hint）をキーに入れる
  // v4: 配送料（shipping）を足した
  // v5: リンクを書き換える前の結果を置くようにした（v4 には書き換えた後のリンクが入っている）
  const key = AZR.amazon.isJan(jan) ? `v5:jan:${jan}:${model || ''}` : model ? `v5:m:${model}:${AZR.amazon.buildQuery(title)}` : `v5:q:${AZR.amazon.buildQuery(title)}:${hint}`;
  const { azrAmazon: cache = {} } = await chrome.storage.local.get('azrAmazon');
  const now = Date.now();
  const hit = cache[key];
  if (hit && now - hit.at < AMAZON_TTL_MS) return { ...(await withAmazonLinks(hit.result)), cached: true };

  const result = await janThenModel(amazonLookupRaw, { title, jan, model, hint });
  // 弾かれた・通信に失敗した・空で返った、は覚えない（次に開いたときは読みに行く）
  if ((result.status === 'ok' || result.status === 'none') && !result.empty) {
    // 読み直してから書く（複数のタブから同時に来ると、先に書いた分を古い一覧で消すため）
    await saveCacheSerially(async () => {
      const { azrAmazon: all = {} } = await chrome.storage.local.get('azrAmazon');
      for (const [k, v] of Object.entries(all)) if (now - v.at >= AMAZON_TTL_MS || !k.startsWith('v5:')) delete all[k];
      all[key] = { at: now, result };
      const keys = Object.keys(all);
      if (keys.length > AMAZON_CACHE_MAX) {
        const oldest = keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - AMAZON_CACHE_MAX);
        for (const k of oldest) delete all[k];
      }
      await chrome.storage.local.set({ azrAmazon: all });
    });
  }
  return withAmazonLinks(result);
}

/* 獲得したクーポンの履歴 -----------------------------------------------------
 * 自動獲得は既定でONで、押さなくても獲得が進む。何を獲得したのかをポップアップで
 * 見られるよう、新たに獲得できたもの（獲得済みだったものは除く）だけを残す。
 * 中身は商品ページに出ていたクーポン名・店舗名・商品名・ページのURLだけ。ブラウザの外へは出さない。
 */
const ACQUIRED_MAX = 100;

/** storage を読んで書くまでを1件ずつにする。並べて走らせると、後の書き込みが先の分を消す。 */
function serialized() {
  let queue = Promise.resolve();
  return (fn) => {
    queue = queue.then(fn).catch((e) => console.warn('[AZR] 保存に失敗:', e));
    return queue;
  };
}
const saveAcquiredSerially = serialized();
const saveCacheSerially = serialized(); // azrRatings・azrAmazon

function recordAcquired(res, record) {
  if (res?.status !== 'acquired' || !record || typeof record !== 'object') return;
  const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const url = str(record.url, 300);
  const entry = {
    name: str(record.name, 120),
    shop: str(record.shop, 60),
    item: str(record.item, 120),
    url: /^https:\/\/item\.rakuten\.co\.jp\//.test(url) ? url : '',
    auto: Boolean(record.auto),
    at: Date.now()
  };
  saveAcquiredSerially(async () => {
    const { azrAcquired: list = [] } = await chrome.storage.local.get('azrAcquired');
    await chrome.storage.local.set({ azrAcquired: [entry, ...list].slice(0, ACQUIRED_MAX) });
  });
}

/* APIが使えない場合の保険。
 * 裏のタブで本物の獲得ページを開き、結果を受け取ってから閉じる。 */
const couponWaiters = new Map(); // tabId -> (result) => void

function grabByTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }).then((tab) => {
      const tabId = tab.id;
      let settled = false;

      const finish = async (result) => {
        if (settled) return;
        settled = true;
        couponWaiters.delete(tabId);
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);

        if (result.status === 'closed') return resolve(result);
        // 本人の操作や確認が要るものだけ前面に出す。
        // 結果がはっきりしている失敗（配布終了など）は、行の文言で足りるので閉じる。
        if (KEEP_TAB.has(result.status)) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        else await chrome.tabs.remove(tabId).catch(() => {});
        resolve(result);
      };

      const onUpdated = (id, info, t) => {
        if (id !== tabId || info.status !== 'complete') return;
        // 権限のある *.rakuten.co.jp を出るとURLが読めなくなる = SSOログインへ飛ばされた
        if (!t.url) return finish({ ok: false, status: 'login' });
        // 獲得後は rd= の戻り先へ遷移する。獲得ページを離れていれば獲得できたとみなす。
        if (!COUPON_PAGE.test(t.url)) return finish({ ok: true, status: 'acquired' });
        // 獲得ページに留まっている間は、そのページのcontent scriptの報告を待つ
      };
      const onRemoved = (id) => { if (id === tabId) finish({ ok: false, status: 'closed' }); };
      const timer = setTimeout(() => finish({ ok: false, status: 'timeout' }), COUPON_TIMEOUT_MS);

      couponWaiters.set(tabId, finish);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    }).catch((e) => resolve({ ok: false, status: 'error', error: String(e) }));
  });
}

/**
 * まず獲得ページと同じAPIを叩き、それで決着が付かない場合だけタブ方式に落とす。
 * 未ログインもタブに落とす。ログインすれば獲得ページがそのまま獲得まで進むので、
 * ここでただ「ログインしてください」と言うより手数が少ない。
 */
/*
 * 獲得できた（獲得済みだった）クーポンの getkey。自動獲得は商品ページを開くたびに走るので、
 * 覚えておいて獲得APIを呼び直さない。期限は長めにとる（獲得済みは取り消されない。期限切れのものは呼んでも獲得できない）。
 */
const GOT_COUPON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GOT_COUPON_MAX = 2000;
const saveGotSerially = serialized();

async function knownAcquired(key) {
  const { azrGotCoupons: got = {} } = await chrome.storage.local.get('azrGotCoupons');
  return Boolean(got[key] && Date.now() - got[key] < GOT_COUPON_TTL_MS);
}

function rememberAcquired(key) {
  return saveGotSerially(async () => {
    const { azrGotCoupons: got = {} } = await chrome.storage.local.get('azrGotCoupons');
    const now = Date.now();
    for (const [k, at] of Object.entries(got)) if (now - at >= GOT_COUPON_TTL_MS) delete got[k];
    got[key] = now;
    const keys = Object.keys(got);
    if (keys.length > GOT_COUPON_MAX) {
      for (const k of keys.sort((a, b) => got[a] - got[b]).slice(0, keys.length - GOT_COUPON_MAX)) delete got[k];
    }
    await chrome.storage.local.set({ azrGotCoupons: got });
  });
}

async function grabCoupon(url, { apiOnly = false } = {}) {
  const key = couponGetKey(url);
  // getkey の無いページは獲得ページではない。タブで開くと、クーポンのページを「離れた」ことを
  // 獲得できた印と読むため、何も獲得していないのに成功と返してしまう。
  if (!key) return { ok: false, status: 'error' };
  if (apiOnly && (await knownAcquired(key))) return { ok: true, status: 'already' };
  try {
    const viaApi = await acquireByApi(key);
    if (viaApi?.ok) rememberAcquired(key);
    if (viaApi && viaApi.status !== 'login') return viaApi;
    // 自動獲得は押されていないので、裏タブを勝手に開かない。未ログイン等は行に返すだけにする。
    if (apiOnly) return viaApi || { ok: false, status: 'unknown' };
  } catch (e) {
    console.warn('[AZR] 獲得APIが使えないのでタブで開きます:', e);
    if (apiOnly) return { ok: false, status: 'error' };
  }
  return holdAwake(() => grabByTab(url));
}

/* キャンペーンの発見と一括エントリー ----------------------------------------
 *
 * 楽天には「エントリーできるキャンペーンの一覧」も「エントリー済みの一覧」も無い。
 * そこでトップページから event.rakuten.co.jp へのリンクを集め、1ページずつ裏タブで
 * 開いて「エントリーボタンがあるか / もう済んでいるか / そもそも特集ページか」を
 * 判定し、結果をこちらで記録する。記録がそのまま「エントリー済み一覧」になる。
 */
const TOP_PAGE = 'https://www.rakuten.co.jp/';
const CAMPAIGN_HOST = 'event.rakuten.co.jp';
const SCAN_CONCURRENCY = 3;        // 同時に開く裏タブの数
const SCAN_TAB_TIMEOUT_MS = 45000; // 1ページあたりの待ち時間（裏タブは実行を絞られるので長め）
// タブを開かず fetch で判定するので、以前（裏タブ3枚で80ページ）より多く見て回れる。
const MAX_CAMPAIGNS = 200;
// 「エントリーするものが無いページ」は同じ日のうちは開き直さない。
// 日ごとに開くキャンペーン（イーグルス・ヴィッセルが勝った翌日だけボタンが出る sports など）があり、
// 以前の「7日間は開かない」では、ボタンの無い日に一度見ただけで勝った日を取り逃していた。
const jstDay = (ms) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** このタブに何をさせたいか。content script が起動時に聞きに来る。 */
const scanTasks = new Map(); // tabId -> { task: 'links' | 'campaign', entry: boolean }
const scanWaiters = new Map(); // tabId -> (result) => void

let scanState = { running: false, phase: '', done: 0, total: 0, startedAt: 0 };

/** 計測用のパラメータを落として、同じページを1つに寄せる */
function normalizeCampaignUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  // トップページのバナーは rd.rakuten.co.jp/rat/?R2=<本来のURL> で包まれている
  if (url.hostname === 'rd.rakuten.co.jp') {
    const inner = url.searchParams.get('R2');
    if (!inner) return null;
    return normalizeCampaignUrl(inner);
  }
  if (url.hostname !== CAMPAIGN_HOST) return null;
  // l-id / scid などは同じページの計測違いでしかない
  return `${url.origin}${url.pathname}`;
}

/** 1つのタブに仕事をさせて、結果を受け取ってから閉じる */
function runInTab(url, task, entry) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }).then((tab) => {
      const tabId = tab.id;
      let settled = false;
      const finish = async (result) => {
        if (settled) return;
        settled = true;
        scanTasks.delete(tabId);
        scanWaiters.delete(tabId);
        clearTimeout(timer);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        await chrome.tabs.remove(tabId).catch(() => {});
        resolve(result);
      };
      const onRemoved = (id) => { if (id === tabId) finish({ status: 'closed' }); };
      const timer = setTimeout(() => finish({ status: 'timeout' }), SCAN_TAB_TIMEOUT_MS);

      scanTasks.set(tabId, { task, entry });
      scanWaiters.set(tabId, finish);
      chrome.tabs.onRemoved.addListener(onRemoved);
    }).catch((e) => resolve({ status: 'error', error: String(e) }));
  });
}

/* タブを開かない判定 ---------------------------------------------------------
 * 裏タブは非アクティブでもタブ欄に並ぶので、本人の作業の邪魔になる。
 * キャンペーンページはエントリーのコードをHTMLにそのまま書いているので、
 * service worker から fetch して取り出せば、タブを1枚も開かずに判定・エントリーできる。
 * （自分で開いたページ用の content script 側の仕組みはそのまま残す。ここは一括スキャン専用の道。）
 */
const SCAN_FETCH_CONCURRENCY = 6; // fetchだけなので裏タブより多く走らせられる

/** ログイン済みのcookieを付けてHTMLを取る。取れなければ null */
async function fetchPage(url) {
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** HTMLからエントリーのコードを拾う（共通ボタンの settings も、ページに書かれたJSONも） */
function extractEntryItems(html) {
  const map = new Map();
  const add = (raw, ekey) => {
    let code = String(raw || '').trim();
    if (!code) return;
    if (!code.startsWith('/')) code = '/' + code;
    if (!map.has(code)) map.set(code, { code, ekey: ekey || '' });
  };
  // settings='{"campaignCode": "/ic/…", "ekey": "…"}' も、ページのJSONで \" と逃がした形も
  // 同じに拾えるよう、引用符は見ずに「campaignCode のすぐ後ろのコードらしい文字列」を取る。
  const re = /campaignCode[^A-Za-z0-9]{1,12}([\w./-]{1,120})/g;
  for (const m of html.matchAll(re)) {
    // ekey は同じ settings の中にある。次の campaignCode までの範囲だけ見る。
    const from = m.index + m[0].length;
    const tail = html.slice(from, from + 250).split('campaignCode')[0];
    const e = tail.match(/ekey[^A-Za-z0-9]{0,12}([\w.%-]{1,120})/);
    add(m[1], e ? e[1] : '');
  }
  // 応募ページへのリンク（買いまわりの事前エントリーなど）
  const re2 = /oubo\.rakuten\.co\.jp\/apply(\/[\w./-]{1,120})(?:\?[^"'\s<>]*?ekey=([\w.%-]+))?/g;
  for (const m of html.matchAll(re2)) {
    let ekey = '';
    try { ekey = m[2] ? decodeURIComponent(m[2]) : ''; } catch { /* 壊れたekey */ }
    add(m[1], ekey);
  }
  return [...map.values()];
}

/** 一覧に出すページ名 */
function extractTitle(html, url) {
  const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const name = (m ? m[1] : '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s*[|｜]\s*楽天市場.*$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // エラーページの見出しを名前にしない（一覧で見分けが付かない）
  if (!name || /^\d{3}\s|Bad Request|Not Found|Forbidden/i.test(name)) {
    try { return new URL(url).pathname.replace(/^\/|\/$/g, '') || CAMPAIGN_HOST; } catch { return CAMPAIGN_HOST; }
  }
  return name;
}

/** トップページのHTMLからキャンペーンのリンクを拾う（rd.rakuten の包みも、%2F で包まれたものも） */
function extractCampaignLinks(html) {
  // JSONの中のURLは \/ や \u002F で書かれている。素の文字に直してから拾う。
  const text = html.split('\\u002F').join('/').split('\\u002f').join('/')
    .split('\\/').join('/').split('&amp;').join('&');
  const out = new Set();
  for (const m of text.matchAll(/https:\/\/(?:event|rd)\.rakuten\.co\.jp\/[^"'\s<>\\]*/g)) {
    out.add(m[0].replace(/[),.]+$/, ''));
  }
  for (const m of text.matchAll(/https?%3A%2F%2Fevent\.rakuten\.co\.jp%2F[^"'\s<>&]*/gi)) {
    try { out.add(decodeURIComponent(m[0])); } catch { /* 壊れたURL */ }
  }
  return [...out];
}

/**
 * コードが取れなかったページを「エントリー不要」と黙って記録してよいか。
 * 文言だけで見ると、説明文（「キャンペーンページからエントリーすると参加できます」）や
 * ほかのページへの案内ボタン（SPUから楽天モバイルへ、ラグジュアリービューティの特集など）まで
 * 「要確認」になり、毎日7件ほど鳴りっぱなしになった。content script と同じく、
 * 「このページで押せるエントリーのボタン」に見えるものだけを手がかりにする。
 */
function looksEnterable(html, url) {
  if (/rcEntryButton|oubo\.rakuten\.co\.jp\/apply/.test(html)) return true;
  for (const m of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]{0,300}?)<\/\1>/gi)) {
    const text = m[3].replace(/<[^>]*>/g, ' ').replace(/\s+/g, '');
    if (!/エントリー(する|はこちら)/.test(text)) continue;
    if (/履歴|期間|終了|開始前|詳細|方法|について/.test(text)) continue;
    if (m[1].toLowerCase() === 'button') return true;
    // 別のサイト・別のページへのリンクは、ほかのキャンペーンへの案内であってこのページのエントリーではない
    const href = (m[2].match(/href\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return true;
    try {
      const u = new URL(href, url);
      const same = (a) => a.replace(/\/$/, '');
      if (u.host === new URL(url).host && same(u.pathname) === same(new URL(url).pathname)) return true;
    } catch { /* 壊れたURL */ }
  }
  return false;
}

/**
 * fetchしたHTMLだけで判定（entry なら エントリーまで）。
 * 判定しきれなければ null を返し、呼び側でタブ方式に落とすか「要確認」にする。
 */
async function checkCampaignByFetch(open, entry) {
  const html = await fetchPage(open);
  if (html == null) return null;
  const title = extractTitle(html, open);
  const items = extractEntryItems(html);
  if (items.length) {
    const r = await enterByCodes(items, entry).catch(() => null);
    // コードはあるのにAPIが答えない＝未ログイン等。判定できていないので null。
    return r ? { ...r, title } : null;
  }
  return { status: looksEnterable(html, open) ? 'suspect' : 'none', entered: false, title };
}

/* エントリーAPI -------------------------------------------------------------
 * 楽天共通のエントリーボタン（r.r10s.jp/com/js/c/common/entry_button）が呼んでいるのと同じAPI。
 * ボタンの文言や形はページごとに違うが、コード（settings の campaignCode）で呼べば関係ない。
 *   GET api.oubo.rakuten.co.jp/2.0/entry/check?code=<code>,<code>…（ボタンのスクリプトは20件ずつ）
 *     → { message: 'ok', results: [{ campaign: { code, status, end_date, entry_date }, applied }] }
 *       status: ongoing / before_start / closed / campaign_not_found
 *   GET api.oubo.rakuten.co.jp/2.0/entry/apply?code=<code>[&ekey=…]
 *     → { message: 'ok', results: [{ success, campaign }] }
 * 未ログインだと 403 {"message":"not allowed"}。ログインしていれば拡張からの fetch でも通る（Braveで確認）。
 * コードは /ic/marathon/… のような英数字と記号だけで、ボタンのスクリプトと同じくそのまま並べる。
 */
const OUBO_API = 'https://api.oubo.rakuten.co.jp/2.0/entry/';
const OUBO_CHECK_CHUNK = 20;
const ENTRY_CODE = /^\/[\w./-]{1,120}$/;

async function ouboCall(pathAndQuery) {
  const res = await fetch(OUBO_API + pathAndQuery, { credentials: 'include', cache: 'no-store' });
  if (res.status === 403) return null; // 未ログイン
  if (!res.ok) {
    health.check('rakuten.entryApi', false, `HTTP ${res.status}`);
    return null;
  }
  const data = await res.json().catch(() => null);
  const ok = data?.message === 'ok' && Array.isArray(data.results);
  health.check('rakuten.entryApi', ok, `想定外の応答: ${JSON.stringify(data)?.slice(0, 120)}`);
  return ok ? data.results : null;
}

/** コードごとの状態。1つでも取れなければ null */
async function checkEntryCodes(codes) {
  const out = new Map();
  for (let i = 0; i < codes.length; i += OUBO_CHECK_CHUNK) {
    const results = await ouboCall(`check?code=${codes.slice(i, i + OUBO_CHECK_CHUNK).join(',')}`);
    if (!results) return null;
    for (const r of results) {
      if (r?.campaign?.code) out.set(r.campaign.code, { status: r.campaign.status, applied: Boolean(r.applied) });
    }
  }
  return out;
}

/**
 * キャンペーンページで集めたコードを確かめて、entry なら未エントリーのものをエントリーする。
 * 返す status はスキャンの記録と同じ語彙。APIが使えなければ null（ページ側でボタンを押す方式に戻る）。
 */
async function enterByCodes(items, entry) {
  const ekeys = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const code = String(it?.code || '');
    if (ENTRY_CODE.test(code) && !ekeys.has(code)) ekeys.set(code, typeof it.ekey === 'string' ? it.ekey : '');
  }
  const codes = [...ekeys.keys()];
  if (!codes.length) return null;

  const before = await checkEntryCodes(codes);
  if (!before) return null;
  const open = codes.filter((c) => before.get(c)?.status === 'ongoing' && !before.get(c).applied);
  if (!open.length) {
    return { status: codes.some((c) => before.get(c)?.applied) ? 'already' : 'none', entered: false };
  }
  if (!entry) return { status: 'entry', entered: false };

  for (const code of open) {
    const ekey = ekeys.get(code);
    await ouboCall(`apply?code=${code}${ekey ? `&ekey=${encodeURIComponent(ekey)}` : ''}`).catch(() => null);
  }
  // 呼んだだけで「エントリーした」と言わない。状態を取り直して確かめる。
  const after = await checkEntryCodes(open);
  const done = open.filter((c) => after?.get(c)?.applied);
  return { status: done.length === open.length ? 'entered' : 'entry', entered: done.length > 0 };
}

/** 保存してある結果（= エントリー済み一覧の元データ） */
async function loadCampaigns() {
  const stored = await chrome.storage.local.get('azrCampaigns');
  return stored.azrCampaigns || { updatedAt: 0, items: {} };
}

// 同時に結果が返るので、読んで書くまでを1件ずつにする。
// 並べて走らせると、先に書いた分を後の書き込みが古い一覧で上書きして消す。
const saveCampaignSerially = serialized();
// 長く見ていないページは一覧から落とす（トップから消えたキャンペーンの記録が溜まり続けないように）
const CAMPAIGN_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** patches は url → 記録。1件ごとに一覧全体を書き直すと重いので、まとめて書く */
function saveCampaigns(patches) {
  return saveCampaignSerially(async () => {
    const data = await loadCampaigns();
    const now = Date.now();
    for (const [url, patch] of patches) data.items[url] = { url, ...(data.items[url] || {}), ...patch };
    for (const [url, it] of Object.entries(data.items)) if (now - (it.checkedAt || 0) >= CAMPAIGN_KEEP_MS) delete data.items[url];
    data.updatedAt = now;
    await chrome.storage.local.set({ azrCampaigns: data });
  });
}
const CAMPAIGN_SAVE_EVERY = 10;

/** まとめて実行。並びは保ちつつ、数タブずつ同時に開く。 */
async function eachLimited(list, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (index < list.length) {
      const i = index++;
      await worker(list[i], i);
    }
  });
  await Promise.all(runners);
}

/** 実行中はアイコンに残りの件数を出す。ポップアップを閉じても進み具合が分かるように。 */
function setBadge(text) {
  if (!text) return updateHealthBadge(); // 終わったらセルフチェックの件数に戻す
  chrome.action.setBadgeBackgroundColor({ color: '#f08804' }).catch(() => {});
  chrome.action.setBadgeText({ text }).catch(() => {});
}

/**
 * スキャンとURL指定の実行を1つずつ走らせる。
 * 結果は session storage にも残す。ポップアップは実行中に閉じられることが多く、
 * 開き直したときにそこから読んで出す（sendMessage の応答は閉じた時点で受け取れなくなる）。
 */
async function runScan(phase, job) {
  if (scanState.running) return { ok: false, error: 'すでに実行中です' };
  scanState = { running: true, phase, done: 0, total: 0, startedAt: Date.now() };
  setBadge('…');
  let result;
  try {
    result = await holdAwake(job);
  } catch (e) {
    result = { ok: false, error: String(e?.message || e) };
  }
  // 結果を書いてから running を下ろす。ポップアップは running が下りたのを見て結果を読みに来る。
  await chrome.storage.session.set({ azrScanResult: { ...result, finishedAt: Date.now() } }).catch(() => {});
  scanState = { ...scanState, running: false, phase: '' };
  setBadge('');
  return result;
}

/**
 * キャンペーンのページを数タブずつ裏で開いて判定（とエントリー）し、結果を記録する。
 * targets は { url: 記録に使う正規化したURL, open: 実際に開くURL }。
 */
async function checkCampaigns(targets, entry) {
  scanState.phase = entry ? 'エントリー中' : '確認中';
  scanState.total = targets.length;

  // 既定ではタブを1枚も開かない。fetchで判定しきれないページをタブで開き直すかは設定で選ぶ。
  const { campaignTabFallback } = await chrome.storage.sync.get({ campaignTabFallback: false });

  const results = [];
  // 途中で service worker が止まっても判定した分が残るよう、数件ごとに書く
  let pending = new Map();
  const flush = () => {
    const batch = pending;
    pending = new Map();
    return batch.size ? saveCampaigns(batch) : null;
  };
  await eachLimited(targets, campaignTabFallback ? SCAN_CONCURRENCY : SCAN_FETCH_CONCURRENCY, async ({ url, open }) => {
    let r = await checkCampaignByFetch(open, entry);
    if (!r) r = campaignTabFallback ? await runInTab(open, 'campaign', entry) : { status: 'suspect' };
    const item = {
      url,
      title: r?.title || '',
      status: r?.status || 'unknown',
      entered: Boolean(r?.entered),
      checkedAt: Date.now()
    };
    pending.set(url, item);
    if (pending.size >= CAMPAIGN_SAVE_EVERY) await flush();
    results.push(item);
    scanState.done = results.length;
    setBadge(String(targets.length - results.length || ''));
  });
  await flush();

  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    ok: true,
    checked: results.length,
    entered: count('entered'),
    alreadyEntered: count('already'),
    none: count('none'),
    suspect: count('suspect'),
    failed: results.filter((r) => ['timeout', 'error', 'unknown', 'closed'].includes(r.status)).length
  };
}

/**
 * ポップアップの「URLを指定して実行」。スキャンと同じく、そのURLのために開いたタブだけで
 * エントリーし、表示が変わったことを確かめてから記録する。
 * （以前は「3分間はどのキャンペーンページでも自動エントリーして閉じる」印を立てていたため、
 * その間に自分で開いたキャンペーンページまでエントリーされて閉じていた。）
 */
function enterCampaignUrls(rawUrls) {
  const targets = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of rawUrls) {
    const url = normalizeCampaignUrl(raw);
    if (!url) { skipped++; continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    // クエリを落とすと開けなくなるページがあるので、書かれたURLのまま開く（rd.rakuten の包みは剥がす）
    targets.push({ url, open: new URL(raw).hostname === CAMPAIGN_HOST ? raw : url });
  }
  if (!targets.length) return Promise.resolve({ ok: false, error: `${CAMPAIGN_HOST} のURLがありません` });

  return runScan('エントリー中', async () => ({ ...(await checkCampaigns(targets, true)), skipped }));
}

/** onlyLinks を渡すと、トップページを読まずにそのリンクだけを確かめる */
function scanCampaigns({ entry, extraLinks = [], onlyLinks = null }) {
  return runScan('トップページを読み込み中', async () => {
    // トップページもタブを開かずに読む。下へ送らないと見えない枠も、リンクはHTMLの中にある。
    const topHtml = onlyLinks ? '' : await fetchPage(TOP_PAGE);
    let rawLinks = onlyLinks || (topHtml == null ? [] : extractCampaignLinks(topHtml));
    // 開いているトップページのDOMにだけあるリンク（フラッシュバナー等）も足す
    rawLinks = rawLinks.concat(extraLinks);
    if (!rawLinks.length) {
      const { campaignTabFallback } = await chrome.storage.sync.get({ campaignTabFallback: false });
      const found = campaignTabFallback ? await runInTab(TOP_PAGE, 'links', false) : null;
      rawLinks = Array.isArray(found?.links) ? found.links : [];
    }
    health.check('rakuten.topCampaignLinks', rawLinks.length > 0, topHtml == null ? 'トップページを取れない' : 'リンクが1件も無い');
    if (!rawLinks.length) return { ok: false, error: 'トップページからリンクを取れませんでした' };

    const urls = [];
    const seen = new Set();
    for (const raw of rawLinks) {
      const url = normalizeCampaignUrl(raw);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }

    // 今日すでに「エントリーするものが無い」と分かったページは、開き直さない
    const stored = await loadCampaigns();
    const now = Date.now();
    const targets = urls.filter((u) => {
      const prev = stored.items[u];
      return !(prev && prev.status === 'none' && jstDay(now) === jstDay(prev.checkedAt || 0));
    }).slice(0, MAX_CAMPAIGNS);

    const summary = await checkCampaigns(targets.map((url) => ({ url, open: url })), entry);
    return { ...summary, scanned: urls.length };
  });
}

/**
 * 自動スキャン。楽天のページを開いたときに、その裏で走らせる（タブは開かないので画面は変わらない）。
 * 何度も走らせないよう、前回からの間隔をあける（キャンペーンは1日単位で入れ替わるので、これで足りる）。
 */
const AUTO_SCAN_INTERVAL_MS = 12 * 60 * 60 * 1000;

async function autoScanOnVisit(extraLinks = []) {
  if (scanState.running) return { ok: false, skipped: 'running' };

  const cfg = await chrome.storage.sync.get({
    enabled: true, campaignScanOnTop: true, campaignScanEntry: true, consentAt: 0
  });
  if (!cfg.enabled || cfg.campaignScanOnTop === false || !cfg.consentAt) return { ok: false, skipped: 'off' };

  const { azrAutoScanAt = 0 } = await chrome.storage.local.get('azrAutoScanAt');
  const entry = cfg.campaignScanEntry !== false;
  if (Date.now() - azrAutoScanAt >= AUTO_SCAN_INTERVAL_MS) {
    // 走らせる前に印を立てる。楽天のページを複数のタブで開くと、ほぼ同時に頼まれる。
    await chrome.storage.local.set({ azrAutoScanAt: Date.now() });
    return scanCampaigns({ entry, extraLinks });
  }
  // 間隔の内でも、開いたトップページに今日まだ確かめていないキャンペーンのリンクがあれば、それだけを確かめる
  // （HTMLだけを読むスキャンでは、DOMにだけあるバナーを拾えない。全件を取り直す必要は無い）
  if (!extraLinks.length) return { ok: false, skipped: 'recent' };
  const stored = await loadCampaigns();
  const today = jstDay(Date.now());
  const fresh = extraLinks.filter((l) => {
    const u = normalizeCampaignUrl(l);
    return u && jstDay(stored.items[u]?.checkedAt || 0) !== today;
  });
  if (!fresh.length) return { ok: false, skipped: 'recent' };
  return scanCampaigns({ entry, onlyLinks: fresh });
}

/** 拡張のページ（ポップアップ。タブで開いたものも含む）からの呼び出しか。content script からは受け付けない操作に使う */
const fromExtensionPage = (sender) => String(sender?.url || '').startsWith(chrome.runtime.getURL(''));
const POPUP_ONLY = new Set(['azr:scanCampaigns', 'azr:enterCampaignUrls']);

/** content script へ渡す1言語分の訳。足りない文言は英語で埋める（i18n.js の AZR.t と同じ順） */
async function messagesFor(lang) {
  const all = AZR.messages || {};
  if (!all[lang]) return null;
  const dict = { ...all.en, ...all[lang] };
  const key = `azrI18n:${lang}:${chrome.runtime.getManifest().version}`;
  // 古い版の訳は消す（更新のたびに溜まらないように）
  const stored = await chrome.storage.local.get(null).catch(() => ({}));
  const old = Object.keys(stored || {}).filter((k) => k.startsWith('azrI18n:') && k !== key);
  if (old.length) await chrome.storage.local.remove(old).catch(() => {});
  await chrome.storage.local.set({ [key]: dict }).catch(() => {});
  return dict;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'azr:messages') {
    messagesFor(String(msg.lang || '')).then(sendResponse, () => sendResponse(null));
    return true; // 非同期応答
  }

  if (POPUP_ONLY.has(msg?.type) && !fromExtensionPage(sender)) {
    sendResponse({ ok: false, error: '対象外の呼び出しです' });
    return false;
  }

  // キャンペーンページから: このURLで自動エントリーするのは初めてか（ブラウザを閉じるまで覚える）
  if (msg?.type === 'azr:entryOnce') {
    const key = 'azrEntered:' + String(msg.url || '').slice(0, 300);
    chrome.storage.session.get(key)
      .then(async (got) => {
        if (got[key]) return { first: false };
        await chrome.storage.session.set({ [key]: Date.now() });
        return { first: true };
      })
      .then(sendResponse, () => sendResponse(null));
    return true; // 非同期応答
  }

  // 裏タブから: 自分は何をすべきタブか
  if (msg?.type === 'azr:scanTask') {
    sendResponse(sender.tab?.id != null ? (scanTasks.get(sender.tab.id) || null) : null);
    return false;
  }

  // トップページの裏タブから: 集めたリンク
  if (msg?.type === 'azr:campaignLinks') {
    scanWaiters.get(sender.tab?.id)?.({ links: msg.links || [] });
    return false;
  }

  // キャンペーンページの裏タブから: 判定とエントリーの結果
  if (msg?.type === 'azr:campaignResult') {
    scanWaiters.get(sender.tab?.id)?.({
      status: msg.status || 'unknown',
      title: msg.title || '',
      entered: Boolean(msg.entered)
    });
    return false;
  }

  // ポップアップから: 探して（必要なら）エントリーする
  if (msg?.type === 'azr:scanCampaigns') {
    scanCampaigns({ entry: msg.entry !== false }).then(sendResponse);
    return true; // 非同期応答
  }

  // 楽天のページを開いたとき: 裏で探してエントリーする
  if (msg?.type === 'azr:autoScanCampaigns') {
    autoScanOnVisit(Array.isArray(msg.links) ? msg.links.filter((l) => typeof l === 'string') : []).then(sendResponse);
    return true; // 非同期応答
  }

  // ポップアップから: 進み具合
  if (msg?.type === 'azr:scanStatus') {
    sendResponse(scanState);
    return false;
  }

  // ポップアップから: 記録してある一覧
  if (msg?.type === 'azr:campaignList') {
    loadCampaigns().then((d) => sendResponse(Object.values(d.items).sort((a, b) => (b.checkedAt || 0) - (a.checkedAt || 0))));
    return true; // 非同期応答
  }

  // 商品ページから: このクーポンを裏で獲得してほしい
  if (msg?.type === 'azr:grabCoupon') {
    const url = String(msg.url || '');
    if (!COUPON_PAGE.test(url)) {
      sendResponse({ ok: false, status: 'error', error: '対象外のURLです' });
      return false;
    }
    grabCoupon(url, { apiOnly: Boolean(msg.apiOnly) }).then((res) => {
      recordAcquired(res, msg.record);
      sendResponse(res);
    });
    return true; // 非同期応答
  }

  // 商品ページから: クーポンの内容（名前・割引・獲得済みか）
  if (msg?.type === 'azr:couponDetails') {
    const key = couponGetKey(msg.url || '');
    if (!key) {
      sendResponse(null);
      return false;
    }
    couponDetails(key).then(sendResponse).catch(() => sendResponse(null));
    return true; // 非同期応答
  }

  // 商品ページから: フローティングクーポン（元のページで右下に出る枠）の一覧
  if (msg?.type === 'azr:floatingCoupons') {
    const itemId = String(msg.itemId || '');
    const shopId = String(msg.shopId || '');
    const price = Number(msg.price);
    if (!/^\d+$/.test(itemId) || !/^\d+$/.test(shopId) || !(price > 0)) {
      sendResponse(null);
      return false;
    }
    floatingCoupons({ itemId, shopId, price: Math.round(price), hasSubscription: Boolean(msg.hasSubscription) })
      .then(sendResponse)
      .catch((e) => {
        console.warn('[AZR] フローティングクーポンを取れない:', e);
        health.check('rakuten.floatingCouponApi', false, e);
        sendResponse(null);
      });
    return true; // 非同期応答
  }

  // 商品ページから: フローティングクーポンの獲得
  if (msg?.type === 'azr:grabFloatingCoupon') {
    const getKey = String(msg.getKey || '');
    if (!/^[A-Za-z0-9_=-]+$/.test(getKey)) {
      sendResponse({ ok: false, status: 'error' });
      return false;
    }
    acquireFloatingCoupon(getKey)
      .then((res) => {
        recordAcquired(res, msg.record);
        sendResponse(res);
      })
      .catch((e) => sendResponse({ ok: false, status: 'error', error: String(e) }));
    return true; // 非同期応答
  }

  // 商品ページから: 商品とショップの評価
  if (msg?.type === 'azr:reviewRatings') {
    const shopId = String(msg.shopId || '');
    const itemId = msg.itemId ? String(msg.itemId) : '';
    if (!/^\d+$/.test(shopId) || (itemId && !/^\d+$/.test(itemId))) {
      sendResponse(null);
      return false;
    }
    reviewRatings(shopId, itemId).then(sendResponse).catch(() => sendResponse(null));
    return true; // 非同期応答
  }

  // 商品ページから: Amazonでの価格
  if (msg?.type === 'azr:amazonPrice') {
    const title = String(msg.title || '');
    const jan = msg.jan ? String(msg.jan) : '';
    const model = msg.model ? String(msg.model) : '';
    const hint = msg.hint ? String(msg.hint) : '';
    if (!title) {
      sendResponse({ status: 'error' });
      return false;
    }
    // 読み直しを挟むと30秒近くかかることがある。その間 service worker を止めさせない。
    holdAwake(() => amazonPrice({ title, jan, model, hint }))
      .then(sendResponse)
      .catch((e) => { console.warn('[AZR] Amazonの価格を取れない:', e); sendResponse({ status: 'error' }); });
    return true; // 非同期応答
  }

  // 獲得ページから: 自分は裏で開かれたタブか？（そうならパネルを出さずに結果だけ返す）
  if (msg?.type === 'azr:isGrabTab') {
    sendResponse({ grab: sender.tab?.id != null && couponWaiters.has(sender.tab.id) });
    return false;
  }

  // 獲得ページから: 獲得の結果
  if (msg?.type === 'azr:couponResult') {
    const done = sender.tab?.id != null && couponWaiters.get(sender.tab.id);
    if (done) done({ ok: Boolean(msg.ok), status: msg.status || 'unknown', message: msg.message || '' });
    return false;
  }

  // キャンペーンページから: 集めたコードで判定（とエントリー）
  if (msg?.type === 'azr:entryCodes') {
    enterByCodes(msg.items, Boolean(msg.entry)).catch(() => null).then(sendResponse);
    return true; // 非同期応答
  }

  // ポップアップから: 指定したURLでエントリーする
  if (msg?.type === 'azr:enterCampaignUrls') {
    enterCampaignUrls(Array.isArray(msg.urls) ? msg.urls.map(String) : []).then(sendResponse);
    return true; // 非同期応答
  }

  return false;
});

// ---- Amazon商品ページ用: 楽天検索（中継Worker経由）と閉店店舗の判定（旧 楽天比較リンク） ----
// 楽天検索は中継Worker経由（APIキーは拡張機能に含めない）
const RL_PROXY = 'https://amazon-rakuten-link.shin1007.workers.dev/search';

/*
 * 中継Workerへの問い合わせ。同じURLは30分まとめる（同時に来たものは1回の通信を待ち合わせ、終わったものは覚えておく）。
 * Yahoo!の商品ページは、商品名の補正（JANで他店の名前を引く）とJANでの価格で同じ問い合わせを2回するし、
 * 商品ページを開き直すたびに同じ検索語で引く。中継Workerには同じIPから1分60回の制限があるので、無駄に数を使わない。
 * 制限に当たった（429）ときは、少し待って1度だけ引き直す。失敗した応答は覚えない。
 *
 * service worker は30秒ほどで止まり、メモリの relayCache は消える。商品ページを開くたびに止まった後から
 * 始まることが多いので、成功した応答は session storage（ブラウザを閉じるまで残る）にも置く。
 */
const RELAY_TTL_MS = 30 * 60 * 1000;
const RELAY_RETRY_MS = 2000;
const RELAY_STORE_MAX = 150; // 1件15KB前後。session storage の上限（10MB）に余裕を残す
const relayCache = new Map(); // url → { at, promise }
const saveRelaySerially = serialized();

async function relayStored(url) {
    try {
        const { azrRelay: all = {} } = await chrome.storage.session.get('azrRelay');
        const hit = all[url];
        return hit && Date.now() - hit.at < RELAY_TTL_MS ? hit.res : null;
    } catch {
        return null; // session storage が使えない（テストなど）
    }
}

function relayStore(url, res) {
    if (!chrome.storage.session?.get) return null;
    return saveRelaySerially(async () => {
        const { azrRelay: all = {} } = await chrome.storage.session.get('azrRelay');
        const now = Date.now();
        for (const [k, v] of Object.entries(all)) if (now - v.at >= RELAY_TTL_MS) delete all[k];
        all[url] = { at: now, res };
        const keys = Object.keys(all);
        if (keys.length > RELAY_STORE_MAX) {
            for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - RELAY_STORE_MAX)) delete all[k];
        }
        await chrome.storage.session.set({ azrRelay: all });
    });
}

function relayFetch(url) {
    const now = Date.now();
    for (const [k, v] of relayCache) if (now - v.at >= RELAY_TTL_MS) relayCache.delete(k);
    const hit = relayCache.get(url);
    if (hit) return hit.promise;
    const promise = (async () => {
        const stored = await relayStored(url);
        if (stored) return stored;
        for (let i = 0; ; i++) {
            const r = await fetch(url, { credentials: 'omit' });
            const j = await r.json().catch(() => ({}));
            if (r.status === 429 && i === 0) { await new Promise((res) => setTimeout(res, RELAY_RETRY_MS)); continue; }
            const res = { ok: r.ok, status: r.status, json: j };
            if (res.ok) relayStore(url, res);
            return res;
        }
    })();
    relayCache.set(url, { at: now, promise });
    promise.then((r) => { if (!r.ok) relayCache.delete(url); }, () => relayCache.delete(url));
    return promise;
}

async function rlSearch(keyword) {
    const { ok, status, json: j } = await relayFetch(`${RL_PROXY}?keyword=${encodeURIComponent(keyword)}`);
    const r = { ok, status };
    health.check('relay.rakutenSearch', r.ok && Array.isArray(j.items), j.error || `HTTP ${r.status}`);
    if (!r.ok) return { error: j.error || `HTTP ${r.status}`, searchUrl: j.searchUrl };
    if (await noAffiliate()) {
      const plain = `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(keyword)}/`;
      return { count: j.count ?? 0, items: (j.items || []).map(({ affiliateUrl, ...it }) => it), searchUrl: plain };
    }
    return { count: j.count ?? 0, items: j.items || [], searchUrl: j.searchUrl };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'azr:rakutenSearch' || typeof msg.keyword !== 'string' || msg.keyword.length < 2) return;
    rlSearch(msg.keyword).then(sendResponse).catch(e => { health.check('relay.rakutenSearch', false, e); sendResponse({ error: String(e) }); });
    return true;
});

// ---- Yahoo!ショッピング（中継Worker経由。Client ID は拡張機能に含めない） ----
// 結果は楽天検索と同じ形（itemName / itemPrice / itemUrl / affiliateUrl / imageUrl / shopName）。
// リンクはバリューコマースのMyLink（vc_url に元のURLが入っている）。
const YS_PROXY = 'https://amazon-rakuten-link.shin1007.workers.dev/yahoo';
function unwrapVc(u) {
    try { return new URL(u).searchParams.get('vc_url') || u; } catch { return u; }
}

async function ysSearch({ keyword = '', jan = '' }) {
    const q = jan ? `jan=${encodeURIComponent(jan)}` : `keyword=${encodeURIComponent(keyword)}`;
    const { ok, status, json: j } = await relayFetch(`${YS_PROXY}?${q}`);
    const r = { ok, status };
    health.check('relay.yahooSearch', r.ok && Array.isArray(j.items), j.error || `HTTP ${r.status}`);
    if (!r.ok) return { error: j.error || `HTTP ${r.status}` };
    if (await noAffiliate()) {
        return { count: j.count ?? 0, items: (j.items || []).map(({ affiliateUrl, ...it }) => it), searchUrl: unwrapVc(j.searchUrl) };
    }
    return { count: j.count ?? 0, items: j.items || [], searchUrl: j.searchUrl };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'azr:yahooSearch') return;
    const jan = AZR.amazon.isJan(msg.jan) ? String(msg.jan) : '';
    const keyword = typeof msg.keyword === 'string' ? msg.keyword : '';
    if (!jan && keyword.length < 2) return;
    ysSearch({ keyword, jan }).then(sendResponse).catch(e => { health.check('relay.yahooSearch', false, e); sendResponse({ error: String(e) }); });
    return true;
});

/**
 * 楽天の商品ページ用: Yahoo!ショッピングでの価格。返す形は amazonPrice と同じ（item-amazon.js がそのまま描く）。
 * 引き方も同じで、JAN → 型番 → 商品名の重なり。JANで引くと安い順に返るので、先頭が同じ商品の最安。
 */
async function yahooPrice({ title, jan, model, hint = '' }) {
    const useJan = AZR.amazon.isJan(jan);
    const useModel = !useJan && Boolean(model);
    const query = useJan ? String(jan) : useModel ? String(model) : AZR.amazon.buildQuery(title);
    if (!query) return { status: 'none', query: '', searchUrl: null };
    let res = await ysSearch(useJan ? { jan: query } : { keyword: query });
    if (res.error) return { status: 'error', query, searchUrl: res.searchUrl || null };
    /*
     * Yahoo!ショッピングは語をすべて含む商品しか返さないので、Amazon向けの長い検索語（8語まで）では
     * 何も当たらないことが多い（「スカルプD 薬用スカルプシャンプー 350ml 頭皮タイプ別3種 ニオイ かゆみ」は0件、
     * 先頭3語なら57件）。商品名で引いて0件なら、先頭の3語で引き直す。
     */
    const SHORT_WORDS = 3;
    if (!useJan && !useModel && !res.items?.length && query.split(' ').length > SHORT_WORDS) {
        const short = await ysSearch({ keyword: query.split(' ').slice(0, SHORT_WORDS).join(' ') });
        if (!short.error) res = short;
    }
    const searchUrl = res.searchUrl;
    const items = (res.items || []).filter((it) => it.itemPrice > 0).map((it) => ({
        title: it.itemName, price: it.itemPrice, url: it.affiliateUrl || it.itemUrl, image: it.imageUrl,
        rating: it.rating || 0, count: it.reviewCount || 0, score: AZR.amazon.scoreMatch(title, it.itemName),
        shipping: yahooShipping(it.shippingCode)
    })).filter((it, _, all) => AZR.amazon.sameCondition(title, all).includes(it));
    if (!items.length) return { status: 'none', query, searchUrl };
    if (useJan) return { status: 'ok', query, searchUrl, byJan: true, item: items[0] };
    const best = (list) => list.reduce((a, b) => (!a || b.score > a.score ? b : a), null);
    if (useModel) {
        const hit = best(items.filter((it) => AZR.amazon.titleHasModel(model, it.title)));
        if (hit) return { status: 'ok', query, searchUrl, byModel: true, item: hit };
    }
    // 名前で引いたとき、こちらの型番が入っている候補があればそれが同じ商品。違う型番の候補は外す
    const { exact, rest } = AZR.amazon.splitByModel(items, hint);
    if (exact.length) return { status: 'ok', query, searchUrl, byModel: true, item: best(exact) };
    const top = best(rest);
    if (!top || top.score < AMAZON_MIN_SCORE) return { status: 'none', query, searchUrl };
    return { status: 'ok', query, searchUrl, byJan: false, item: top };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'azr:yahooPrice' || !msg.title) return;
    janThenModel(yahooPrice, { title: String(msg.title), jan: msg.jan ? String(msg.jan) : '', model: msg.model ? String(msg.model) : '', hint: msg.hint ? String(msg.hint) : '' })
        .then(sendResponse)
        .catch((e) => { console.warn('[AZR] Yahoo!ショッピングの価格を取れない:', e); sendResponse({ status: 'error' }); });
    return true;
});

/**
 * Yahoo!ショッピングの商品ページ用: 楽天での価格。返す形は amazonPrice・yahooPrice と同じ（item-amazon.js がそのまま描く）。
 * 楽天の検索にはJANの欄が無いので、JANも語として引く（商品名・説明にJANを書く店が多い）。JANで当たった中では最安を選ぶ
 * （同じJANのまとめ売りは高い方に来る）。閉店・改装中の店舗の商品は選ばない。
 * Amazonと違い、価格は覚えておかない（中継Workerが1時間キャッシュしている）。
 */
async function rakutenPrice({ title, jan, model, hint = '' }) {
    const useJan = AZR.amazon.isJan(jan);
    const useModel = !useJan && Boolean(model);
    const query = useJan ? String(jan) : useModel ? String(model) : AZR.amazon.buildQuery(title);
    if (!query) return { status: 'none', query: '', searchUrl: null };
    let res = await rlSearch(query);
    if (res.error) return { status: 'error', query, searchUrl: res.searchUrl || null };
    // 楽天も語をすべて含む商品しか返さない。商品名で引いて0件なら、先頭の3語で引き直す（yahooPrice と同じ）
    const SHORT_WORDS = 3;
    if (!useJan && !useModel && !res.items?.length && query.split(' ').length > SHORT_WORDS) {
        const short = await rlSearch(query.split(' ').slice(0, SHORT_WORDS).join(' '));
        if (!short.error) res = short;
    }
    const searchUrl = res.searchUrl;
    const items = (res.items || []).filter((it) => it.itemPrice > 0).map((it) => ({
        title: it.itemName, price: it.itemPrice, url: it.affiliateUrl || it.itemUrl, image: it.imageUrl,
        shop: it.shopCode || '', score: AZR.amazon.scoreMatch(title, it.itemName),
        shipping: rakutenShipping(it.postageFlag)
    })).filter((it, _, all) => AZR.amazon.sameCondition(title, all).includes(it));
    // JANは語として引くので、説明に別の商品のJANまで並べた店の商品も当たる。名前の重なりが極端に低いものは外す
    const topScore = Math.max(0, ...items.map((it) => it.score));
    const ranked = useJan ? items.filter((it) => it.score >= topScore / 2).sort((a, b) => a.price - b.price)
        : useModel ? items.filter((it) => AZR.amazon.titleHasModel(model, it.title)).sort((a, b) => b.score - a.score)
        : [];
    // 名前で引いたとき、こちらの型番が入っている候補を先に、違う型番の候補は外す
    const { exact, rest } = AZR.amazon.splitByModel(items, hint);
    const byName = [...[...exact].sort((a, b) => b.score - a.score),
        ...rest.filter((it) => !exact.includes(it) && it.score >= AMAZON_MIN_SCORE).sort((a, b) => b.score - a.score)];
    // 上から順に、店が開いているものを選ぶ（判定できないときは開いているとみなす）
    // 上位5件の店を同時に問い合わせ、上から順に開いているものを選ぶ（判定はヘッダーだけで済むので軽い）
    const firstOpen = async (list) => {
        const top = list.slice(0, 5);
        const open = top.map((it) => (it.shop ? rlIsShopOpen(it.shop) : Promise.resolve(true)));
        for (let i = 0; i < top.length; i++) {
            if ((await open[i]) !== false) return top[i];
        }
        return null;
    };
    const strip = ({ shop, ...it }) => it;
    const hit = await firstOpen(ranked);
    if (hit) return { status: 'ok', query, searchUrl, byJan: useJan, byModel: useModel, item: strip(hit) };
    const top = await firstOpen(byName);
    if (!top) return { status: 'none', query, searchUrl };
    return { status: 'ok', query, searchUrl, byJan: false, byModel: exact.includes(top), item: strip(top) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'azr:rakutenPrice' || !msg.title) return;
    janThenModel(rakutenPrice, { title: String(msg.title), jan: msg.jan ? String(msg.jan) : '', model: msg.model ? String(msg.model) : '', hint: msg.hint ? String(msg.hint) : '' })
        .then(sendResponse)
        .catch((e) => { console.warn('[AZR] 楽天の価格を取れない:', e); sendResponse({ status: 'error' }); });
    return true;
});

// 閉店・休止店舗の判定。改装中の店舗はトップ https://www.rakuten.co.jp/<店舗>/ が kaiso.html へリダイレクトされる
// （商品ページより応答が速いのでトップを見る）。結果は24時間キャッシュ
const RL_SHOP_TTL = 24 * 60 * 60 * 1000;

const saveShopsSerially = serialized();

async function rlIsShopOpen(shop) {
    const { azrShops: shops = {} } = await chrome.storage.local.get('azrShops');
    const cached = shops[shop];
    if (cached && Date.now() - cached.at < RL_SHOP_TTL) return cached.open;
    let open;
    try {
        const r = await fetch(`https://www.rakuten.co.jp/${encodeURIComponent(shop)}/`, { credentials: 'omit', redirect: 'manual' });
        // 判定はステータスとリダイレクトだけで決まる。店舗トップの本文（重い）は受け取らずに切る
        r.body?.cancel?.().catch(() => {});
        if (r.type === 'opaqueredirect') open = false;
        else if (r.ok) open = true;
        else return null;
    } catch {
        return null;
    }
    // 1つのキーにまとめ、期限切れはここで捨てる（以前は店舗ごとのキーで、消されずに溜まり続けた）
    await saveShopsSerially(async () => {
        const { azrShops: all = {} } = await chrome.storage.local.get('azrShops');
        const now = Date.now();
        for (const [k, v] of Object.entries(all)) if (now - v.at >= RL_SHOP_TTL) delete all[k];
        all[shop] = { open, at: now };
        await chrome.storage.local.set({ azrShops: all });
    });
    return open;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'azr:rakutenCheckShops' || !Array.isArray(msg.shops)) return;
    const shops = msg.shops.filter(s => typeof s === 'string' && /^[\w-]+$/.test(s)).slice(0, 10);
    Promise.all(shops.map(async s => [s, await rlIsShopOpen(s)]))
        .then(entries => sendResponse(Object.fromEntries(entries)))
        .catch(() => sendResponse({}));
    return true;
});

/* セルフチェックの記録（開発版だけ。仕組みは src/lib/health.js） ---------------------
 * chrome.storage.local の azrHealth に、確認ごとの最後の結果と、起きたことの回数を残す。
 *   checks[id] = { ok, detail, url, at, okAt, failAt, since, fails }   since: 失敗が続いている起点
 *   events[id] = { detail, url, at, count, unseen }                   unseen: ポップアップで既読にするまでの回数
 * 失敗中の確認と、未読の出来事がある数をアイコンのバッジに出す（キャンペーンのスキャン中はスキャンの表示を優先）。
 */
const HEALTH_EVENTS_MAX = 100;
const saveHealthSerially = serialized();

function recordHealth(r) {
  if (!health.dev || !r?.id) return;
  return saveHealthSerially(async () => {
    const { azrHealth: h = { checks: {}, events: {} } } = await chrome.storage.local.get('azrHealth');
    h.checks ||= {};
    h.events ||= {};
    const base = { detail: String(r.detail || '').slice(0, 300), url: String(r.url || '').slice(0, 300), at: r.at || Date.now() };
    if (r.kind === 'check') {
      const prev = h.checks[r.id] || {};
      h.checks[r.id] = r.ok
        ? { ...prev, ok: true, at: base.at, okAt: base.at, since: null }
        : { ...prev, ...base, ok: false, failAt: base.at, since: prev.ok === false ? prev.since : base.at, fails: (prev.fails || 0) + 1 };
    } else {
      const prev = h.events[r.id] || {};
      h.events[r.id] = { ...base, count: (prev.count || 0) + 1, unseen: (prev.unseen || 0) + 1 };
      const ids = Object.keys(h.events);
      if (ids.length > HEALTH_EVENTS_MAX) {
        for (const id of ids.sort((a, b) => h.events[a].at - h.events[b].at).slice(0, ids.length - HEALTH_EVENTS_MAX)) delete h.events[id];
      }
    }
    await chrome.storage.local.set({ azrHealth: h });
    // 新しく壊れたとき（成功→失敗、初めての失敗、既読後の警告）だけ通知する。失敗が続いても毎回は鳴らさない
    const fresh = r.kind === 'check' ? !r.ok && h.checks[r.id].since === base.at : h.events[r.id].unseen === 1;
    if (fresh) notifyHealthSoon();
  });
}
health.setSink(recordHealth);

/*
 * 修正すべき箇所の通知（開発版だけ）。通知の権限は任意の権限で、ポップアップの「通知を受け取る」で許可する
 * （ストア版の利用者に権限の確認を出さないため）。ページを開くと確認がまとめて届くので、少し待ってから1回にまとめる。
 * 通知を押すとポップアップ（一覧と「修正リストをコピー」）を開く。
 */
const HEALTH_NOTIFY_ID = 'azr-health';
let healthNotifyTimer = null;

function notifyHealthSoon() {
  clearTimeout(healthNotifyTimer);
  healthNotifyTimer = setTimeout(notifyHealth, 5000);
}

async function notifyHealth() {
  if (!chrome.notifications) return; // まだ許可されていない
  const { azrHealth: h } = await chrome.storage.local.get('azrHealth');
  const items = [
    ...Object.entries(h?.checks || {}).filter(([, c]) => c.ok === false),
    ...Object.entries(h?.events || {}).filter(([, e]) => e.unseen > 0)
  ].sort(([, a], [, b]) => (b.failAt || b.at) - (a.failAt || a.at));
  if (!items.length) return chrome.notifications.clear(HEALTH_NOTIFY_ID);
  const lines = items.slice(0, 4).map(([id, c]) => `・${health.label(id)}${c.detail ? `（${c.detail.slice(0, 60)}）` : ''}`);
  if (items.length > 4) lines.push(`ほか ${items.length - 4}件`);
  chrome.notifications.create(HEALTH_NOTIFY_ID, {
    type: 'basic',
    iconUrl: '/icons/icon-128.png',
    title: `Amazonize Rakuten: 修正が必要な箇所 ${items.length}件`,
    message: lines.join('\n'),
    contextMessage: 'サイトの形が変わった可能性があります。押すと一覧を開きます',
    priority: 1
  }).catch?.(() => {});
}

function openHealthList() {
  chrome.action.openPopup().catch(() => chrome.tabs.create({ url: '/src/popup/popup.html' }));
}

if (health.dev) {
  const listen = () => chrome.notifications?.onClicked.addListener((id) => {
    if (id !== HEALTH_NOTIFY_ID) return;
    chrome.notifications.clear(id);
    openHealthList();
  });
  listen();
  // ポップアップで許可されたら、そこから通知を使えるようにする
  chrome.permissions?.onAdded.addListener((p) => {
    if (!p.permissions?.includes('notifications')) return;
    listen();
    notifyHealth();
  });
}

async function updateHealthBadge() {
  if (scanState?.running) return;
  let n = 0;
  if (health.dev) {
    const { azrHealth: h } = await chrome.storage.local.get('azrHealth');
    n = Object.values(h?.checks || {}).filter((c) => c.ok === false).length
      + Object.values(h?.events || {}).filter((e) => e.unseen > 0).length;
  }
  chrome.action.setBadgeBackgroundColor({ color: '#d00' }).catch(() => {});
  chrome.action.setBadgeText({ text: n ? String(n) : '' }).catch(() => {});
}

if (health.dev) {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== 'azr:health' || !msg.report) return;
    recordHealth({ ...msg.report, url: msg.report.url || sender.tab?.url || '' });
  });
  // ポップアップが既読にした・消したときも、記録が増えたときも、ここでバッジを合わせる
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.azrHealth) updateHealthBadge();
  });
  updateHealthBadge();
}
