/* Amazonize Rakuten - Yahoo!ショッピングの検索結果・カテゴリ一覧: 広告（PR）の商品を目立たなくする
 * 楽天の検索結果（search.js）と同じ見た目・同じ設定（simplifySearch）。消さずに薄くするだけ。
 * PRの印は商品画像の上の [class*="imageIcon--pr"]。その画像の枠の親が商品1件の枠。 */
(async () => {
    const AZR = (window.AZR = window.AZR || {});
    await AZR.loadSettings();
    if (!AZR.settings.enabled || !AZR.settings.simplifySearch) return;
    document.documentElement.classList.add('azr-search');

    const ITEM = '[class*="SearchResultItem__"]';
    // 商品の枠が見つからないと、広告の判定は黙って何もしない
    AZR.health.expect('yahoo.searchItems', () => document.querySelector(ITEM), { detail: `${ITEM} が無い` });

    const markAds = () => {
        for (const icon of document.querySelectorAll('[class*="imageIcon--pr"]:not([data-azr-checked])')) {
            icon.dataset.azrChecked = '1';
            icon.closest('[class*="SearchResultItem__image"]')?.parentElement?.classList.add('azr-ad-item');
        }
    };

    markAds();
    // 続きの結果はスクロールで足される
    let queued = false;
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; markAds(); });
    }).observe(document.body, { childList: true, subtree: true });
})();
