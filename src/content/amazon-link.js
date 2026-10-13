/* Amazonize Rakuten - Amazonの商品ページに、楽天の同じ商品へのリンクと価格を出す
 * （旧「楽天比較リンク for Amazon」を統合したもの。検索は service worker 経由） */
(async () => {
    const AZR = (window.AZR = window.AZR || {});
    // 商品ページのURLなのに商品名が無い = ページの形が変わった（この先の機能はすべて商品名を手がかりにする）
    if (/\/(?:dp|gp\/product)\/[A-Z0-9]{10}/.test(location.pathname)) {
        AZR.health.check('amazon.productTitle', document.getElementById('productTitle'), '#productTitle が無い');
    }
    if (!document.getElementById('productTitle')) return;
    await AZR.loadSettings();
    if (!AZR.settings.enabled || !(AZR.settings.rakutenLink || AZR.settings.amazonPageYahoo)) return;
  const tr = AZR.t;
    
    const title = document.getElementById('productTitle').innerText.trim();
    const detailText = [...document.querySelectorAll(
        '#productDetails_techSpec_section_1, #productDetails_detailBullets_sections1, #detailBullets_feature_div, #rpi-attribute-book_details-isbn13, #rpi-attribute-book_details-isbn10'
    )].map(el => el.textContent).join('\n');

    // 登録情報・商品概要を「項目名 → 値」で収集
    const clean = (s) => (s || '').replace(/[‎‏]/g, '').replace(/\s+/g, ' ').replace(/^[\s:：]+|[\s:：]+$/g, '');
    const details = {};
    document.querySelectorAll('#productOverview_feature_div tr, #productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #prodDetails tr')
        .forEach(tr => { const c = tr.querySelectorAll('th, td'); if (c.length >= 2) details[clean(c[0].textContent)] ??= clean(c[c.length - 1].textContent); });
    document.querySelectorAll('#detailBullets_feature_div li')
        .forEach(li => { const s = li.querySelectorAll('span > span'); if (s.length >= 2) details[clean(s[0].textContent)] ??= clean(s[1].textContent); });
    const detail = (...labels) => {
        const key = Object.keys(details).find(k => labels.includes(k));
        return key ? details[key] : '';
    };

    // bylineは書籍だと著者名等が入るので、ブランド表記の形のときだけ採用
    const bylineText = clean(document.getElementById('bylineInfo')?.textContent);
    const byline = (bylineText.match(/^ブランド[:：]\s*(.+)$/) || bylineText.match(/^(.+)のストアを表示$/) || bylineText.match(/^Visit the (.+) Store$/) || [])[1] || '';
    const brand = (detail('ブランド', 'ブランド名', 'メーカー', 'メーカー名') || byline).replace(/[（(][^）)]*[）)]/g, '').trim();

    const model = detail('型番', 'メーカー型番', '製品型番', 'モデル番号', '商品モデル番号', 'モデル名');
    const validModel = /^[\w./+-]{3,30}$/.test(model.replace(/\s/g, '')) && /\d/.test(model) && !/^\d{13}$/.test(model) ? model : '';

    // 商品名から検索語を作る
    const NOISE = /送料無料|国内正規品|日本正規代理店品|正規代理店品|正規品|公式|新品|純正|限定|Amazon\.co\.jp|メーカー保証|(?:ブラック|ホワイト|グレー|シルバー|ゴールド|ネイビー|ブルー|レッド|ピンク|グリーン|ベージュ|ブラウン)(?:色)?/gi;
    const titleKeyword = () => {
        let t = title
            .replace(/[【\[「『][^】\]」』]*[】\]」』]|[（(][^）)]*[）)]/g, ' ')
            .split(/\s[|｜\/／]\s|[|｜、,，]|\s-\s/)[0]
            .replace(NOISE, ' ');
        if (brand) t = t.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
        const words = t.replace(/\s+/g, ' ').trim().split(' ').filter(w => w.length > 1 || /\d/.test(w)).slice(0, 5);
        return [brand, ...words].filter(Boolean).join(' ');
    };

    const isbn10to13 = (isbn10) => {
        const body = '978' + isbn10.slice(0, 9);
        const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
        return body + (10 - sum % 10) % 10;
    };

    // 検索候補を優先順に並べる
    const candidates = [];
    const jan = detailText.match(/(?:JAN|EAN)[^0-9]{0,10}(\d{13})/);
    const isbn13 = detailText.match(/ISBN-13[^0-9]{0,10}(97[89][\d-]{10,14})/);
    const isbn10 = detailText.match(/ISBN-10[^0-9]{0,10}(\d[\d-]{8,11}[\dXx])/);
    if (jan) candidates.push({ type: 'JAN', value: jan[1] });
    if (isbn13 && isbn13[1].replace(/-/g, '').length === 13) candidates.push({ type: 'ISBN', value: isbn13[1].replace(/-/g, '') });
    else if (isbn10 && isbn10[1].replace(/-/g, '').length === 10) candidates.push({ type: 'ISBN', value: isbn10to13(isbn10[1].replace(/-/g, '')) });
    // 型番: 短い型番は誤ヒットしやすいのでブランド名を付ける
    if (validModel) candidates.push({ type: '型番', value: validModel.length < 6 && brand ? `${brand} ${validModel}` : validModel });
    const titleKw = titleKeyword();

    candidates.push({ type: null, value: titleKw });

    const { findPrice } = AZR.slot;
    // 読み上げ用の .a-offscreen が空の形がある（priceToPay。見えている "￥3,982" の方にだけ入る）ので、無ければ表示の文字から読む
    const priceEl = findPrice();
    const priceText = priceEl?.querySelector('.a-offscreen')?.textContent.trim() || priceEl?.innerText || '';
    const amazonPrice = Number((priceText.match(/[\d,]+/)?.[0] || '').replace(/,/g, '')) || 0;
    // カートに入れられる（＝売っている）のに価格が読めない
    if (document.getElementById('add-to-cart-button')) AZR.health.check('amazon.price', amazonPrice, `価格を読めない（"${priceText.slice(0, 30)}"）`);

    /*
     * 探す先。楽天とYahoo!ショッピングは、どちらも中継Worker経由で同じ形の結果（itemName / itemPrice / …）を返すので、
     * 並べ替え・表示は同じものを使う。Yahoo!ショッピングの欄は楽天の欄のすぐ下に置く。
     */
    const RAKUTEN = {
        id: 'rakuten-link-btn', color: '#bf0000', mark: 'R',
        message: (c) => ({ type: 'azr:rakutenSearch', keyword: c.value }),
        plainSearchUrl: (kw) => `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(kw)}/`,
        loading: () => tr('楽天の商品情報を取得中…'),
        price: (p, via) => tr('楽天 ￥{p}{via}', { p, via }),
        apiError: (e) => tr('楽天API エラー: {e}', { e }),
        // 楽天へのリンクは開発者のアフィリエイトID付き。その旨を小さく添える
        disclosure: () => AZR.slot.disclosure(),
        checkShops: true,
        place: (wrap) => {
            const yahoo = document.getElementById('yahoo-link-btn');
            if (yahoo) yahoo.before(wrap); else AZR.slot.place(wrap);
        }
    };
    const YAHOO = {
        id: 'yahoo-link-btn', color: '#ff0033', mark: 'Y',
        // JAN・ISBN（13桁のISBNはJANと同じ）はJANとして引く。型番・商品名は語で引く
        message: (c) => (c.type === 'JAN' || c.type === 'ISBN') ? { type: 'azr:yahooSearch', jan: c.value } : { type: 'azr:yahooSearch', keyword: c.value },
        plainSearchUrl: (kw) => `https://shopping.yahoo.co.jp/search?p=${encodeURIComponent(kw)}`,
        loading: () => tr('Yahoo!ショッピングの商品情報を取得中…'),
        price: (p, via) => tr('Yahoo! ￥{p}{via}', { p, via }),
        apiError: (e) => tr('Yahoo!ショッピングAPI エラー: {e}', { e }),
        disclosure: () => AZR.slot.yahooDisclosure(),
        checkShops: false,
        place: (wrap) => {
            const rakuten = document.getElementById('rakuten-link-btn');
            if (rakuten) rakuten.after(wrap); else AZR.slot.place(wrap);
        }
    };

    const runSite = (site) => {
        // 検索結果ページ: 中継サーバーが返すアフィリエイト付きURLを優先
        const affiliateSearchUrls = new Map();
        const searchUrl = (kw) => affiliateSearchUrls.get(kw) || site.plainSearchUrl(kw);
        const apiSearch = (c) => new Promise(resolve => {
            try {
                chrome.runtime.sendMessage(site.message(c), (res) => {
                    resolve(chrome.runtime.lastError ? { error: 'runtime' } : res);
                });
            } catch { resolve({ error: 'runtime' }); }
        });

        /*
         * 商品名の類似度。楽天・Yahoo!の商品ページと同じ scoreMatch（amazon-match.js）を使う。
         * 以前はここだけ文字の2文字ずつの重なり（Dice係数）と価格差で選んでいて、ページによって判定が違った。
         * JANで正解を決めた比較（tools/match-eval.mjs）では、scoreMatch に下の規格の食い違いを組み合わせた形（このページの形）が、
         * Dice係数（価格差あり・なし）より損失が小さかった。
         * Amazonの商品名（短い）の語が、楽天・Yahoo!の商品名（宣伝で長い）にどれだけ入っているかで見る。
         */
        const similarity = (name) => AZR.amazon.scoreMatch(title, name);
        // 数量・規格（4入力 / 2台 / 256GB / 3個セット 等）が食い違う商品は別物とみなす
        const toHalf = (s) => s.replace(/[０-９．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
        const specsOf = (s) => {
            const m = new Map();
            for (const [, n, unit] of toHalf(s).matchAll(/(\d+(?:\.\d+)?)\s*(入力|出力|台|ポート|口|個|枚|本|袋|箱|セット|GB|TB|mAh|W|ml|L|kg|g|cm|mm|インチ|型)/gi)) {
                const u = unit.toLowerCase();
                if (!m.has(u)) m.set(u, new Set());
                m.get(u).add(Number(n));
            }
            return m;
        };
        const amazonSpecs = specsOf(title);
        // 名前で引いたときの合格点（service worker の AMAZON_MIN_SCORE と同じ）
        const MIN_SCORE = 0.3;
        const specMismatch = (name) => {
            for (const [u, nums] of specsOf(name)) {
                const a = amazonSpecs.get(u);
                if (a && ![...nums].some(n => a.has(n))) return true;
            }
            return false;
        };

        // 新品の商品ページに中古・整備済み品を当てない（楽天・Yahoo!の商品ページと同じ）
        const rankItems = (items) => AZR.amazon.sameCondition(title, items.map((it) => ({ ...it, title: it.itemName })))
            .map(({ title: _, ...it }) => {
                const sim = similarity(it.itemName);
                return { it, sim, mismatch: specMismatch(it.itemName), score: sim };
            })
            .sort((a, b) => b.score - a.score);

        let code = null;
        let keyword = titleKw;
        let ranked = [];       // 候補商品（良い順）。先頭がリンク先
        let apiError = null;
        /*
         * 同じ問い合わせは1回にまとめる。商品名の検索は、JAN・型番で見つかっても必ず行う（下の resolveTitleTop）ので、
         * JAN・型番の検索を待たずに最初から投げておく（以前は JAN → 型番 → 商品名 と1つずつ待っていた）。
         */
        const searches = new Map();
        const search = (c) => {
            const key = JSON.stringify(site.message(c));
            if (!searches.has(key)) searches.set(key, apiSearch(c));
            return searches.get(key);
        };
        search({ type: null, value: titleKw });
        const resolveKeyword = async () => {
            for (const c of candidates) {
                const res = await search(c);
                if (res?.searchUrl) affiliateSearchUrls.set(c.value, res.searchUrl);
                if (res?.error) { apiError = res.error; return; }
                if (!res?.items?.length) continue;
                const all = rankItems(res.items);
                const matched = all.filter(r => !r.mismatch);
                // 商品名検索: 規格違い・類似度が低いものを除外
                // コード検索: 一致が保証されるので、規格違い（まとめ売り等）は他が無いときだけ残す
                ranked = (c.type ? (matched.length ? matched : all) : matched.filter(r => r.sim >= MIN_SCORE)).map(r => r.it);
                code = c; keyword = c.value;
                return;
            }
        };
        // 型番などで一致した商品が別物のことがあるので、商品名検索の上位も必ず並べて出す
        let titleTop = null;
        let phase = 'search';   // search: 楽天を検索中 / title: 商品名検索の上位を取得中 / done
            const resolveTitleTop = async () => {
            if (!code?.type) { titleTop = ranked[0] || null; return; }
            const res = await search({ type: null, value: titleKw });
            if (res?.searchUrl) affiliateSearchUrls.set(titleKw, res.searchUrl);
            const top = res?.items?.length && rankItems(res.items).filter(r => !r.mismatch && r.sim >= MIN_SCORE)[0];
            titleTop = top ? top.it : null;
        };

        // 閉店・改装中の店舗を除外する（ボタン表示後に上位5店舗をまとめて確認）
        const shopOf = (it) => it.shopCode || (() => {
            try { return new URL(new URL(it.itemUrl).searchParams.get('pc') || it.itemUrl).pathname.split('/')[1]; } catch { return ''; }
        })();
        const checkShops = (shops) => new Promise(resolve => {
            try {
                chrome.runtime.sendMessage({ type: 'azr:rakutenCheckShops', shops }, (res) => {
                    resolve(chrome.runtime.lastError ? {} : res || {});
                });
            } catch { resolve({}); }
        });
        const verifyBest = async () => {
            const shops = [...new Set(ranked.map(shopOf).filter(Boolean))].slice(0, 5);
            if (!shops.length) return;
            const status = await checkShops(shops);
            const before = ranked[0];
            ranked = ranked.filter(it => status[shopOf(it)] !== false);
            if (ranked[0] !== before) {
                document.getElementById(site.id)?.remove();
                createBtn();
            }
        };

        // 商品画像が無い・読めないときの代わり画像（店の色の地に白: 上は丸にR/Y、下はNo Image）
        const NO_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 104"><rect width="104" height="104" fill="${site.color}"/>` +
            '<circle cx="52" cy="38" r="22" fill="none" stroke="#fff" stroke-width="4"/>' +
            `<text x="52" y="47" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="28" fill="#fff">${site.mark}</text>` +
            '<text x="52" y="86" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="16" fill="#fff">No Image</text></svg>');

        // 表示用に、楽天の商品名に多い宣伝カッコ（【送料無料】[公式] ≪新作≫ など）を中身ごと落とす。
        // 丸カッコは容量・色などの規格が入るので残す。全部消えてしまうときは元の名前のまま
        const PROMO_BRACKETS = /【[^】]*】|[\[［][^\]］]*[\]］]|≪[^≫]*≫|《[^》]*》|〔[^〕]*〕|[＜<][^＞>]*[＞>]/g;
        const displayName = (name) => name.replace(PROMO_BRACKETS, ' ').replace(/\s+/g, ' ').trim() || name;

        const createBtn = () => {
            if (document.getElementById(site.id)) return;

            const link = (href, text, style) => {
                const el = document.createElement('a');
                el.href = href;
                el.target = '_blank';
                el.rel = 'noopener noreferrer';
                el.innerText = text;
                Object.assign(el.style, {
                    color: '#fff', fontWeight: 'bold', padding: '8px 16px', borderRadius: '8px',
                    display: 'inline-block', textDecoration: 'none', verticalAlign: 'middle', ...style
                });
                return el;
            };

            const wrap = AZR.slot.newWrap(site.id);

            const { pulse, rowStyle } = AZR.slot;
            // 型番検索・商品名検索の結果を、画像・価格・タイトル付きの1行ずつで並べる（行の大きさは固定）
            const rows = [];
            // 結果が揃ったあとに他の要素が動かないよう、2行は常に確保する（見つからないときも同じ高さの行を出す）
            const codeCand = candidates.find(c => c.type);
            rows.push({ label: tr(codeCand?.type || '型番'), hit: codeCand?.type === '型番' ? tr('型番が一致') : null, it: code?.type ? ranked[0] : null, kw: codeCand?.value, done: phase !== 'search', none: codeCand ? null : tr('この商品は型番・JANが取得できません') });
            rows.push({ label: tr('商品名'), it: code?.type ? titleTop : ranked[0], kw: titleKw, done: phase === 'done' || (!code?.type && phase !== 'search') });
            for (const r of rows) {
                const row = document.createElement('div');
                Object.assign(row.style, rowStyle);
                if (!r.done) {
                    Object.assign(row.style, { background: '#eee', color: '#888', fontSize: '12px' });
                    row.textContent = site.loading();
                    pulse(row);
                    wrap.appendChild(row);
                    continue;
                }
                const tag = ` (${r.it && r.hit || r.label})`;
                // 中継サーバーの応答をそのままリンクにしない（https 以外は捨てる）
                const https = (u) => (/^https:\/\//i.test(String(u || '')) ? String(u) : '');
                const it = r.it && https(r.it.affiliateUrl || r.it.itemUrl) ? r.it : null;
                const box = document.createElement(it ? 'a' : 'div');
                Object.assign(box.style, { display: 'flex', gap: '8px', alignItems: 'center', flex: '1', minWidth: 'min-content', color: '#333', textDecoration: 'none', fontSize: '12px' });
                if (it) { box.href = https(it.affiliateUrl || it.itemUrl); box.target = '_blank'; box.rel = 'noopener noreferrer'; }
                const img = document.createElement('div');
                Object.assign(img.style, { width: '52px', height: '52px', flex: 'none', background: '#f5f5f5' });
                const im = document.createElement('img');
                im.src = https(it?.imageUrl) || NO_IMAGE;
                im.onerror = () => { im.onerror = null; im.src = NO_IMAGE; };
                Object.assign(im.style, { width: '100%', height: '100%', objectFit: 'contain' });
                img.replaceChildren(im);
                box.appendChild(img);
                const body = document.createElement('div');
                // 行の高さは固定なので、価格は1行、商品名は2行までにして、枠からはみ出させない。
                // 価格（楽天 ￥1,900）だけは切らない幅を確保し、狭いときは右の検索ボタンの方を2行に折る
                Object.assign(body.style, { minWidth: 'min-content', flex: '1', overflow: 'hidden', lineHeight: '1.3' });
                if (it) {
                    const pr = document.createElement('div');
                    // 欄が狭いときは、価格は残して後ろの見出し（型番が一致 など）を…で切る
                    Object.assign(pr.style, { color: site.color, fontWeight: 'bold', fontSize: '14px', display: 'flex', whiteSpace: 'nowrap' });
                    const amount = document.createElement('span');
                    amount.style.flex = 'none';
                    amount.textContent = site.price(it.itemPrice.toLocaleString(), '');
                    const via = document.createElement('span');
                    // 幅0から伸ばす（見出しの長さで、価格に要る最小幅が広がらないように）
                    Object.assign(via.style, { flex: '1 1 auto', width: '0', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' });
                    // 送料の区分（楽天は送料込み/送料別、Yahoo!は送料無料/条件付き送料無料。金額は検索APIに無い）
                    const ship = it.postageFlag === 0 || it.shippingCode === 2 ? tr('送料無料')
                        : it.postageFlag === 1 ? tr('送料別') : it.shippingCode === 3 ? tr('条件付き送料無料') : '';
                    via.textContent = ship ? `${tag}・${ship}` : tag;
                    pr.append(amount, via);
                    const nm = document.createElement('div');
                    Object.assign(nm.style, { display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' });
                    nm.textContent = displayName(it.itemName);
                    nm.title = `${it.itemName}\n${it.shopName}`;
                    body.append(pr, nm);
                } else {
                    body.textContent = r.none || tr('一致する商品が見つかりませんでした{via}', { via: tag });
                    Object.assign(body.style, { display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical' });
                    if (apiError) body.title = site.apiError(apiError);
                }
                box.appendChild(body);
                row.appendChild(box);
                if (r.kw) {
                    row.appendChild(link(searchUrl(r.kw), tr('{t}検索', { t: r.label }), {
                        color: site.color, background: '#fff', border: `1px solid ${site.color}`, padding: '6px 10px',
                        fontSize: '12px', flex: '0 1 auto', minWidth: 'calc(3em + 20px)', lineHeight: '1.3', textAlign: 'center'
                    }));
                }
                wrap.appendChild(row);
            }
            const note = site.disclosure();
            note.append(AZR.settingsLink()); // 注記の行の右に添える
            wrap.appendChild(note);

            site.place(wrap);
        };

        const rebuild = () => { document.getElementById(site.id)?.remove(); createBtn(); };
        createBtn();   // 検索中の枠を先に出す
        resolveKeyword().then(() => {
            phase = 'title';
            rebuild();
            resolveTitleTop().then(() => { phase = 'done'; rebuild(); });
            if (site.checkShops) verifyBest();
            keepPlaced(site.id, createBtn);
        });
    };

    /*
     * Amazonはページの一部を描き直すことがあり（選択肢の切り替えなど）、置いた欄ごと消える。消えたら置き直す。
     * 楽天・Yahoo!の2つの欄を1つの見張りで見る。Amazonのページは変化が非常に多いので、変化のたびには何もせず、
     * 自分の欄が消えているときだけ、描き直しが落ち着くよう少し待ってから置き直す。
     */
    const keepers = new Map(); // 欄のid → 置き直す関数
    let keepTimer = null;
    let keepObserver = null;
    function keepPlaced(id, place) {
        keepers.set(id, place);
        if (keepObserver) return;
        keepObserver = new MutationObserver(() => {
            if (keepTimer) return;
            for (const key of keepers.keys()) {
                if (document.getElementById(key)) continue;
                keepTimer = setTimeout(() => {
                    keepTimer = null;
                    for (const fn of keepers.values()) fn(); // 置いてあるものは createBtn がそのまま返す
                }, 500);
                return;
            }
        });
        keepObserver.observe(document.body, { childList: true, subtree: true });
    }

    if (AZR.settings.rakutenLink) runSite(RAKUTEN);
    if (AZR.settings.amazonPageYahoo) runSite(YAHOO);
})();
