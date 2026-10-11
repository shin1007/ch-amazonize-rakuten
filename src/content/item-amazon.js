/* Amazonize Rakuten - この商品はAmazonではいくらか
 *
 * 楽天の価格の下に、Amazonの同じ商品の価格を並べる。探すのは service worker
 * （Amazonの検索結果を1枚読む。JAN（無ければ商品名・説明から拾った型番）と、商品名から宣伝を落とした語の両方で引き、2行で並べる）。
 * Yahoo!ショッピングも同じ引き方・同じ見た目で、Amazonの欄の下に並べる（こちらは中継Worker経由の公式API）。
 *
 * 突き合わせを外すことはあるので、当てた商品名・評価・検索結果へのリンクを必ず一緒に出し、
 * 本人が「これは違う」と分かるようにする。楽天のポイント還元は考えに入れていないので、
 * 値差はあくまで表示価格どうしの比較として出す。
 *
 * 楽天側は、上の価格欄と同じ「クーポン適用後の価格」で比べる（item.js の AZR.itemPricing）。
 * 欄に 1,180円 と出ているのに 1,680円 で比べては、同じ画面の中で数字が食い違う。
 * クーポンは後から増えるので、適用後の価格が変わったら値差も出し直す。
 */
(() => {
  const AZR = window.AZR;
  const tr = AZR.t;
  const { h, yen } = AZR;

  // 見出し（「同じJANコードの商品」か「似た商品」か）の判断は amazon-match.js にある
  const { matchLabel } = AZR.amazon;

  /*
   * 並べる店。Yahoo!ショッピングも同じ形の結果（service worker の yahooPrice）を返すので、同じ描き方で並べる。
   * Amazonのリンクは開発者のアソシエイトのタグ付き（中継ページ経由）、Yahoo!ショッピングのリンクは
   * バリューコマースのリンク。その旨を小さく添える。Yahoo!のAPIを使う画面には、規約どおりクレジットを出す。
   */
  const SITES = {
    amazon: {
      key: 'amazon', name: 'Amazon', label: 'amazon', type: 'azr:amazonPrice', setting: 'amazonPrice',
      loading: () => tr('Amazonの商品情報を取得中…'),
      searchTitle: () => tr('この検索語でAmazonを検索します（上の商品が上位に出るとは限りません）'),
      disclosure: () => h('div.azr-amazon-pr', { text: tr('※ Amazonアソシエイトのリンクを含みます') }),
      messages: () => ({
        none: tr('Amazonでは見つかりませんでした'),
        // 検索結果が空で返った（読み直しても空）。無いとは限らないので、そう言い切らない。
        empty: tr('Amazonの検索結果を読めませんでした'),
        blocked: tr('Amazonが応答しませんでした'),
        error: tr('Amazonの価格を調べられませんでした')
      })
    },
    yahoo: {
      key: 'yahoo', name: 'Yahoo!ショッピング', label: 'Yahoo!', type: 'azr:yahooPrice', setting: 'yahooPrice',
      loading: () => tr('Yahoo!ショッピングの商品情報を取得中…'),
      searchTitle: () => tr('この検索語でYahoo!ショッピングを検索します（上の商品が上位に出るとは限りません）'),
      disclosure: () => h('div.azr-amazon-pr', tr('※ バリューコマースのリンクを含みます') + ' ',
        // クレジットの文言・リンク先は Yahoo! JAPAN の指定どおり（変えない）
        h('a.azr-yahoo-credit', { href: 'https://developer.yahoo.co.jp/sitemap/', target: '_blank', rel: 'noopener noreferrer', text: 'Webサービス by Yahoo! JAPAN' })),
      messages: () => ({
        none: tr('Yahoo!ショッピングでは見つかりませんでした'),
        error: tr('Yahoo!ショッピングの価格を調べられませんでした')
      })
    },
    // Yahoo!ショッピングの商品ページ（yahoo-item.js）で使う。リンクは開発者のアフィリエイトID付き
    rakuten: {
      key: 'rakuten', name: '楽天', label: '楽天', type: 'azr:rakutenPrice',
      loading: () => tr('楽天の商品情報を取得中…'),
      searchTitle: () => tr('この検索語で楽天市場を検索します（上の商品が上位に出るとは限りません）'),
      disclosure: () => h('div.azr-amazon-pr', { text: tr('※ 楽天アフィリエイトのリンクを含みます') }),
      messages: () => ({
        none: tr('楽天では見つかりませんでした'),
        error: tr('楽天の価格を調べられませんでした')
      })
    }
  };

  /*
   * 比べる元の店（いま開いている商品ページの店）。楽天は上の価格欄と同じ「クーポン適用後の価格」で比べる。
   * Yahoo!ショッピングは表示されている価格のまま比べる。
   */
  const HOMES = {
    rakuten: {
      key: 'rakuten', name: '楽天',
      pricing: () => AZR.itemPricing?.value || null,
      same: (applied) => tr('{applied}楽天と同じ価格', { applied }),
      range: (applied, lo, hi) => tr('{applied}楽天は選択によって {lo}〜{hi}', { applied, lo, hi }),
      note: () => tr('（表示価格の比較。楽天のポイント還元は含みません）')
    },
    yahoo: {
      key: 'yahoo', name: 'Yahoo!ショッピング',
      pricing: () => null,
      same: () => tr('Yahoo!ショッピングと同じ価格'),
      range: (applied, lo, hi) => tr('Yahoo!ショッピングは選択によって {lo}〜{hi}', { lo, hi }),
      note: () => tr('（表示価格の比較。ポイント還元は含みません）')
    }
  };

  const note = (text) => h('div.azr-amazon-diff', h('span.azr-amazon-note', { text }));

  /**
   * 楽天の価格との差。ポイントは含まない、表示価格どうしの比較。
   *
   * **同じ商品だと言い切れないときは、差を出さない。** 楽天24の「温泡 5個セット（20錠×5個入）4,880円」に
   * Amazonの「温泡 こだわりローズ 20錠入×2 1,198円」が当たり、「Amazonが3,682円安い」と出た。
   * 中身の量が5倍違う別の商品で、この一行だけが独り歩きすると嘘になる。両方の値段は並べて出ているので、
   * 見比べるのは本人に任せる。
   *
   * 選択肢で値段が変わる商品（1,540円〜3,300円）も、どの選択肢と突き合わせたのか決められないので
   * 差は出さない。ただし楽天側の幅は事実なので添える（Amazonの値段と並べて本人が見比べられる）。
   */
  function diffLine(site, data, amazon, sure, home) {
    // 使えるクーポンがあれば適用後の価格で比べる（条件を満たさないクーポンは効いていない）
    const pricing = home.pricing();
    const rakuten = pricing ? pricing.min : data.minPrice;
    const high = pricing ? pricing.max : (data.maxPrice > data.minPrice ? data.maxPrice : null);
    const applied = pricing ? tr('クーポン適用後、') : '';
    if (!(rakuten > 0) || !(amazon > 0)) return '';
    if (high > rakuten) return note(home.range(applied, yen(rakuten), yen(high)));
    if (!sure) return note(tr('同じ商品とは限らないので、値段は比べていません'));
    const d = Math.abs(rakuten - amazon);
    if (d === 0) return h('div.azr-amazon-diff.same', { text: home.same(applied) });
    const cheaper = amazon < rakuten ? site.key : home.key;
    return h('div.azr-amazon-diff', { 'data-cheaper': cheaper },
      h('strong', { text: tr('{who}が{d}安い', { who: tr(cheaper === home.key ? home.name : site.name), d: yen(d) }) }),
      h('span.azr-amazon-note', {
        text: pricing
          ? tr('（楽天はクーポン適用後の価格。ポイント還元は含みません）')
          : home.note()
      })
    );
  }

  /*
   * 楽天→Amazon の見た目は、Amazon→楽天（amazon-link.js）と同じ。型番（JANがあればJAN）と商品名の2行を
   * 固定の高さで並べ、取得中も結果表示後も同じ高さにして、他の要素が動かないようにする。
   */
  const pulse = (el) => { try { el.animate([{ opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }], { duration: 1200, iterations: Infinity }); } catch {} };

  function itemRow(site, kind, r, code, data) {
    const label = kind === 'code' ? tr(code.type || '型番') : tr('商品名');
    if (r === undefined) return loadingRow(site);
    // 型番も JAN も取れない商品は、商品名の行だけが引ける
    if (r === null) return h('div.azr-amz-row.azr-amz-empty', { text: tr('この商品は型番・JANが取得できません') });

    const searchBtn = r.searchUrl
      ? h('a.azr-amz-search', { href: r.searchUrl, target: '_blank', rel: 'noopener noreferrer', text: tr('{t}検索', { t: label }),
          title: site.searchTitle() })
      : '';

    if (r.status === 'ok' && r.item) {
      const { sure, badge } = matchLabel({ byJan: r.byJan, byModel: r.byModel, score: r.item.score, variants: data.variants?.length || 0, pack: AZR.amazon.samePack(data.title, r.item.title) });
      const how = r.byJan ? tr('JANコード {jan} で検索した結果', { jan: data.jan })
        : r.byModel ? tr('型番「{q}」で検索した結果', { q: r.query })
        : tr('商品名「{q}」で検索した結果（商品名の一致度 {score}）', { q: r.query, score: r.item.score });
      const tag = badge === 'セット数が違う' ? tr(badge)
        : r.byModel || r.byJan ? tr(r.byModel ? '型番が一致' : badge) : sure ? label : `${label}・${tr('参考')}`;
      const meta = r.item.rating ? `★ ${r.item.rating.toFixed(1)}${r.item.count ? ` (${r.item.count.toLocaleString('ja-JP')})` : ''}` : '';
      return h('div.azr-amz-row', { 'data-state': 'ok' },
        h('a.azr-amazon-item.azr-amz-main', { href: r.item.url, target: '_blank', rel: 'noopener noreferrer', title: `${r.item.title}
${how}` },
          r.item.image ? h('img.azr-amz-thumb', { src: r.item.image, alt: '', loading: 'lazy' }) : h('span.azr-amz-thumb'),
          h('span.azr-amz-body',
            // 欄が狭いときは、価格は残して後ろの見出し・評価を…で切る
            h('span.azr-amz-price',
              h('span.azr-amz-amount', { text: `${site.label} ${r.item.price ? yen(r.item.price) : tr('価格不明')}` }),
              h('span.azr-amz-via', { text: ` (${tag})${meta ? '  ' + meta : ''}` })),
            h('span.azr-amz-name', { text: r.item.title })
          )
        ),
        searchBtn
      );
    }
    const messages = site.messages();
    const msg = (r.empty ? messages.empty : messages[r.status]) || messages.error;
    return h('div.azr-amz-row.azr-amz-empty', { 'data-state': r.status || 'error' }, h('span.azr-amz-main', { text: `${msg} (${label})` }), searchBtn);
  }

  function loadingRow(site) {
    const row = h('div.azr-amz-row.azr-amz-loading', { text: site.loading() });
    pulse(row);
    return row;
  }

  // results: { code: 型番/JANの結果, title: 商品名の結果 }。undefined は取得中、code が null は引く手がかりが無い
  function paint(site, box, results, data, code, home) {
    const done = Object.values(results).every((r) => r !== undefined);
    box.dataset.state = done ? (results.code?.status === 'ok' || results.title?.status === 'ok' ? 'ok' : (results.title?.status || 'error')) : 'loading';

    // 値差は、当たりの確かな方（型番/JAN → 商品名の順）で1つだけ出す
    const pick = [results.code, results.title].find((r) => r?.status === 'ok' && r.item);
    let diff = '';
    if (pick) {
      const { sure } = matchLabel({ byJan: pick.byJan, byModel: pick.byModel, score: pick.item.score, variants: data.variants?.length || 0, pack: AZR.amazon.samePack(data.title, pick.item.title) });
      diff = diffLine(site, data, pick.item.price, sure, home);
    }
    box.replaceChildren(
      itemRow(site, 'code', results.code, code, data),
      itemRow(site, 'title', results.title, code, data),
      h('div.azr-amz-diff-slot', diff),   // 値差の1行ぶんは最初から確保する
      site.disclosure()
    );
  }

  // Yahoo!ショッピングの商品ページ（yahoo-item.js）は boot.js を読まないので、register が無い
  AZR.register?.('item', 'item-amazon', async () => {
    const sites = [SITES.amazon, SITES.yahoo].filter((site) => AZR.settings[site.setting]);
    const anchor = document.querySelector('.azr-item-root .azr-price-block');
    if (!sites.length || !AZR.itemData?.title || !anchor) return;
    await mount(anchor, AZR.itemData, sites, HOMES.rakuten).done;
  });

  /**
   * anchor の下に、店ごとの欄を sites の順に積む。data は { title, minPrice, maxPrice, jan, variants, descriptionHtml }。
   * 返すのは置いた欄（ページに描き直されて外れたら、呼んだ側が置き直す）と、結果がそろうと解決する done、
   * data の価格を書き換えたあとに値差を出し直す repaint。
   */
  function mount(anchor, data, sites, home) {
    // 引く手がかり: JANがあればJAN、無ければ商品名や説明から拾った型番
    const model = AZR.amazon.isJan(data.jan) ? '' : AZR.amazon.extractModel(data.title, data.descriptionHtml || []);
    const code = AZR.amazon.isJan(data.jan) ? { type: 'JAN' } : model ? { type: '型番' } : { type: '' };

    // 店ごとに欄を1つ。価格の下に sites の順で積む
    const boxes = sites.map((site) => h('section.azr-amazon', { 'data-state': 'loading', 'data-site': site.key, 'data-home': home.key }));
    anchor.after(...boxes);
    const repaints = [];
    const done = Promise.all(sites.map((site, i) => lookup(site, boxes[i], data, code, model, home, repaints)));
    return { boxes, done, repaint: () => repaints.forEach((f) => f()) };
  }
  AZR.priceCompare = { SITES, HOMES, mount };

  async function lookup(site, box, data, code, model, home, repaints = []) {
    const results = { code: code.type ? undefined : null, title: undefined };
    paint(site, box, results, data, code, home);
    repaints.push(() => paint(site, box, results, data, code, home));

    const ask = async (msg) => {
      try {
        return (await chrome.runtime.sendMessage({ type: site.type, title: data.title, ...msg })) || { status: 'error' };
      } catch (e) {
        AZR.warn(`${site.name}の価格の問い合わせに失敗:`, e);
        return { status: 'error' };
      }
    };
    const settle = (key, res) => {
      AZR.log(site.key, key, res);
      results[key] = res;
      // ページから外れていても描いておく（Yahoo!ショッピングでは、ページの描き直しで外れた欄を yahoo-item.js が置き直す）
      paint(site, box, results, data, code, home);
    };
    await Promise.all([
      code.type ? ask({ jan: data.jan || '', model }).then((r) => settle('code', r)) : null,
      ask({ jan: '', model: '' }).then((r) => settle('title', r))
    ]);
    if (!box.isConnected) return; // 待つあいだに元のページへ戻した
    document.documentElement.dataset[`azr${site.key[0].toUpperCase()}${site.key.slice(1)}`] = box.dataset.state; // 検証用の目印

    // クーポンは後から増える（フローティングの応答・内容の確認）。適用後の価格が変わったら値差を出し直す。
    AZR.itemPricing?.watchers.push(() => {
      if (box.isConnected) paint(site, box, results, data, code, home);
    });
  }
})();
