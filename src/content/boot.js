/* Amazonize Rakuten - エントリポイント / ページ種別ディスパッチ */
(() => {
  const AZR = (window.AZR = window.AZR || {});
  const modules = [];

  /** 各コンテンツモジュールはここに登録する */
  AZR.register = (kinds, name, run) => {
    modules.push({ kinds: [].concat(kinds), name, run });
  };

  const kind = AZR.pageKind();
  const root = document.documentElement;
  // 設定の読み込みは待たずに始めておく（ページの読み込みと並行させる）
  const settingsLoaded = AZR.loadSettings();

  // ちらつき防止: 再構成するページは一旦隠す。失敗しても必ず表示に戻す。
  let unhidden = false;
  // 表示までの時間（ページの読み込み開始からのms）。tools/harness.mjs が読んで出す
  const mark = (name) => { root.dataset[name] = String(Math.round(performance.now())); };
  mark('azrBootMs');
  const unhide = () => {
    if (unhidden) return;
    unhidden = true;
    root.classList.remove('azr-preload');
    mark('azrShownMs');
  };
  if (kind === 'item') {
    root.classList.add('azr-preload');
    setTimeout(unhide, 10000); // フェイルセーフ
  }
  AZR.unhide = unhide;

  async function runModules(currentKind) {
    root.dataset.azrPage = currentKind;
    AZR.log('run', currentKind);
    for (const m of modules) {
      if (!m.kinds.includes(currentKind)) continue;
      try {
        await m.run();
        AZR.health.check(`module:${m.name}`, true);
      } catch (e) {
        AZR.warn(`module "${m.name}" failed:`, e);
        AZR.health.check(`module:${m.name}`, false, e);
      }
    }
  }

  async function main() {
    await settingsLoaded;
    root.dataset.azrPage = kind;
    if (!AZR.settings.enabled) return unhide();
    if (kind === 'item' && !AZR.settings.simplifyItem) unhide();

    AZR.log('boot', kind, AZR.settings);

    await runModules(kind);
    unhide();

    // 楽天のページを開いたのを合図に、裏でキャンペーンを探してエントリーする。
    // タブは開かないので、開いているページも画面も変わらない（以前はトップページ限定だった）。
    // 走らせるかどうか（設定・前回からの間隔・実行中か）は service worker が決める。
    // かご・購入手続き（*.step.rakuten.co.jp）では走らせない。決済の通信と取り合わせない。
    if (AZR.settings.campaignScanOnTop && AZR.settings.consentAt && !/(^|\.)step\./.test(location.host)) {
      const links = kind === 'top' ? await AZR.collectCampaignLinks?.({ scroll: false }).catch(() => []) : [];
      chrome.runtime.sendMessage({ type: 'azr:autoScanCampaigns', links })
        .then((r) => AZR.log('自動スキャン', r))
        .catch(() => { /* service worker が落ちている */ });
    }

    // かご→購入手続きはSPA内の経路変更で、ページは読み込み直されない。
    // 種別が変わったら自分のパネルを片付けて、その画面のモジュールを動かし直す。
    if (location.host === 'cart.step.rakuten.co.jp') {
      let lastKind = kind;
      AZR.onRouteChange(() => {
        const next = AZR.pageKind();
        if (next === lastKind) return;
        lastKind = next;
        for (const p of document.querySelectorAll('.azr-panel')) p.remove();
        runModules(next);
      });
    }
  }

  /**
   * 商品ページは DOMContentLoaded を待たない。
   * 商品データのJSON（#item-page-app-data）は body の末尾近くにあり、その直後に
   * 楽天のReactのバンドルが3本、同期スクリプトとして続く。DOMContentLoaded は
   * これらの取得と実行が終わるまで来ない（保存したページでも0.3〜0.4秒、実際の通信ではもっと）。
   * JSONが読み終わった時点で、再構成に要るものはそろっている。
   * 購入エリアの枠もその前にHTMLで届いており、中身はバンドルが後から描き込む。
   */
  function itemDataReady() {
    const done = () => {
      const el = document.getElementById('item-page-app-data');
      // 次の節点が来ていれば、パーサーはJSONを読み終えている
      return (el && el.nextSibling) || document.readyState !== 'loading';
    };
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (!done()) return;
        obs.disconnect();
        resolve();
      });
      obs.observe(document, { childList: true, subtree: true });
      AZR.domReady.then(() => { obs.disconnect(); resolve(); });
    });
  }

  // 全モジュールの register が済んでから実行する
  const start = () => mark('azrReadyMs') || queueMicrotask(() => main().catch((e) => { AZR.warn(e); unhide(); }));
  (kind === 'item' ? itemDataReady() : AZR.domReady).then(start);

  AZR.onSettingsChanged?.(() => {
    // 設定変更は再読み込みで反映（部分的な巻き戻しは行わない）
    document.getElementById('azr-reload-hint')?.remove();
  });
})();
