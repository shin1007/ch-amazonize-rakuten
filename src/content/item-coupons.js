/* Amazonize Rakuten - 商品ページのクーポン: ページから拾う・その場で獲得する・自動で獲得する */
(() => {
  const AZR = window.AZR;
  const tr = AZR.t;
  // 割引は「500円OFF」の形で来る。日本語以外では通貨記号の形にして見せる（解析には元の文字列を使う）
  const disc = (d) => (AZR.isJa || !d ? d : d.replace(/([\d,]+)円OFF/, '¥$1 OFF'));
  const { h, yen } = AZR;

  const COUPON_LINK = 'a[href*="coupon.rakuten.co.jp"]';

  /**
   * バナー画像のファイル名から割引を読む。
   * 例: 260904_alo_500off.jpg → 500円OFF / 260904_alo_10poff.jpg → 10%OFF
   */
  function labelFromImageName(src) {
    const file = (src || '').split('/').pop().split('?')[0];
    const pct = file.match(/(\d+)\s*(?:p|per|percent)[-_]?off/i);
    if (pct) return tr('{n}%OFFクーポン', { n: pct[1] });
    const off = file.match(/(\d+)\s*(?:yen|en)?[-_]?off/i);
    if (!off) return null;
    // 100円未満のクーポンはまず出回らないので、その桁は率の書き落としとみなす
    const n = Number(off[1]);
    return n < 100 ? tr('{n}%OFFクーポン', { n }) : tr('{n}円OFFクーポン', { n });
  }

  /** 店舗のクーポンは画像バナーだけのことが多い。文言 → alt → title → ファイル名の順に諦める。 */
  function couponLabelFrom(a) {
    const img = a.querySelector('img');
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    const candidate = text || (img?.alt || '').trim() || (a.title || img?.title || '').trim();
    return (candidate || labelFromImageName(img?.src) || tr('クーポンを獲得')).slice(0, 60);
  }

  /** 同じクーポンを二重に出さないための鍵。getkeyがあればそれが一意。 */
  function couponKey(href) {
    const key = href.match(/[?&]getkey=([^&]+)/);
    return key ? `getkey:${key[1]}` : href.split('#')[0];
  }

  function harvestCoupons() {
    const out = [];
    const seen = new Set();
    const add = (key, coupon) => {
      if (!key || seen.has(key) || out.length >= 8) return;
      seen.add(key);
      out.push(coupon);
    };

    // 1) クーポンページへのリンク。文言が無いバナーもあるので、リンク先を手がかりにする。
    // 自分で出したクーポン欄は拾わない（拾い直すときにはもうページにある）
    const ours = (el) => el.closest('.azr-item-coupons');

    for (const a of document.querySelectorAll(COUPON_LINK)) {
      // ヘッダーの「myクーポン」は自分の保有一覧であって、この商品のクーポンではない
      if (/\/myCoupon/i.test(a.href) || ours(a)) continue;
      const label = couponLabelFrom(a);
      add(couponKey(a.href), {
        ...AZR.coupons.parseCoupon(label, { source: 'item-link' }),
        href: a.href,
        image: a.querySelector('img')?.src || null
      });
    }

    // 2) 文字で書かれたクーポン（楽天公式のクーポン枠など）
    for (const el of document.querySelectorAll('a, li, span, p')) {
      if (ours(el)) continue;
      // 店舗のお知らせは末尾に掲載日が付く（「3日前」「2026/07/23」）
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
        .replace(/\s*(\d+(分|時間|日)前|\d{4}\/\d{1,2}\/\d{1,2})$/, '');
      if (!t || t.length > 60 || !/クーポン/.test(t)) continue;
      if (!/(OFF|オフ|円引|%|％|送料無料)/i.test(t)) continue;
      const c = AZR.coupons.parseCoupon(t, { source: 'item' });
      if (c.type === 'unknown') continue;
      const href = el.closest('a')?.href || null;
      // 同じリンクの中の div と span（日付の有無だけ違う）を2行に数えない
      add(href ? couponKey(href) : `text:${t}`, { ...c, href, image: null });
    }

    return out;
  }

  // 獲得の結果を、そのまま行の文言にする
  const GRAB_LABEL = () => ({
    acquired: tr('獲得しました'),
    already: tr('獲得済みです'),
    login: tr('ログインしてください'),
    rejected: tr('獲得できません'),
    closed: tr('中止しました'),
    timeout: tr('結果を確認できません'),
    unknown: tr('結果を確認できません'),
    error: tr('獲得できません')
  });

  // APIが返す理由コード。クーポン側の文言に寄せる。載っていないものは「獲得できません」。
  const REJECT_LABEL = () => ({
    COUPON_NOT_FOUND: tr('クーポンが見つかりません'),
    COUPON_VALIDITY_PERIOD_OVER: tr('期間が終了しています'),
    CAMPAIGN_VALIDITY_PERIOD_OVER: tr('期間が終了しています'),
    COUPON_STATUS_FINISHED: tr('配布が終了しています'),
    NOT_REGISTERED_MEMBER: tr('会員登録が必要です'),
    PURCHASE_HISTORY_EXISTS: tr('対象外です')
  });

  const GRAB_TIMEOUT_MS = 50000; // service worker 側の打ち切りより必ず後にする

  // 獲得したクーポンの履歴（ポップアップに出す）に添える、どの商品ページで獲得したか
  let grabContext = { shop: '', item: '', url: '' };

  /**
   * 獲得ページへ遷移せず、その場で獲得する。
   * 実際の獲得は service worker が行う（獲得ページと同じAPIを呼ぶ。
   * このAPIは商品ページのオリジンからは呼べないので、content script では代行できない）。
   * auto は、押されずに自動で獲得したもの（履歴で見分けるため）。
   */
  async function grabInPlace(link, status, request, { auto = false } = {}) {
    if (link.dataset.azrGrab === 'busy' || link.dataset.azrGrab === 'done') return null;
    link.dataset.azrGrab = 'busy';
    status.textContent = tr('獲得中…');

    // 名前は押した時点のもの（APIから正式名称が取れていれば、それに差し替わっている）
    const name = link.querySelector('.azr-coupon-text')?.textContent || '';
    const record = { ...grabContext, name, auto };

    let res = null;
    try {
      res = await Promise.race([
        chrome.runtime.sendMessage({ ...request, record }),
        // service worker が落ちた場合に、行が「獲得中…」のまま固まらないようにする
        new Promise((r) => setTimeout(() => r({ ok: false, status: 'timeout' }), GRAB_TIMEOUT_MS))
      ]);
    } catch (e) {
      AZR.warn('クーポン獲得の依頼に失敗:', e);
    }

    showGrabResult(link, status, res);
    return res;
  }

  /** 獲得の結果を行に書く。行を作り直したときにも、同じ結果をそのまま写せるように分けてある。 */
  function showGrabResult(link, status, res) {
    // 失敗した行は押し直せるようにしておく（ログイン後にもう一度など）
    link.dataset.azrGrab = res?.ok ? 'done' : 'failed';
    status.textContent = res?.status === 'rejected'
      ? (REJECT_LABEL()[res.reason] || GRAB_LABEL().rejected)
      : (GRAB_LABEL()[res?.status] || GRAB_LABEL().error);
    // 訳し切れない理由コードは、確認できるようにマウスオーバーへ逃がす
    if (res?.reason) link.title = res.reason;
  }

  /* 自動獲得 ----------------------------------------------------------------
   * 押さなくても、商品ページを開いた時点で獲得する。
   * 押したときと違って裏タブは開かない（apiOnly）。ページを開いただけでタブが増えたり、
   * ログイン画面が勝手に前へ出たりしないようにする。APIで決着しない分は行に「獲得する」が残る。
   */
  const autoGrabbed = new Map(); // クーポンの鍵 → 獲得の約束。同じクーポンを二度は獲得しない。
  let autoGrabStopped = false;

  async function autoGrab(rows) {
    if (!AZR.settings.couponAutoGrab || !AZR.settings.consentAt) return;
    for (const { key, link, status, run } of rows) {
      const already = autoGrabbed.get(key);
      if (already) {
        // クーポンを拾い直して行を作り直した場合。獲得はもう済んでいるので、結果だけ写す。
        already.then((res) => { if (res) showGrabResult(link, status, res); });
        continue;
      }
      if (autoGrabStopped) return;
      // 楽天の獲得APIを一度に叩かないよう、1枚ずつ順に獲得する
      const grabbing = run();
      autoGrabbed.set(key, grabbing);
      const res = await grabbing;
      if (res?.status !== 'login') continue;
      // 未ログインなら残りも同じ結果になる。押せば獲得ページ（＝ログイン）へ進めるので、
      // 行は「獲得する」に戻したうえで、自動での獲得はここで止める。
      autoGrabStopped = true;
      autoGrabbed.delete(key);
      link.dataset.azrGrab = '';
      status.textContent = tr('獲得する');
      link.title = tr('このページのまま獲得します');
      return;
    }
  }

  /**
   * クーポンの正式な内容をAPIから取り、行の文言を差し替える。
   * バナー画像のファイル名から推測した文言より、こちらが正しい。
   * 表示を待たせないため、行を出したあとに非同期で上書きする。
   */
  async function refineCoupon(c, link, textEl, status, onChange) {
    const url = c.href;
    let d = null;
    try {
      d = await chrome.runtime.sendMessage({ type: 'azr:couponDetails', url });
    } catch (e) {
      AZR.warn('クーポン内容の取得に失敗:', e);
    }
    if (!d) return;

    if (d.name) {
      textEl.textContent = d.name;
      // 正式名称が取れたなら、裏取り用のバナーは要らない。名前に幅を回す。
      link.querySelector('.azr-coupon-thumb')?.remove();
      // バナーのファイル名から推測した文言には利用条件が入らない（500off.jpg が実は
      // 「5,000円以上で500円OFF」のこともある）。正式名称の方を読み直して条件を入れ替える。
      Object.assign(c, AZR.coupons.parseCoupon(d.name, { source: c.source, href: c.href, image: c.image }));
      const cond = link.querySelector('.azr-coupon-cond');
      if (cond && c.minSpend) cond.textContent = tr('{y}以上で利用可', { y: yen(c.minSpend) });
      else if (cond) cond.remove();
    }
    // 割引の内訳はAPIの数値が正。文言の読み取りより確か。
    if (Number(d.discountType) === 1 && Number(d.discountFactor) > 0) {
      c.type = 'fixed';
      c.amount = Number(d.discountFactor);
    } else if (Number(d.discountType) === 2 && Number(d.discountFactor) > 0) {
      c.type = 'percent';
      c.percent = Number(d.discountFactor);
    }
    if (d.acquired && !link.dataset.azrGrab) {
      link.dataset.azrGrab = 'done';
      status.textContent = tr('獲得済みです');
    }
    // 割引・条件が変わったので、価格の出し直しを呼び出し元に任せる
    onChange?.();
  }

  /** service worker が返したフローティングクーポンを、クーポン欄の1行の形にする */
  function fromFloating(f) {
    const cond = [
      disc(f.discount),
      f.minSpend ? tr('{y}以上', { y: yen(f.minSpend) }) : '',
      f.minUnits ? tr('{n}個以上', { n: f.minUnits }) : '',
      f.salesMethod === 'normal' ? tr('通常購入限定') : f.salesMethod === 'subscription' ? tr('定期購入限定') : ''
    ].filter(Boolean).join(!AZR.isJa ? ' · ' : '・');
    // 割引は「500円OFF」「10%OFF」の形で来る。率OFFの上限額はこの欄にもAPIの条件にも入らないので、
    // 名前に「最大1,000円」と書いてあればそれを上限として拾う（上限を見落として安く見せない）。
    const parsed = AZR.coupons.parseCoupon(f.discount, { source: 'floating' });
    const named = AZR.coupons.parseCoupon(`${f.name || ''} ${f.discount}`);
    return {
      ...parsed,
      cap: parsed.cap ?? named.cap,
      minSpend: f.minSpend || named.minSpend || 0,
      minUnits: f.minUnits || 0,
      salesMethod: f.salesMethod || null,
      floating: true,
      getKey: f.getKey,
      label: f.name || disc(f.discount),
      cond,
      acquired: f.acquired
    };
  }

  /**
   * フローティングクーポンの行。獲得ページのURLが無いので、元のページの枠と同じAPIで獲得する。
   * リンク先が無いため a[href] にはせず、キーボードでも押せるボタンとして作る。
   */
  function floatingRow(c, auto) {
    const status = h('span.azr-coupon-get', { text: c.acquired ? tr('獲得済みです') : tr('獲得する') });
    const grab = (opts) => grabInPlace(link, status, { type: 'azr:grabFloatingCoupon', getKey: c.getKey }, opts);
    const link = h('a.azr-coupon-link', {
      role: 'button',
      tabindex: '0',
      title: tr('このページのまま獲得します'),
      onclick: (e) => { e.preventDefault(); grab(); },
      onkeydown: (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        grab();
      }
    },
      h('span.azr-coupon-badge', { text: tr('クーポン') }),
      h('span.azr-coupon-text', { text: c.label, title: c.label }),
      c.cond ? h('span.azr-coupon-cond', { text: c.cond }) : '',
      status
    );
    if (c.acquired) link.dataset.azrGrab = 'done';
    else auto.push({ key: `getkey:${c.getKey}`, link, status, run: () => grab({ auto: true }) });
    return link;
  }

  /** Amazon風のクーポン表示。押した場所から離れずに獲得できるようにする。 */
  function buildCoupons(coupons, { onChange } = {}) {
    const auto = []; // 自動で獲得する行（作った順に、1枚ずつ獲得する）
    const row = (c) => {
      if (c.floating) return floatingRow(c, auto);
      const textEl = h('span.azr-coupon-text', { text: c.label });
      const parts = [
        h('span.azr-coupon-badge', { text: tr('クーポン') }),
        textEl,
        c.minSpend ? h('span.azr-coupon-cond', { text: tr('{y}以上で利用可', { y: yen(c.minSpend) }) }) : ''
      ];
      if (!c.href) return h('div.azr-coupon-link', parts);

      // 獲得ページ（getkey付き）でなければ、ここでは獲得できない。
      // 店舗のお知らせ（「レビュー投稿でクーポン」「SALE×クーポンで最大40%OFF」など）は
      // 店舗のページへのリンクで、押しても獲得は起きない。「獲得する」と見せずに、そのページを開く。
      if (!/[?&]getkey=/.test(c.href)) {
        return h('a.azr-coupon-link', { href: c.href, target: '_blank', rel: 'noopener' },
          parts,
          h('span.azr-coupon-get', { text: tr('詳しく見る') })
        );
      }

      const status = h('span.azr-coupon-get', { text: tr('獲得する') });
      // hrefは残す。中クリックや「新しいタブで開く」を潰さないため。
      const link = h('a.azr-coupon-link', {
        href: c.href,
        target: '_blank',
        rel: 'noopener',
        title: tr('このページのまま獲得します'),
        onclick: (e) => {
          // 修飾キー付きのクリックは、本来の「別タブで開く」に任せる
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          grabInPlace(link, status, { type: 'azr:grabCoupon', url: c.href });
        }
      },
        parts,
        // 文言をファイル名から推測した場合もあるので、現物のバナーも小さく添える
        c.image ? h('img.azr-coupon-thumb', { src: c.image, alt: '', loading: 'lazy' }) : '',
        status
      );
      refineCoupon(c, link, textEl, status, onChange);
      auto.push({ key: couponKey(c.href), link, status, run: () => grabInPlace(link, status, { type: 'azr:grabCoupon', url: c.href, apiOnly: true }, { auto: true }) });
      return link;
    };
    const section = h('section.azr-item-coupons',
      h('div.azr-section-label', { text: tr('クーポン') }),
      h('ul', coupons.map((c) => h('li', row(c))))
    );
    autoGrab(auto);
    return section;
  }

  /**
   * 価格に反映してよいクーポン。この商品ページで実際に獲得できるものに限る。
   * 店舗のお知らせ（「SALE×クーポンで最大40%OFF」など、店舗ページへのリンク）は
   * 対象商品も条件も分からないので、価格には効かせない。
   */
  const affectsPrice = (c) => Boolean(c.floating || (c.href && /[?&]getkey=/.test(c.href)));

  /** 獲得したクーポンの履歴に添える、どの商品ページで獲得したか */
  const setGrabContext = (ctx) => { grabContext = ctx; };

  AZR.itemCoupons = { harvestCoupons, couponKey, buildCoupons, fromFloating, affectsPrice, setGrabContext };
})();
