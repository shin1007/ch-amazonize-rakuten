/* Amazonize Rakuten - 注文確認画面で最良クーポンを自動適用 */
(() => {
  const AZR = window.AZR;
  const tr = AZR.t;
  const { h, yen, onState, waitForState, waitFor } = AZR;

  const PANEL_ID = 'azr-checkout-panel';
  const COUPON_CARD = '#confirm-use-coupon-card'; // 楽天が付けている固定id
  const OPEN_TEXT = /^(変更|クーポンを選ぶ|選択)$/;
  const COMMIT_TEXT = /^(変更する|適用する|決定|OK)$/;
  const NEVER_CLICK = /注文を確定|同意して注文|注文する|購入を確定/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 状態からクーポンを読む処理と、どれに切り替えるかの判断は coupon-model.js にある
  // （画面に依らない部分なので、tests/ で実物の形のデータを通して確かめている）。
  const { collect, sameCoupon, chooseSwitch } = AZR.coupons;

  /* 実際の画面を操作して適用する ---------------------------------------------
   * クーポンは「クーポン利用」カードの『変更』→モーダルで選択→『変更する』で確定する。
   * 状態を直接書き換えても楽天のサーバには伝わらないので、UIを押すしかない。
   * クラス名はハッシュ付きで当てにならないため、固定idと表示文言だけを頼りにする。 */

  /**
   * 目に見えて、実際に押せる大きさがあるか。
   *
   * 閉じたモーダルは 0x0 の要素としてDOMに残る。`getClientRects().length` は
   * そういう要素でも1を返すので、これを「見えている」と数えると、残骸の
   * 「変更する」を押して何も起きない（実機で踏んだ）。大きさで判断する。
   */
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /**
   * 実際のマウス操作に近い形で押す。
   *
   * 楽天のボタンは `element.click()` では反応しないものがある（「変更する」で確認）。
   * pointerdown/mousedown から始まる一連のイベントを見ているためで、click だけでは
   * 押したことにならない。座標も要るので、要素の中心を渡す。
   */
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    } catch { /* PointerEventが無い環境では click だけで済ませる */ }
    el.click();
  }

  /** テキストが一致する押せる要素を探す。確定操作は絶対に返さない。 */
  function findClickable(root, re) {
    const nodes = root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]');
    for (const el of nodes) {
      const text = (el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 24) continue;
      if (NEVER_CLICK.test(text)) continue;
      if (!re.test(text)) continue;
      if (!visible(el)) continue;
      return el;
    }
    return null;
  }

  /**
   * クーポンの行と、その選択スイッチを探す。
   *
   * 注文確認の画面には、お届け日時・支払い方法など**複数のモーダルが同時にDOMへ
   * 置かれている**。「クーポン利用と変更するを含む要素」で探すと、いちばん外側の
   * 大きな入れ物に当たり、別のモーダルの「変更する」を押してしまう（実機で確認）。
   * そこで、クーポン名の行そのものを起点にする。
   */
  const SWITCH = '[role="checkbox"], [role="radio"], input[type="checkbox"], input[type="radio"]';
  const ROW_MAX_TEXT = 400; // 行に収まる長さ。これを超えるものはページの入れ物。

  /**
   * クーポン名で行を探す。まず名前全体で探し、見つからなければ先頭18文字で探す。
   * 先頭だけだと「【楽天スーパーSALE】対象ショップで「1注文合計1,500円…」「…3,000円…」の
   * ように先頭が同じクーポンを取り違える（実機で5枚が同じ先頭だった）。
   */
  function findCouponRow(label) {
    const full = label.replace(/\s+/g, ' ').trim();
    return findCouponRowBy(full) || findCouponRowBy(full.slice(0, 18));
  }

  function findCouponRowBy(key) {
    if (!key) return null;

    // クーポン名を含み、かつ「行」と呼べる短さの要素を探す。
    // スイッチ側から祖先を辿ると、ページ全体の入れ物までクーポン名を含むため、
    // ページ下部の無関係なチェックボックス（メルマガ等）を掴んでしまう（実機で踏んだ）。
    const rows = [];
    for (const el of document.querySelectorAll('div, li, label, tr, [role="button"]')) {
      const text = (el.textContent || '').replace(/\s+/g, ' ');
      if (text.length > ROW_MAX_TEXT || !text.includes(key)) continue;
      if (!el.querySelector(SWITCH)) continue;
      if (!visible(el)) continue;
      rows.push({ el, len: text.length });
    }
    if (!rows.length) return null;

    // いちばん内側（テキストがいちばん短い）ものが、その行そのもの
    rows.sort((a, b) => a.len - b.len);
    const row = rows[0].el;
    const box = row.querySelector(SWITCH);
    return box ? { box, row } : null;
  }

  /** その行と同じモーダルにある「変更する」を返す（別モーダルのものを掴まないため） */
  function findCommitNear(row) {
    let box = row;
    for (let i = 0; i < 14 && box; i++) {
      box = box.parentElement;
      if (!box) break;
      const btn = findClickable(box, COMMIT_TEXT);
      if (btn) return btn;
    }
    return null;
  }

  /**
   * その選択スイッチが今入っているか。
   * 見た目のチェックは `[role="checkbox"]` の aria-checked で、
   * その中にネイティブの input が隠れている作りだった。
   */
  function isChecked(box) {
    // aria があるならそれだけを信じる。中に隠れているネイティブの input は、
    // 選択を解除しても checked=true のまま残ることがあり、未選択なのに
    // 「選択済み」と読んでしまう（未選択のまま「変更する」を押していた）。
    const aria = box.matches('[role="checkbox"], [role="radio"]')
      ? box
      : box.querySelector('[role="checkbox"], [role="radio"]');
    if (aria) return aria.getAttribute('aria-checked') === 'true';
    const input = box.matches('input') ? box : box.querySelector('input[type="checkbox"], input[type="radio"]');
    return Boolean(input?.checked);
  }

  /**
   * クーポンの行を選ぶ。
   * 押した結果はReactの再描画を経てから反映されるので、同期で読まずに少し待つ。
   */
  async function select({ box, row }, want = true) {
    if (isChecked(box) === want) return true;
    for (const target of [box, row]) {
      if (!target) continue;
      realClick(target);
      for (let i = 0; i < 10; i++) {
        await sleep(200);
        if (isChecked(box) === want) return true;
      }
    }
    return isChecked(box) === want;
  }

  /**
   * クーポンを1枚適用する。「変更」→行を選ぶ→「変更する」の順に押す。
   * current は今選ばれているクーポン。併用できないので、先に外さないと新しい方を選べない。
   */
  async function applyCoupon(coupon, current = []) {
    const card = document.querySelector(COUPON_CARD);
    const open = card && findClickable(card, OPEN_TEXT);
    if (!open) return { ok: false, reason: 'クーポン欄の「変更」が見つからない' };
    realClick(open);

    let found = await waitFor(() => findCouponRow(coupon.label), { timeout: 8000 });
    if (!found) return { ok: false, reason: 'モーダルにそのクーポンの行が出てこない' };

    for (const c of current) {
      if (sameCoupon(c, coupon)) continue;
      const row = findCouponRow(c.label);
      if (row && isChecked(row.box) && !(await select(row, false))) {
        return { ok: false, reason: '今のクーポンの選択を外せなかった' };
      }
    }
    if (current.length) {
      // 外したあとは行が描き直されるので、選ぶ行を探し直す
      await sleep(400);
      found = findCouponRow(coupon.label);
      if (!found) return { ok: false, reason: '選択を外したあと、そのクーポンの行が見つからない' };
    }

    const rect = (el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`; };
    AZR.log('coupon row', { box: found.box.tagName, role: found.box.getAttribute('role'), boxRect: rect(found.box), rowRect: rect(found.row), checked: isChecked(found.box) });

    if (!(await select(found))) return { ok: false, reason: 'クーポンを選択できなかった' };
    await sleep(600); // 選択がReactに反映されてから確定を押す
    AZR.log('after select', { checked: isChecked(found.box) });

    const commit = findCommitNear(found.row);
    if (!commit) return { ok: false, reason: '「変更する」が見つからない' };
    realClick(commit);

    // 押しただけで成功と言わない。クーポン欄の表示が変わるのを確かめる。
    // 先頭の数文字だけだと、先頭が同じ別のクーポン（切り替える前のもの）でも一致してしまう。
    const key = coupon.label.replace(/\s+/g, ' ').trim();
    const done = await waitFor(() => {
      const text = (document.querySelector(COUPON_CARD)?.textContent || '').replace(/\s+/g, ' ');
      return text.includes(key) && !/利用なし/.test(text) ? true : null;
    }, { timeout: 10000 });
    if (done) return { ok: true };
    AZR.log('commit failed', { checked: isChecked(found.box), commit: commit.getBoundingClientRect() });
    return { ok: false, reason: '「変更する」を押したが、クーポン欄が変わらなかった' };
  }

  /* 表示 --------------------------------------------------------------------- */

  function render(groups, best, applied, note, onApply) {
    const total = groups.reduce((s, g) => s + g.applied, 0);
    const found = groups.reduce((s, g) => s + g.coupons.length, 0);

    const panel = h('div.azr-panel.azr-checkout-panel', { id: PANEL_ID },
      h('div.azr-panel-head',
        h('span.azr-panel-title', { text: tr('クーポン最適化') }),
        h('button.azr-panel-close', {
          type: 'button', text: '×', title: tr('閉じる'), onclick: () => panel.remove()
        })
      ),
      h('div.azr-panel-body',
        total ? h('div.azr-total-row.is-grand',
          h('span', { text: tr('適用中の割引') }),
          h('strong', { text: `-${yen(total)}` })
        ) : '',
        !found ? h('div.azr-empty', { text: tr('この注文に使えるクーポンはありません') }) : '',
        note ? h('div.azr-coupon-status', { text: note }) : '',
        // best は「今より得なもの」だけが来る。楽天が先に選んだものがあれば「切り替え」と言う。
        best ? h('button.azr-btn-primary', {
          type: 'button',
          text: `${applied ? tr('最良クーポンに切り替え') : tr('最良クーポンを適用')}（-${yen(best.discount)}）`,
          onclick: async (e) => {
            const button = e.currentTarget;
            button.disabled = true;
            button.textContent = tr('適用中…');
            const r = await onApply(best.coupon);
            if (r.ok) button.textContent = tr('適用しました');
            if (!r.ok) {
              button.disabled = false;
              button.textContent = tr('最良クーポンを適用');
              panel.querySelector('.azr-coupon-status')?.remove();
              panel.querySelector('.azr-panel-body')
                .append(h('div.azr-coupon-status', { text: tr('適用できなかった: {reason}', { reason: tr(r.reason) }) }));
            }
          }
        }) : '',
        found ? h('details.azr-breakdown', { open: best ? 'open' : null },
          h('summary', { text: tr('使えるクーポン {n}件', { n: found }) }),
          h('ul', groups.flatMap((g) => AZR.coupons
            .rank(g.coupons, g.subtotal, g.shipping)
            .map(({ coupon, discount }) => h('li',
              h('span.azr-shop-name', { text: coupon.label.slice(0, 40), title: coupon.label }),
              h('span', { text: discount ? `-${yen(discount)}` : tr('条件未達') })
            ))))
        ) : ''
      )
    );
    return panel;
  }

  /* 本体 --------------------------------------------------------------------- */

  let unsubscribe = null;

  AZR.register('checkout', 'checkout-coupon', async () => {
    if (!AZR.settings.couponAutoApply) return;
    unsubscribe?.();
    unsubscribe = null;

    const state = await waitForState({ timeout: 10000 });
    AZR.health.check('checkout.state', state, '10秒待っても届かない（state-bridge.js が状態を読めない）');
    if (!state) {
      AZR.warn('注文確認の状態を受け取れなかった');
      return;
    }

    let autoApplied = false;
    // 状態は数百msごとに流れてくる。中身が同じなのに描き直すと、
    // 押そうとした瞬間にボタンが差し替わってクリックが消える（実機で踏んだ）。
    let lastSignature = '';
    let busy = false;
    let selectedNow = []; // 今選ばれているクーポン（切り替えるときに先に外す）

    // 適用の最中は描き直さない。押している最中にボタンごと差し替わってしまう。
    const runApply = async (coupon) => {
      busy = true;
      try {
        const r = await applyCoupon(coupon, selectedNow);
        AZR.health.check('checkout.apply', r.ok, r.reason);
        if (!r.ok) AZR.warn('クーポンを適用できなかった:', r.reason);
        else lastSignature = ''; // 結果を反映するため、次の状態で描き直す
        return r;
      } catch (e) {
        // 途中で例外が出ても「適用中…」のまま固まらせない
        AZR.warn('クーポン適用中に例外:', e);
        return { ok: false, reason: String(e?.message || e) };
      } finally {
        busy = false;
      }
    };

    /*
     * 自動で切り替えた後、実際に引かれる額が増えたかを確かめる。割引額はクーポンの文言から推測しているので、
     * 読み違えて損なクーポンに切り替えることがありうる。減っていたら、前に選ばれていたクーポンへ戻す。
     */
    const appliedOf = (s) => collect(s).reduce((t, g) => t + g.applied, 0);
    const waitApplied = (before, timeout = 8000) => new Promise((resolve) => {
      let done = false;
      let off = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off?.();
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), timeout);
      off = onState((s) => { const a = appliedOf(s); if (a !== before) finish(a); });
      if (done) off();
    });
    const verifyAutoApply = async (before, prev, chosen) => {
      const after = await waitApplied(before);
      AZR.log('auto apply verify', { before, after });
      AZR.health.check('checkout.verify', after != null, '切り替えた後の割引額が届かない');
      if (after == null || after >= before) return;
      AZR.health.check('checkout.estimate', false, `推測より割引が少ない: ${chosen.label}（${before}円 → ${after}円）`);
      if (!prev.length) return;
      busy = true;
      try {
        const r = await applyCoupon(prev[0], [chosen]);
        AZR.log('auto apply revert', r);
        AZR.health.check('checkout.revert', r.ok, r.reason);
      } catch (e) {
        AZR.warn('クーポンを戻せなかった:', e);
      } finally {
        busy = false;
        lastSignature = '';
      }
    };

    const paint = async (current) => {
      if (busy) return;
      const groups = collect(current);
      // 今より多く引けるものがあるときだけ better が来る（楽天が先に選んだものが最良とは限らない）
      const { appliedTotal, best, better, selected } = chooseSwitch(groups);
      selectedNow = selected;

      const note = better
        ? (appliedTotal ? tr('今のクーポン（-{y}）より得なクーポンがあります', { y: yen(appliedTotal) }) : null)
        : appliedTotal
          ? tr('最良のクーポンが適用されています')
          : (groups.some((g) => g.coupons.length) ? tr('条件を満たすクーポンがありません') : null);

      const signature = JSON.stringify([
        appliedTotal,
        groups.map((g) => [g.shopId, g.applied, g.subtotal, g.coupons.length, g.coupons.filter((c) => c.selected).map((c) => c.id || c.label)]),
        better ? [better.coupon.id || better.coupon.label, better.discount] : null
      ]);
      if (signature === lastSignature && document.getElementById(PANEL_ID)) return;
      lastSignature = signature;

      document.getElementById(PANEL_ID)?.remove();
      document.body.append(render(groups, better, appliedTotal > 0, note, runApply));
      AZR.log('checkout coupons', { groups, best, better, appliedTotal });

      // 確認なしの設定なら、いちばん得なものに1回だけ自分で切り替える
      // （失敗しても押し直しはしない。表示のボタンから本人がやり直せる）
      if (better && !autoApplied && !AZR.settings.couponAutoApplyConfirm && AZR.settings.consentAt) {
        autoApplied = true;
        const prev = selected.filter((c) => !sameCoupon(c, better.coupon));
        const r = await runApply(better.coupon);
        AZR.log('auto apply', r);
        if (r.ok) await verifyAutoApply(appliedTotal, prev, better.coupon);
      }
    };

    await paint(state);

    unsubscribe = onState((next) => {
      if (AZR.pageKind() !== 'checkout') return;
      if (!document.getElementById(PANEL_ID)) return; // 閉じられたら描き直さない
      paint(next);
    });
  });
})();
