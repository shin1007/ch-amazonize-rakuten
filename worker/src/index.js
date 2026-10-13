// 楽天市場商品検索APIの中継（キーはWorkerのSecretにのみ保持）
import privacyHtml from './privacy.html';
const API = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';
const CACHE_TTL = 3600;
/*
 * 失敗も短い間だけ覚える。同じ検索語で失敗が続くと、そのたびに外部APIを呼び、回数制限を食い合う。
 * 検索語が悪い（4xx）ものは何度呼んでも同じなので長めに、混雑・障害（429・5xx）はすぐ引き直せるよう短く。
 * KV の期限は60秒より短くできない。
 */
const ERROR_TTL_BAD = 600;
const ERROR_TTL_BUSY = 60;
const errorTtl = (result) => (/^upstream 4(?!29)/.test(result.error || '') ? ERROR_TTL_BAD : ERROR_TTL_BUSY);

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra }
});

async function callRakuten(keyword, env) {
    const params = new URLSearchParams({
        applicationId: env.RAKUTEN_APP_ID, accessKey: env.RAKUTEN_ACCESS_KEY, keyword,
        format: 'json', formatVersion: '2', hits: '30', availability: '1'
    });
    if (env.RAKUTEN_AFFILIATE_ID) params.set('affiliateId', env.RAKUTEN_AFFILIATE_ID);
    // 楽天は「許可されたWebサイト」とOriginを照合する
    const headers = { Origin: env.ALLOWED_ORIGIN, Referer: env.ALLOWED_ORIGIN + '/' };
    for (let i = 0; i < 2; i++) {
        const r = await fetch(`${API}?${params}`, { headers });
        if (r.status === 429) { await new Promise(res => setTimeout(res, 1000)); continue; }
        if (r.status === 404) return { count: 0, items: [] };
        if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            const e = body.errors || body;
            return { error: `upstream ${r.status}`, detail: e.errorMessage || e.error_description || e.error || null };
        }
        const j = await r.json();
        return {
            count: j.count ?? 0,
            // postageFlag: 0 は送料込み、1 は送料別（金額はAPIに無い）
            items: (j.Items || j.items || []).map(x => x.Item || x.item || x).map(({ itemName, itemPrice, itemUrl, affiliateUrl, shopName, shopCode, mediumImageUrls, postageFlag }) =>
                ({ itemName, itemPrice, itemUrl, affiliateUrl, shopName, shopCode, imageUrl: mediumImageUrls?.[0]?.imageUrl || mediumImageUrls?.[0] || '', postageFlag }))
        };
    }
    return { error: 'too_many_requests' };
}

// 検索結果ページのURL（アフィリエイトIDがあれば任意URL型のアフィリエイトリンクにする）
function searchPageUrl(keyword, env) {
    const url = `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(keyword)}/`;
    if (!env.RAKUTEN_AFFILIATE_ID) return url;
    const enc = encodeURIComponent(url);
    return `https://hb.afl.rakuten.co.jp/hgc/${env.RAKUTEN_AFFILIATE_ID}/?pc=${enc}&m=${enc}`;
}

// ---- Yahoo!ショッピング商品検索API v3 の中継（Client ID は Worker の Secret: YAHOO_APP_ID） ----
// 楽天APIの結果と同じ形（itemName / itemPrice / itemUrl / affiliateUrl / shopName / imageUrl）で返すので、
// 拡張側は楽天の候補と同じ並べ替え・表示を使い回せる。
const YAHOO_API = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch';

// バリューコマースのMyLink（sid/pid があるときだけ。Yahoo!ショッピングのどのURLでも包める）
function vcLink(target, env) {
    if (!env.YAHOO_VC_SID || !env.YAHOO_VC_PID) return null;
    return `https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=${env.YAHOO_VC_SID}&pid=${env.YAHOO_VC_PID}&vc_url=${encodeURIComponent(target)}`;
}

