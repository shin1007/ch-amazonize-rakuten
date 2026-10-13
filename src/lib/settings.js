/* Amazonize Rakuten - settings store (content-script global) */
(() => {
  const DEFAULTS = {
    enabled: true,
    language: 'auto',         // 表示言語（'auto' はブラウザの言語に合わせる）
    simplifyItem: true,       // 商品ページをAmazon風に再構成
    simplifySearch: true,     // 検索結果を整理
    cartTotal: true,          // カゴの合計金額パネル
    amazonPrice: true,        // 商品ページにAmazonでの価格を出す
    rakutenLink: true,        // Amazonの商品ページに、楽天の同じ商品へのリンクと価格を出す
    yahooPrice: true,         // 楽天・Amazonの商品ページに、Yahoo!ショッピングでの価格も出す
    yahooItem: true,          // Yahoo!ショッピングの商品ページに、Amazon・楽天での価格を出す
    nesagePromo: true,        // Amazonのほしい物リストで、値下げ通知サービス nesage.party への登録を案内する
    couponList: true,        // 商品ページにクーポンを並べる（その場で獲得できる）
    couponAutoGrab: true,     // 商品ページを開いた時点で、押さずに獲得する
    couponAutoApply: true,    // 購入手続きで最良クーポンを自動適用
    couponAutoApplyConfirm: false, // 自動適用の前に確認する（既定は確認なしで最良に切り替える）
    campaignEntry: true,          // キャンペーンページにエントリーパネルを出す
    campaignAutoEntry: false,
    campaignScanEntry: true,      // 一括スキャンで見つけたものをエントリーする
    campaignScanOnTop: true,      // 楽天のページを開いたら、裏で探してエントリーする（12時間おき）
    campaignTabFallback: false,   // fetchで判定できないページをタブで開き直す（タブが見える）
    campaignUrls: [               // ポップアップの一括エントリー対象（編集可）
      'https://event.rakuten.co.jp/card/pointday/',
      'https://event.rakuten.co.jp/campaign/sports/',
      'https://event.rakuten.co.jp/campaign/point-up/everyday/point/'
    ],
    // 自動で行う操作（クーポンの自動獲得・自動切り替え・キャンペーンの自動エントリー）に同意した時刻。
    // 0 の間はどれも動かさない（入れた直後に開く welcome ページで選んでもらう）
    consentAt: 0,
    noAffiliate: false,       // 開発用: アフィリエイト/アソシエイトIDを含めない
    debug: false
  };

  const AZR = (window.AZR = window.AZR || {});
  AZR.DEFAULTS = DEFAULTS;
  AZR.settings = { ...DEFAULTS };

  // 同じページの複数のスクリプトが呼ぶ（Amazonでは4つ）。storage を読むのは最初の1回だけにする。
  // その後の変更は onSettingsChanged が AZR.settings に反映する
  let loading = null;
  AZR.loadSettings = function loadSettings() {
    loading ||= (async () => {
      try {
        const stored = await chrome.storage.sync.get(DEFAULTS);
        AZR.settings = { ...DEFAULTS, ...stored };
        AZR.setLanguage?.(AZR.settings.language);
      } catch {
        AZR.settings = { ...DEFAULTS };
      }
    })();
    return loading.then(() => AZR.settings);
  };

  AZR.onSettingsChanged = function onSettingsChanged(cb) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (const [k, v] of Object.entries(changes)) AZR.settings[k] = v.newValue;
        if (changes.language) AZR.setLanguage?.(AZR.settings.language);
        cb(AZR.settings, changes);
      });
    } catch { /* extension context invalidated */ }
  };

  AZR.log = (...args) => { if (AZR.settings.debug) console.log('%c[AZR]', 'color:#f60', ...args); };
  AZR.warn = (...args) => console.warn('[AZR]', ...args);
})();
