/* Amazonize Rakuten - 楽天の候補エリアの枠だけを、ページの読み込み完了を待たずに先に置く
 * （結果の取得・表示は amazon-link.js。ここで置いた枠を、そちらが結果で置き換える） */
(async () => {
    const AZR = (window.AZR = window.AZR || {});
    await AZR.loadSettings();
    const { rakutenLink, amazonPageYahoo } = AZR.settings;
    if (!AZR.settings.enabled || !(rakutenLink || amazonPageYahoo)) return;
    const { findPrice, newWrap, loadingRow, disclosure, yahooDisclosure, place } = AZR.slot;

    const ready = () => document.getElementById('productTitle') && findPrice();
    const put = () => {
        if (document.getElementById('rakuten-link-btn') || document.getElementById('yahoo-link-btn') || !document.getElementById('productTitle')) return;
        // 楽天 → Yahoo!ショッピング の順に積む（amazon-link.js も同じ順に置き換える）
        let prev = null;
        for (const [on, id, text, note] of [
            [rakutenLink, 'rakuten-link-btn', AZR.t('楽天の商品情報を取得中…'), disclosure],
            [amazonPageYahoo, 'yahoo-link-btn', AZR.t('Yahoo!ショッピングの商品情報を取得中…'), yahooDisclosure]
        ]) {
            if (!on) continue;
            const wrap = newWrap(id);
            wrap.append(loadingRow(text), loadingRow(text), note());
            if (prev) prev.after(wrap); else place(wrap);
            prev = wrap;
        }
    };

    // 商品名と価格が出たらすぐ置く。価格が出ないページでも、DOMの読み込みが終わったら置く
    if (ready()) return put();
    // 読み込み中は変化が非常に多く、findPrice はレイアウトの計算を伴うので、描画1回ぶんにまとめて見る
    let queued = false;
    const obs = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; if (ready()) { obs.disconnect(); put(); } });
    });
    obs.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => { obs.disconnect(); put(); }, { once: true });
})();
