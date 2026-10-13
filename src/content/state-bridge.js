/*
 * Amazonize Rakuten - かご/会計SPAの状態ブリッジ（MAINワールドで動く）
 *
 * かご・購入手続きは cart.step.rakuten.co.jp の単一のReact/Reduxアプリで、
 * 金額・ポイント・クーポンはすべて window.__INITIAL_STATE__ に入っている。
 * DOMのクラス名はCSSモジュールのハッシュ付き（例 spacer--1O71j）でデプロイごとに
 * 変わるため、表示テキストを漁るより状態を読むほうが桁違いに安定する。
 *
 * ただし __INITIAL_STATE__ はページ側のグローバルで、コンテンツスクリプト
 * （分離ワールド）からは見えない。そこでこのファイルだけを MAIN ワールドで動かし、
 * 必要な部分だけを postMessage でコンテンツスクリプトへ渡す。
 *
 * **氏名・住所・電話・メール・カード情報は絶対に渡さない。** 状態には
 * ordererContactInfo / shippingInfo / paymentInfo などが含まれるので、
 * ここで明示したキーだけを抜き出す（ホワイトリスト方式）。
 */
(() => {
  const CHANNEL = 'azr:state';

  /** 渡してよい金額まわりのキーだけを取り出す */
  function slim(state) {
    if (!state || typeof state !== 'object') return null;

    const shops = {};
    for (const [id, s] of Object.entries(state.shops || {})) {
      shops[id] = { shopName: s?.shopName ?? '', shopUrl: s?.shopUrl ?? '' };
    }

    const items = {};
    for (const [id, entry] of Object.entries(state.shopItems || {})) {
      items[id] = Object.values(entry?.items || {}).map((it) => ({
        itemName: it?.itemName ?? '',
        price: Number(it?.price) || 0,
        quantity: Number(it?.quantity) || 0
      }));
    }

    const subtotals = {};
    for (const [id, t] of Object.entries(state.shopItemSubtotals || {})) {
      subtotals[id] = {
        itemCount: Number(t?.itemCount) || 0,
        itemTotalPrice: Number(t?.itemTotalPrice) || 0,
        // fee/wrappingFee/couponUsage は購入手続き側でだけ入ることがある
        fee: Number(t?.fee) || 0,
        wrappingFee: Number(t?.wrappingFee) || 0,
        couponUsage: Number(t?.couponUsage) || 0,
        pointsUsage: Number(t?.pointsUsage) || 0,
        paymentAmount: Number(t?.paymentAmount) || 0,
        shippingFeeType: t?.shippingFeeType ?? '',
        pointRate: Number(t?.pointRate) || 0,
        pointValue: Number(t?.pointValue) || 0,
        enablePurchase: Boolean(t?.enablePurchase)
      };
    }

    // クーポンは店舗ごとの配列。項目の形は店舗によって揺れるため、そのまま渡す。
    // 個人情報は含まれない（クーポン名・割引額・利用条件だけ）。
    const shopCoupons = {};
    for (const [id, list] of Object.entries(state.shopCoupons || {})) {
      shopCoupons[id] = Array.isArray(list) ? list : [];
    }

    const p = state.pointsUsage || {};

    return {
      route: location.pathname,
      shopDisplayOrder: state.shopDisplayOrder || null,
      shops,
      items,
      subtotals,
      shopCoupons,
      pointsUsage: {
        canUsePoints: Boolean(p.canUsePoints),
        useAmountType: p.useAmountType ?? 'none',
        usePointsAndCash: Number(p.usePointsAndCash) || 0
      }
    };
  }

  /*
   * __INITIAL_STATE__ は**ページを読み込んだ時点のスナップショットで、その後は
   * 更新されない**（数量変更やクーポン適用をしても古いままなのを実機で確認した）。
   * Reduxのstoreには手が届かないので、SPAが叩くAPIの応答をここで拾って重ねる。
   * 応答には状態と同じ形（shopItemSubtotals など）で最新の金額が入っている。
   */
  const OVERLAY_KEYS = ['shops', 'shopItems', 'shopItemSubtotals', 'shopCoupons', 'shopDisplayOrder', 'pointsUsage'];
  const MAP_KEYS = ['shops', 'shopItems', 'shopItemSubtotals', 'shopCoupons'];
  let overlay = {};
  let overlayVersion = 0; // 重ねた応答が変わるたびに増やす（見張りの空回りを省くため）

  /** APIの応答らしきJSONから、状態と同じ形の部分だけを取り込む */
  function absorb(json) {
    if (!json || typeof json !== 'object') return false;
    // 応答は素のこともあれば { data: {...} } に包まれていることもある
    const candidates = [json, json.data, json.result, json.state].filter((v) => v && typeof v === 'object');
    let changed = false;
    for (const c of candidates) {
      for (const k of OVERLAY_KEYS) {
        if (c[k] && typeof c[k] === 'object') {
          // 店舗ごとの表は、応答に載った店舗だけ差し替える。丸ごと置くと、
          // 1店舗ぶんだけの応答で他店舗が消え、合計が欠ける。
          overlay[k] = MAP_KEYS.includes(k) ? { ...overlay[k], ...c[k] } : c[k];
          changed = true;
        }
      }
    }
    if (changed) overlayVersion++;
    return changed;
  }

  let lastJson = '';
  function publish(force) {
    // document_start ではまだ __INITIAL_STATE__ が無い。ここで空の状態を流すと、
    // 受け手はそれを最初の状態として受け取り「かごが空」と判断してしまう（実機で踏んだ）。
    // 中身が来るまでは何も流さない。
    if (!window.__INITIAL_STATE__ && !Object.keys(overlay).length) return;
    let data = null;
    try {
      const base = window.__INITIAL_STATE__ || {};
      const merged = { ...base, ...overlay };
      // 店舗ごとの表は初期状態に重ねる（応答が一部の店舗だけでも他店舗を残す）
      for (const k of MAP_KEYS) {
        if (overlay[k]) merged[k] = { ...base[k], ...overlay[k] };
      }
      data = slim(merged);
    } catch {
      return; // 状態の形が変わっても、ページ側を壊さない
    }
    if (!data) return;
    const json = JSON.stringify(data);
    if (!force && json === lastJson) return;
    lastJson = json;
    window.postMessage({ source: CHANNEL, data }, location.origin);
  }

  const MAX_BODY = 2_000_000; // 商品説明などで応答は大きい。無制限には読まない。
  // 取り込むキーが1つも書かれていない応答は、JSONとして解析しない（ページの通信をすべて解析すると重い）
  const HAS_STATE = new RegExp(`"(?:${OVERLAY_KEYS.join('|')})"\\s*:`);
  const worthParsing = (t) => t && t.length <= MAX_BODY && HAS_STATE.test(t);

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(...args) {
      const p = nativeFetch.apply(this, args);
      p.then((res) => {
        try {
          if (!res || !res.ok) return;
          if (!/json/i.test(res.headers.get('content-type') || '')) return;
          res.clone().text().then((t) => {
            if (!worthParsing(t)) return;
            try { if (absorb(JSON.parse(t))) publish(false); } catch { /* JSONでなければ捨てる */ }
          }, () => {});
        } catch { /* ページ側の動きは絶対に止めない */ }
      }, () => {});
      return p;
    };
  }

  const nativeSend = window.XMLHttpRequest?.prototype?.send;
  if (typeof nativeSend === 'function') {
    window.XMLHttpRequest.prototype.send = function patchedSend(...args) {
      try {
        this.addEventListener('load', () => {
          try {
            const t = this.responseType === '' || this.responseType === 'text' ? this.responseText : null;
            if (!worthParsing(t)) return;
            if (absorb(JSON.parse(t))) publish(false);
          } catch { /* JSONでなければ捨てる */ }
        });
      } catch { /* noop */ }
      return nativeSend.apply(this, args);
    };
  }

  // 画面遷移（/cart → /order-confirmation）では __INITIAL_STATE__ が入れ替わる。
  // 遷移（history の pushState / replaceState / popstate）とページの読み込みの節目で読み、差分があるときだけ流す。
  // 以前は500msごとに見張っていたが、ページを開いている間ずっと動くので、節目で見るのを主にした。
  //
  // 重ねた応答を捨てるのは、画面そのもの（パスの先頭）が変わったときだけ。
  // クーポンを選ぶモーダルは /order-confirmation/coupon-usage という子の経路で、
  // 閉じると /order-confirmation に戻る。ここで捨てると、適用した直後の金額が消えて
  // 古い __INITIAL_STATE__（クーポン無し）に戻ってしまう（実機で踏んだ）。
  //
  // 状態全体の抜き出しと JSON 化は重いので、毎回はやらない。流す中身の元になるもの
  // （__INITIAL_STATE__ の参照・重ねた応答・パス）がどれも変わっていなければ飛ばす。
  // __INITIAL_STATE__ が差し替えではなく中身だけ書き換えられる場合に備えて、
  // 6秒に1回は変化の有無にかかわらず比べ直す（取りこぼしの保険も兼ねて、3秒ごとにも軽く見る）。
  const screenOf = (path) => path.split('/')[1] || '';
  const SAFETY_MS = 3000;
  const FULL_CHECK_EVERY = 2; // 3秒 × 2
  let lastScreen = screenOf(location.pathname);
  let lastInputs = null;
  let tick = 0;
  function check() {
    const screen = screenOf(location.pathname);
    if (screen !== lastScreen) {
      lastScreen = screen;
      overlay = {}; // 別の画面の数字を持ち越さない
      overlayVersion++;
    }
    const inputs = [window.__INITIAL_STATE__, overlayVersion, location.pathname];
    const same = lastInputs && inputs.every((v, i) => v === lastInputs[i]);
    tick = (tick + 1) % FULL_CHECK_EVERY;
    if (same && tick !== 0) return;
    lastInputs = inputs;
    publish(false);
  }
  setInterval(check, SAFETY_MS);

  // 遷移の直後は __INITIAL_STATE__ の差し替えが少し遅れて来ることがあるので、間をおいて数回見る。
  // コンテンツスクリプト（分離ワールド）は history の呼び出しを見られないので、遷移をここから知らせる。
  const ROUTE_CHANNEL = 'azr:route';
  function onNavigate() {
    window.postMessage({ source: ROUTE_CHANNEL, path: location.pathname }, location.origin);
    for (const ms of [0, 300, 1000, 2500]) setTimeout(check, ms);
  }
  for (const name of ['pushState', 'replaceState']) {
    const native = window.history?.[name];
    if (typeof native !== 'function') continue;
    window.history[name] = function patchedHistory(...args) {
      const r = native.apply(this, args);
      try { onNavigate(); } catch { /* ページ側の動きは止めない */ }
      return r;
    };
  }
  window.addEventListener('popstate', onNavigate);
  // 最初の __INITIAL_STATE__ は document_start より後に書かれる
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', check);
  window.addEventListener('load', check);

  // コンテンツスクリプト側が後から立ち上がったときのための再送要求
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'azr:state:request') return;
    publish(true);
  });

  publish(true);
})();
