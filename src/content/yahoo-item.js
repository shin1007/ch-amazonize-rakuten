/* Amazonize Rakuten - Yahoo!ショッピングの商品ページ（左右キーでの画像送り・Amazonと楽天の価格）
 *
 * 1. 左右キーで商品画像を送る
 *    ページ上: サムネイル列のボタンに、Yahoo!自身がマウスを乗せたときと同じ動き（mouseover）を送る（click では切り替わらない）。
 *    拡大表示（画像を押すと開く画面）: 画面の ‹ › ボタンを押す。Yahoo!の拡大表示は矢印キーに応えない。
 *    Esc でも閉じられるようにする（Yahoo!の拡大表示は Esc で閉じない）。
 * 2. 価格の下に、同じ商品のAmazon・楽天での価格を並べる（楽天の商品ページと同じ欄。描くのは item-amazon.js）
 *    商品データはページに埋め込まれた __NEXT_DATA__ から読む（商品名・価格・JAN・選択肢ごとの価格）。
 *    - 選択肢（3袋/10袋など）で値段が変わる商品は、Yahoo!が最初に出す価格が最安とは限らない（10袋の6,580円を出し、
 *      3袋は2,080円）。選択肢ごとの価格から最安〜最高を出し、選んだら、その選択肢の価格で比べ直す。
 *      選択肢を選んでもURLは変わらず、価格の欄（#prcdsp）の数字だけが変わる。
 *    - 店の付けた商品名が崩れていることがある（「ANGFA　スカルプDストロングオイリーカエ」）。JANがあれば
 *      同じJANの他店の商品名を引き、いちばん他と重なる名前で探す。
 *    別の商品へのリンクは普通のリンクで、ページごと読み直される（ページの中で商品が入れ替わることはない）。
 */
