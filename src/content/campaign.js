/* Amazonize Rakuten - ポイントアップキャンペーンの自動エントリー */
(() => {
  const AZR = window.AZR;
  const tr = AZR.t;
  const { h, waitSettled } = AZR;

  const ENTRY_TEXT = /^(エントリー(する)?|今すぐエントリー|エントリーはこちら)$/;
  // 楽天共通のエントリーボタン（rcEntryButton）は、押した直後は「エントリーが完了しました」、
  // 開き直すと「エントリー済です」になる。前者を拾えず、押せたのに「none」と記録していた。
  const DONE_TEXT = /エントリー(が)?(済|完了|ずみ)/;
  const ENTRY_INTERVAL_MS = 1200;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 別のページへ移るリンクか（別のサイトも、同じサイトの別のページも）。
   * 同じサイトの別ページへの「エントリーする」は、ほかのキャンペーンへの案内バナーだった
   * （ママ割のページにマラソンやホームライフ特典への「エントリーする」がある）。押すとタブが移る。
   */
  function leavesPage(el) {
    if (el.tagName !== 'A') return false;
    const href = el.getAttribute('href') || '';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return false;
    try {
      const u = new URL(href, location.href);
      return u.host !== location.host || u.pathname.replace(/\/$/, '') !== location.pathname.replace(/\/$/, '');
    } catch {
      return false;
    }
  }

  /**
   * 楽天共通のエントリーボタン（<div class="rcEntryButton" settings='{"campaignCode": …}'>）。
   * ボタンは entry_button.js が描く <button class="rcEntryButton-button"> か、ページ側が書いた
   * [data-entry-button] のリンク。後者は「買いまわりキャンペーンに事前エントリーする」のように文言が長く、
   * href が oubo.rakuten.co.jp なので、下の文言の判定では拾えなかった（お買い物マラソン）。
   * クリックは entry_button.js が preventDefault してその場でエントリーするので、別サイトへは移らない。
   * 同じキャンペーンのボタンがページに何か所もあるので、キャンペーンごとに1つだけ押す。
   */
  function findComponentButtons() {
    const out = [];
    const codes = new Set();
    for (const box of document.querySelectorAll('.rcEntryButton')) {
      const btn = box.querySelector('[data-entry-button], button.rcEntryButton-button');
      if (!btn || !btn.offsetParent) continue;
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
      const text = (btn.textContent || '').replace(/\s+/g, '');
      if (DONE_TEXT.test(text) || !/エントリー/.test(text)) continue;
      let code = '';
      try { code = JSON.parse(box.getAttribute('settings') || '{}').campaignCode || ''; } catch { /* 壊れた設定 */ }
      if (code) {
        if (codes.has(code)) continue;
        codes.add(code);
      }
      out.push(btn);
    }
    return out;
  }

  /**
   * 未エントリーのボタンを集める。
   * component が false のときは共通ボタンを除く（APIで判定済みのキャンペーンを押し直さない）。
   */
  function findEntryButtons({ component = true } = {}) {
    const out = component ? findComponentButtons() : [];
    for (const el of document.querySelectorAll('a, button, input[type="submit"], input[type="image"], [role="button"]')) {
      if (el.closest('.rcEntryButton')) continue; // 上で見た
      const text = (el.value || el.alt || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 16) continue;
      if (DONE_TEXT.test(text)) continue;
      if (!ENTRY_TEXT.test(text)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      // 別のサイトの案内へのリンクは、このページのエントリーではない。SPUのページには
      // 楽天モバイルのSPUページ（network.mobile.rakuten.co.jp）へ飛ぶ「エントリーはこちら」があり、
      // 押すとタブがそちらへ移って判定が返らず「時間切れ」になっていた。
      // 実際のエントリーボタンは <button class="rcEntryButton-button"> で、リンクではなかった
      // （トップから辿れる55ページと既知のキャンペーンで、未ログインで確認）。
      // 同じサイトの別ページへのリンクも、ほかのキャンペーンへの案内なので押さない。
      if (leavesPage(el)) continue;
      if (!el.offsetParent) continue;
      out.push(el);
    }
    return out;
  }

  /** すでにエントリー済みの表示があるか */
  function alreadyEntered() {
    return Array.from(document.querySelectorAll('a, button, p, span, div'))
      .some((el) => el.offsetParent && DONE_TEXT.test((el.textContent || '').trim()) &&
        (el.textContent || '').trim().length <= 16);
  }

  async function entryAll(buttons, onProgress) {
    let ok = 0;
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      if (!btn.isConnected) continue;
      try {
        // 別タブに飛ばず、その場でエントリーさせる
        if (btn.tagName === 'A' && btn.target === '_blank') btn.removeAttribute('target');
        btn.click();
        ok++;
      } catch (e) {
        AZR.warn('エントリーに失敗:', e);
      }
      onProgress?.(i + 1, buttons.length);
      await sleep(ENTRY_INTERVAL_MS);
    }
    return ok;
  }

  /* 判定とエントリー -----------------------------------------------------------
   * まずページにあるキャンペーンのコードを集め、service worker からエントリーAPIで判定・エントリーする。
   * 文言やボタンの形に左右されない。コードが無い・APIが使えない（未ログイン等）ときだけボタンを押す。 */

  /** ページにあるキャンペーンのコード。共通ボタンの settings と、応募ページへのリンクから集める。 */
  function collectEntryCodes() {
    const map = new Map();
    const add = (raw, ekey) => {
      let code = String(raw || '').trim();
      if (!code) return;
      if (!code.startsWith('/')) code = '/' + code;
      if (!map.has(code)) map.set(code, { code, ekey: ekey || '' });
    };
    for (const box of document.querySelectorAll('.rcEntryButton[settings]')) {
      try {
        const s = JSON.parse(box.getAttribute('settings'));
        add(s.campaignCode, s.ekey);
      } catch { /* 壊れた設定 */ }
    }
    for (const a of document.querySelectorAll('a[href*="oubo.rakuten.co.jp/apply/"]')) {
      try {
        const u = new URL(a.href);
        if (u.hostname === 'oubo.rakuten.co.jp') add(u.pathname.replace(/^\/apply/, ''), u.searchParams.get('ekey'));
      } catch { /* 壊れたURL */ }
    }
    return [...map.values()];
  }

  /**
   * エントリーできそうな気配があるか。ボタンを押せず、APIでも判定できなかったのにこれがあれば、
   * 「エントリー不要」と黙って記録せず「要確認」にする（見落としに気づけるように）。
   */
  function looksEnterable() {
    if (document.querySelector('.rcEntryButton, a[href*="oubo.rakuten.co.jp/apply"]')) return true;
    return Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"]')).some((el) => {
      if (!el.offsetParent || el.closest('.azr-panel')) return false;
      // ページ内の目次（SPUの「楽天モバイル＋エントリー」→ #rule_mobile）と、別ページへの案内は除く
      if (el.tagName === 'A' && ((el.getAttribute('href') || '').startsWith('#') || leavesPage(el))) return false;
      const text = (el.value || el.textContent || '').replace(/\s+/g, '');
      return text.length <= 30 && /エントリー/.test(text) &&
        !DONE_TEXT.test(text) && !/履歴|期間|終了|開始前|詳細|方法|について/.test(text);
    });
  }

  /** APIでの判定（entry なら エントリーまで）。使えなければ null */
  async function enterByApi(entry) {
    const items = collectEntryCodes();
    if (!items.length) return null;
    try {
      return await chrome.runtime.sendMessage({ type: 'azr:entryCodes', items, entry });
    } catch {
      return null;
    }
  }

  async function enterByButtons(entry, { component, suspect, onProgress }) {
    const statusNow = () => (findEntryButtons({ component }).length ? 'entry' : alreadyEntered() ? 'already' : 'none');
    let status = statusNow();
    let entered = false;
    if (status === 'entry' && entry) {
      await entryAll(findEntryButtons({ component }), onProgress);
      // 押しただけで「エントリーした」と言わない。表示が変わるのを確かめる。
      await sleep(2000);
      const after = statusNow();
      entered = after === 'already';
      status = entered ? 'entered' : after;
    }
    if (status === 'none' && suspect && looksEnterable()) status = 'suspect';
    return { status, entered };
  }

  /**
   * このページの状態を返す（entry なら エントリーもする）。
   *   entered … いまエントリーした
   *   entry   … 未エントリーのものがある
   *   already … エントリー済み
   *   suspect … エントリーできそうなのに判定できなかった（要確認）
   *   none    … そもそもエントリーするものが無い（ただの特集ページ）
   */
  async function enterPage(entry, onProgress) {
    const api = await enterByApi(entry);
    AZR.log('エントリーAPI', api);
    if (api && api.status !== 'none') return api;
    // APIで判定できたコードは押し直さない。コード以外のボタンがあれば、それは押す。
    return enterByButtons(entry, { component: !api, suspect: !api, onProgress });
  }

  const STATUS_TEXT = () => ({
    entered: tr('エントリーしました'),
    entry: tr('未エントリーのキャンペーンがあります'),
    already: tr('エントリー済みです'),
    suspect: tr('エントリーできるか判定できませんでした（ログインを確認してください）'),
    none: tr('エントリーするものは見つかりませんでした')
  });

  function render(first) {
    const status = h('div.azr-coupon-status', { text: STATUS_TEXT()[first.status] || '' });

    const panel = h('div.azr-panel.azr-campaign-panel', { id: 'azr-campaign-panel' },
      h('div.azr-panel-head',
        h('span.azr-panel-title', { text: tr('キャンペーン') }),
        h('button.azr-panel-close', { type: 'button', text: '×', onclick: () => panel.remove() })
      ),
      h('div.azr-panel-body',
        status,
        h('button.azr-btn-primary', {
          type: 'button',
          text: tr('このページを一括エントリー'),
          disabled: first.status !== 'entry' && first.status !== 'suspect',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            status.textContent = tr('エントリー中…');
            const r = await enterPage(true, (done, total) => {
              status.textContent = tr('エントリー中… {done}/{total}', { done, total });
            });
            status.textContent = STATUS_TEXT()[r.status] || '';
          }
        })
      )
    );
    return panel;
  }

  /* 一括スキャンで裏から開かれたとき ---------------------------------------- */

  /** ページの見出し。一覧に出すので、キャンペーン名らしいものを選ぶ。 */
  function pageTitle() {
    const h1 = document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim();
    const title = document.title.replace(/\s*[|｜]\s*楽天市場.*$/, '').replace(/\s+/g, ' ').trim();
    const name = (h1 && h1.length <= 60 ? h1 : title).slice(0, 60);
    // 計測用のクエリを落とすと開けなくなるページがあり、そのままだとエラーページの
    // 見出しが名前になってしまう。一覧で見分けが付かないのでURLを使う。
    if (!name || /^\d{3}\s|Bad Request|Not Found|Forbidden/i.test(name)) {
      return location.pathname.replace(/^\/|\/$/g, '') || location.host;
    }
    return name;
  }

  /** 裏タブとしての仕事。エントリーして、結果を確かめてから返す。 */
  async function reportForScan(task) {
    await waitSettled({ quiet: 700, timeout: 9000 });

    const { status, entered } = await enterPage(Boolean(task.entry));

    AZR.log('スキャン結果', { status, entered });
    try {
      await chrome.runtime.sendMessage({
        type: 'azr:campaignResult', status, entered, title: pageTitle()
      });
    } catch (e) {
      AZR.warn('結果の返信に失敗:', e);
    }
  }

  AZR.register('campaign', 'campaign-entry', async () => {
    if (!/(^|\.)event\.rakuten\.co\.jp$/.test(location.host)) return;

    // 一括スキャン・URL指定の実行で開かれたタブは、パネルを出さずに結果だけ返して閉じてもらう。
    // どのタブが対象かは service worker がタブIDで覚えている（自分で開いたページは対象にならない）。
    let task = null;
    try {
      task = await chrome.runtime.sendMessage({ type: 'azr:scanTask' });
    } catch { /* service worker が落ちている */ }
    if (task?.task === 'campaign') return reportForScan(task);

    if (!AZR.settings.campaignEntry) return;

    await waitSettled({ quiet: 700, timeout: 9000 });
    const first = await enterPage(false);
    AZR.health.check('campaign.judge', first.status !== 'suspect', 'エントリーのボタンらしきものはあるのに判定できない（未ログインでも出る）');

    document.getElementById('azr-campaign-panel')?.remove();
    document.body.append(render(first));

    if (!AZR.settings.campaignAutoEntry || first.status !== 'entry') return;

    // エントリーボタンを押すとページが再読み込みされることがある。
    // 何度も押し続けないよう、このURLで一度実行したことを記録しておく。
    // 記録は service worker が session storage に持つ（content script には session storage を開かない）。
    // 確かめられないときは押さない（押し続けるよりよい）。
    let once = null;
    try {
      once = await chrome.runtime.sendMessage({ type: 'azr:entryOnce', url: location.href.split('?')[0] });
    } catch { /* service worker が落ちている */ }
    if (!once?.first) return;
    const r = await enterPage(true);
    AZR.log('自動エントリー', r);
    const statusEl = document.querySelector('#azr-campaign-panel .azr-coupon-status');
    if (statusEl) statusEl.textContent = STATUS_TEXT()[r.status] || '';
  });
})();
