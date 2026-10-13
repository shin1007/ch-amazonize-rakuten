/* Amazonize Rakuten - DOM helpers */
(() => {
  const AZR = (window.AZR = window.AZR || {});

  /** 複数候補セレクタから最初に見つかった要素を返す */
  function pick(root, selectors) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch { /* 不正なセレクタは無視 */ }
    }
    return null;
  }

  function pickAll(root, selectors) {
    for (const sel of selectors) {
      try {
        const els = root.querySelectorAll(sel);
        if (els.length) return Array.from(els);
      } catch { /* noop */ }
    }
    return [];
  }

  /** 条件が満たされるまで待つ（MutationObserver + タイムアウト） */
  function waitFor(fn, { timeout = 8000, root = document } = {}) {
    return new Promise((resolve) => {
      const immediate = fn();
      if (immediate) return resolve(immediate);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve(v);
      };
      const obs = new MutationObserver(() => {
        const v = fn();
        if (v) finish(v);
      });
      obs.observe(root === document ? document.documentElement : root, {
        childList: true, subtree: true
      });
      const timer = setTimeout(() => finish(null), timeout);
    });
  }

  /** DOMが落ち着くまで（変化が quiet ms 止まるまで）待つ */
  function waitSettled({ quiet = 400, timeout = 6000 } = {}) {
    return new Promise((resolve) => {
      let timer = setTimeout(finish, quiet);
      const hard = setTimeout(finish, timeout);
      const obs = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, quiet);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      function finish() {
        obs.disconnect();
        clearTimeout(timer);
        clearTimeout(hard);
        resolve();
      }
    });
  }

  /** 属性オブジェクトか、それとも子要素か。Node や配列や文字列は子とみなす。 */
  function isAttrs(v) {
    return v !== null && typeof v === 'object' && !(v instanceof Node) && !Array.isArray(v);
  }

  /** 要素生成: h('div.foo', {attrs}, ...children) / h('div.foo', ...children) */
  function h(tagSpec, attrs, ...children) {
    if (!isAttrs(attrs)) {
      // 属性を省略した呼び出し。第2引数は最初の子。
      if (attrs !== undefined) children.unshift(attrs);
      attrs = {};
    }
    const [tag, ...classes] = String(tagSpec).split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /** "1,234円" / "￥1,234" / "1234" → 1234 (見つからなければ null) */
  function parseYen(text) {
    if (!text) return null;
    const normalized = String(text)
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[,，\s]/g, '');
    const m = normalized.match(/(\d+)\s*円|[¥￥]\s*(\d+)|(\d{3,})/);
    if (!m) return null;
    const n = Number(m[1] ?? m[2] ?? m[3]);
    return Number.isFinite(n) ? n : null;
  }

  const yen = (n) => {
    if (!Number.isFinite(n)) return '—';
    const v = Math.round(n).toLocaleString(AZR.numberLocale);
    return !AZR.isJa ? `¥${v}` : `${v}円`;
  };

  /** DOMContentLoaded。ページの同期スクリプトがすべて走り終わった時点。 */
  const domReady = new Promise((resolve) => {
    if (document.readyState !== 'loading') resolve();
    else document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });

  /** 同じidのパネルを重複挿入しない */
  function mountOnce(id, build, parent = document.body) {
    if (!parent) return null;
    const existing = document.getElementById(id);
    if (existing) return existing;
    const el = build();
    if (!el) return null;
    el.id = id;
    parent.append(el);
    return el;
  }

  /**
   * 現在のページ種別。
   *
   * かごと購入手続きは cart.step.rakuten.co.jp の単一SPAで、画面はパスで分かれる
   * （/cart → /shipping-address → /order-confirmation）。ページ遷移は起きないので、
   * 種別はそのつど location から判定し直す（boot.js が経路変更を見張っている）。
   */
  function pageKind() {
    const { host, pathname } = location;
    if (host === 'www.rakuten.co.jp') return 'top';
    if (host === 'item.rakuten.co.jp') return 'item';
    if (host === 'search.rakuten.co.jp') return 'search';
    if (host === 'cart.step.rakuten.co.jp') {
      if (pathname.startsWith('/order-confirmation')) return 'checkout';
      if (pathname === '/' || pathname.startsWith('/cart')) return 'cart';
      return 'other'; // 住所・支払い方法の入力途中には手を出さない
    }
    if (host === 'order.my.rakuten.co.jp') return 'orders';
    // 旧URL。いまは cart.step.rakuten.co.jp/cart へ転送される
    if (/(^|\.)basket\.step\.rakuten\.co\.jp$/.test(host)) return 'cart';
    if (host === 'step.item.rakuten.co.jp' || host === 'order.step.rakuten.co.jp') return 'checkout';
    // event ドメインを先に見る。キャンペーンページのURLには
    // .../itemcoupon/ のように coupon を含むものがあり、
    // パスだけで判定するとクーポンページ扱いになってキャンペーンの処理が動かない。
    if (host === 'event.rakuten.co.jp') return 'campaign';
    if (host === 'coupon.rakuten.co.jp' || /coupon/i.test(pathname)) return 'coupon';
    return 'other';
  }

  /* かご/会計SPAの状態受け取り ------------------------------------------------
   * state-bridge.js（MAINワールド）が postMessage で流してくる。
   * 中身は金額・ポイント・クーポンだけ。個人情報は向こうで落としてある。 */

  let latestState = null;
  const stateListeners = new Set();

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'azr:state') return;
    latestState = e.data.data;
    for (const cb of stateListeners) {
      try { cb(latestState); } catch (err) { AZR.warn('state listener failed:', err); }
    }
  });

  /** 状態が届くたびに呼ばれる。すでに届いていればその場で1回呼ぶ。 */
  function onState(cb) {
    stateListeners.add(cb);
    if (latestState) cb(latestState);
    else window.postMessage({ source: 'azr:state:request' }, location.origin);
    return () => stateListeners.delete(cb);
  }

  /** 最初の状態が来るまで待つ。来なければ null（DOMからの推測に切り替える） */
  function waitForState({ timeout = 8000 } = {}) {
    if (latestState) return Promise.resolve(latestState);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; off(); clearTimeout(timer); resolve(v); } };
      const off = onState((s) => finish(s));
      const timer = setTimeout(() => finish(null), timeout);
    });
  }

  /**
   * SPAの経路変更を見張る。ページ遷移が起きないので、MAINワールドの state-bridge.js が history の呼び出しを
   * 見て postMessage で知らせてくる（azr:route）。届かなかったときの保険に、2秒ごとにも見る。
   */
  function onRouteChange(cb) {
    let last = location.pathname;
    const check = () => {
      if (location.pathname === last) return;
      last = location.pathname;
      cb(last);
    };
    window.addEventListener('message', (e) => {
      if (e.source === window && e.data?.source === 'azr:route') check();
    });
    setInterval(check, 2000);
    window.addEventListener('popstate', check);
  }

  Object.assign(AZR, {
    pick, pickAll, waitFor, waitSettled, domReady, h, parseYen, yen, mountOnce, pageKind,
    onState, waitForState, onRouteChange
  });
})();