(async () => {
    const AZR = (window.AZR = window.AZR || {});
    // 商品ページは /<ストア>/<商品>.html。ストアのトップや一覧では何もしない
    if (!/^\/[\w-]+\/[\w-]+\.html$/.test(location.pathname)) return;
    await AZR.loadSettings();
    if (!AZR.settings.enabled) return;

    /* 1. 左右キー ---------------------------------------------------------- */

    const isTypingTarget = (el) => Boolean(el) && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA|OPTION|VIDEO|AUDIO)$/.test(el.tagName));
    const shown = (el) => el.getBoundingClientRect().width > 0;
    // 拡大表示は閉じてもしばらく（閉じる動きのあいだ）残るので、開いている印（ModalView--open）のあるものだけを見る
    const modalButton = (cls) => [...document.querySelectorAll(`.ModalView--open .ModalView__contents button[class*="${cls}"]`)].find(shown);
    const thumbs = () => [...document.querySelectorAll('button[class*="thumbnailButton"]')]
        .filter((b) => shown(b) && !b.closest('.ModalView__contents'));

    function step(delta) {
        const list = thumbs();
        if (list.length < 2) return false;
        const at = list.findIndex((b) => /isCurrent/.test(b.className));
        const next = list[((at < 0 ? 0 : at) + delta + list.length) % list.length];
        next.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        // 選択の印（isCurrent）が移らなければ、Yahoo!が mouseover で切り替えなくなった
        if (AZR.health.dev) {
            setTimeout(() => AZR.health.check('yahoo.galleryStep', /isCurrent/.test(next.className),
                'サムネイルに mouseover を送っても isCurrent が移らない'), 500);
        }
        return true;
    }

    AZR.health.expect('yahoo.galleryThumbs', () => thumbs().length, { detail: 'button[class*="thumbnailButton"] が無い' });

    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.key === 'Escape') {
            const close = modalButton('closeButton');
            if (!close) return;
            close.click();
            return e.preventDefault();
        }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (isTypingTarget(e.target)) return;
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        const nav = modalButton(delta < 0 ? 'leftArrowButton' : 'rightArrowButton');
        if (nav) nav.click();
        // カート・選択肢など、画像以外の画面が開いているときは、後ろの商品画像を送らない
        else if (document.querySelector('.ModalView--open') || !step(delta)) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);

    /* 2. Amazon・楽天の価格 -------------------------------------------------- */
    if (!AZR.settings.yahooItem) return;

    let item = null;
    try {
        item = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null')?.props?.pageProps?.item || null;
    } catch { /* 下で失敗として記録する */ }
    AZR.health.check('yahoo.itemData', item?.name, '__NEXT_DATA__ の props.pageProps.item.name が無い');
    if (!item?.name) return;

    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    // 選択肢ごとの価格（在庫のあるものだけ）。選択肢の無い商品は空
    const skus = (Array.isArray(item.individualItemList) ? item.individualItemList : [])
        .filter((s) => s?.stock?.isAvailable !== false && Number(s?.price?.applicablePrice) > 0);
    const prices = skus.map((s) => Number(s.price.applicablePrice));
    const jan = item.isJanCodeActive === false ? '' : String(item.janCode || '');
    // このページの送料（届け先の都道府県の分）。「同一ストア3,000円以上で送料無料」は、この商品だけで超えるときだけ0にする
    const postage = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || 'null')?.props?.pageProps?.postage || null;
    const freeOver = Number((String(postage?.conditionFreeText || '').match(/([\d,]+)\s*円以上/)?.[1] || '').replace(/,/g, '')) || 0;
    const shippingFee = (price) => {
        if (!postage) return null;
        if (postage.isPostageFree) return 0;
        const fee = Number(postage.fee);
        if (!Number.isFinite(fee)) return null;
        return freeOver && price >= freeOver ? 0 : fee;
    };
    const data = {
        title: await betterTitle(clean(item.name), jan),
        // 「2kg 2個セット」のような数や型番は、他店の名前に置き換える前の、このページの商品名で見る
        pageTitle: clean(item.name),
        minPrice: prices.length ? Math.min(...prices) : Number(item.applicablePrice) || null,
        maxPrice: prices.length ? Math.max(...prices) : null,
        jan,
        variants: skus.map((s) => (s.optionList || []).map((o) => o.choiceName).join(' ')),
        // 型番を拾う手がかり（item-amazon.js が extractModel に渡す）
        descriptionHtml: [item.caption, item.information].filter((s) => typeof s === 'string' && s)
    };
    data.shippingFee = shippingFee(data.minPrice);

    /** JANがあれば、同じJANで売っている他店の商品名と比べて、いちばん他と重なる名前を選ぶ（自分の名前も候補に入れる） */
    async function betterTitle(title, jan) {
        if (!AZR.amazon.isJan(jan)) return title;
        let res = null;
        try { res = await chrome.runtime.sendMessage({ type: 'azr:yahooSearch', jan }); } catch { /* 元の名前で探す */ }
        const names = [...new Set([title, ...(res?.items || []).map((it) => clean(it.itemName))])].filter(Boolean);
        if (names.length < 3) return title;
        const near = (n) => names.reduce((sum, m) => sum + (m === n ? 0 : AZR.amazon.scoreMatch(n, m)), 0);
        const best = names.reduce((a, b) => (near(b) > near(a) ? b : a));
        if (best !== title) AZR.log('商品名を置き換えた', title, '→', best);
        return best;
    }

    const { SITES, HOMES, mount } = AZR.priceCompare;
    const anchor = document.getElementById('prcdsp'); // 中央の列の価格の欄
    AZR.health.check('yahoo.pricePlace', anchor, '#prcdsp（価格の欄）が無い');
    if (!anchor) return;
    const { boxes, repaint } = mount(anchor, data, [SITES.amazon, SITES.rakuten], HOMES.yahoo);

    // 価格の欄に出ている数字（選択肢を選ぶと変わる）
    const shownPrice = () => Number((document.querySelector('#prcdsp [class*="_price__"]')?.textContent.match(/[\d,]+/)?.[0] || '').replace(/,/g, '')) || 0;
    const firstShown = shownPrice();

    // ページの描き直し（Reactの読み込み直後など）で外れたら、価格の欄の下へ置き直す。
    // 選択肢を選んで価格の欄の数字が変わったら、その価格で比べ直す
    let queued = false;
    let lastShown = firstShown;
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            if (!boxes.every((b) => b.isConnected)) document.getElementById('prcdsp')?.after(...boxes);
            const now = shownPrice();
            if (!skus.length || !now || now === lastShown) return;
            lastShown = now;
            data.minPrice = now;
            data.maxPrice = null;
            data.shippingFee = shippingFee(now);
            repaint();
        });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
})();