async function callYahoo({ keyword, jan }, env) {
    // JANで引くときは安い順（同じ商品の最安の出品が先頭）。商品名で引くときは関連度順
    const params = new URLSearchParams({ appid: env.YAHOO_APP_ID, results: '30', in_stock: 'true', condition: 'new', sort: jan ? '+price' : '-score' });
    if (jan) params.set('jan_code', jan); else params.set('query', keyword);
    for (let i = 0; i < 2; i++) {
        const r = await fetch(`${YAHOO_API}?${params}`);
        if (r.status === 429) { await new Promise(res => setTimeout(res, 1000)); continue; }
        if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            return { error: `upstream ${r.status}`, detail: body.Error?.Message || null };
        }
        const j = await r.json();
        return {
            count: j.totalResultsAvailable ?? 0,
            // shippingCode: 1 は設定なし、2 は送料無料、3 は条件付き送料無料（金額はAPIに無い）
            items: (j.hits || []).map(({ name, price, url, seller, image, review, janCode, shipping }) => ({
                itemName: name, itemPrice: price, itemUrl: url, affiliateUrl: vcLink(url, env) || undefined,
                shopName: seller?.name || '', imageUrl: image?.medium || image?.small || '',
                rating: review?.rate || 0, reviewCount: review?.count || 0, janCode: janCode || '', shippingCode: shipping?.code || 0
            }))
        };
    }
    return { error: 'too_many_requests' };
}

const yahooSearchPage = (q) => `https://shopping.yahoo.co.jp/search?p=${encodeURIComponent(q)}`;

/**
 * 回数制限（同じIPから1分60回）。キャッシュ（KVも含む）に当たった応答は外部APIを呼ばないので数えない
 * （商品ページを続けて開くと、同じ検索語の問い合わせが重なって制限に当たっていた）。
 */
async function limited(request, env) {
    if (!env.LIMITER) return null;
    const { success } = await env.LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
    return success ? null : json({ error: 'rate_limited' }, 429);
}

/**
 * キャッシュを通して答える。順に
 *   1. このデータセンターのキャッシュ（caches.default。速いが、データセンターごとに別）
 *   2. KV（RELAY_CACHE。全データセンターで共通。ほかの地域の利用者が引いた結果も使える）
 *   3. 外部API（ここに来たときだけ回数制限を数える）
 * 失敗は KV にだけ短い期限で置く（応答は 502 のまま返す）。KV が無い・書けない（無料枠の書き込み上限など）ときは飛ばす。
 */
async function cachedAnswer({ origin, path, env, ctx, request, produce }) {
    const cacheKey = new Request(`${origin}${path}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    const kv = env.RELAY_CACHE;
    const stored = kv ? await kv.get(path, 'json').catch(() => null) : null;
    if (stored?.result) {
        if (stored.status !== 200) return json(stored.result, stored.status);
        const res = json(stored.result, 200, { 'cache-control': `public, max-age=${CACHE_TTL}` });
        ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
        return res;
    }

    const over = await limited(request, env);
    if (over) return over;

    const result = await produce();
    const status = result.error ? 502 : 200;
    if (kv) {
        const ttl = result.error ? errorTtl(result) : CACHE_TTL;
        ctx.waitUntil(kv.put(path, JSON.stringify({ status, result }), { expirationTtl: ttl }).catch(() => {}));
    }
    if (result.error) return json(result, status);
    const res = json(result, 200, { 'cache-control': `public, max-age=${CACHE_TTL}` });
    ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
    return res;
}

async function handleYahoo(url, env, ctx, request) {
    if (!env.YAHOO_APP_ID) return json({ error: 'not_configured' }, 503);
    const jan = (url.searchParams.get('jan') || '').replace(/\D/g, '');
    const keyword = (url.searchParams.get('keyword') || '').replace(/\s+/g, ' ').trim();
    if (jan ? !/^(\d{8}|\d{13})$/.test(jan) : (keyword.length < 2 || keyword.length > 128)) return json({ error: 'bad_keyword' }, 400);

    return cachedAnswer({
        origin: url.origin, path: `/yahoo?v=2&${jan ? `jan=${jan}` : `keyword=${encodeURIComponent(keyword)}`}`, env, ctx, request,
        produce: async () => {
            const result = await callYahoo({ keyword, jan }, env);
            const page = yahooSearchPage(jan || keyword);
            result.searchUrl = vcLink(page, env) || page;
            return result;
        }
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/privacy') {
            return new Response(privacyHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        if (request.method !== 'GET' || (url.pathname !== '/search' && url.pathname !== '/yahoo')) return json({ error: 'not_found' }, 404);

        if (url.pathname === '/yahoo') return handleYahoo(url, env, ctx, request);

        const keyword = (url.searchParams.get('keyword') || '').replace(/\s+/g, ' ').trim();
        if (keyword.length < 2 || keyword.length > 128) return json({ error: 'bad_keyword' }, 400);

        // 正規化したキーワードでキャッシュ
        return cachedAnswer({
            origin: url.origin, path: `/search?v=8&keyword=${encodeURIComponent(keyword)}`, env, ctx, request,
            produce: async () => {
                const result = await callRakuten(keyword, env);
                result.searchUrl = searchPageUrl(keyword, env);
                return result;
            }
        });
    }
};
