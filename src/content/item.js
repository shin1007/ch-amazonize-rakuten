/* Amazonize Rakuten - 商品ページをAmazon風に再構成
 *
 * 楽天の商品ページは #item-page-app-data に商品データ一式をJSONで埋め込んでいる。
 * DOMを漁るより桁違いに安定するので、そちらを第一の情報源とし、
 * 取れなかった項目だけDOMから拾う。
 *
 * 購入エリア（#rakutenLimitedId_aroundCart）はReactが描画しているが、
 * 別の場所へ移設してもクリックハンドラは生きたままであることを実機で確認済み。
 * したがって複製ではなく移設する。
 *
 * このファイルは商品データの読み取りと、レイアウトの組み立て・移設を受け持つ。
 * 部品は別ファイル（manifest でこのファイルより先に読む）:
 *   item-images.js   楽天の画像URLの扱いと、説明の画像の選り分け
 *   item-gallery.js  左ペインのギャラリーと拡大表示
 *   item-coupons.js  クーポンを拾う・その場で獲得する・自動で獲得する
 */
(() => {
  const AZR = window.AZR;
  const tr = AZR.t;
  const { pick, pickAll, h, waitFor, parseYen, yen } = AZR;
  const {
    imageAt, isPlaceholder, galleryItem, takeCandidates, restore, sortDescriptionImages, isEmptyDescription
  } = AZR.itemImages;
  const { buildGallery } = AZR.itemGallery;
  const { harvestCoupons, couponKey, buildCoupons, fromFloating, affectsPrice, setGrabContext } = AZR.itemCoupons;

  const SEL = {
    // 実ページで確認したID。ハッシュ付きクラス名より安定している。
    buybox: ['#rakutenLimitedId_aroundCart'],
    nameArea: ['#item-name-area'],
    price: ['#itemPrice', '[class*="item-price--"]', '[class*="price--"]'],
    // 店舗のクーポンバナーは「販売説明文」(.sale_desc) の中にある。商品説明だけでは取りこぼす。
    descriptions: '.sale_desc, .item_desc, #item_desc, [class*="ItemDescription"]',
    // 商品レビューに限る。店舗ヘッダーのショップレビュー（/shop/）を拾うと、店舗の評価を商品の評価として出してしまう。
    reviewLink: ['a[href*="review.rakuten.co.jp/item/"]']
  };

  /** 楽天が埋め込む商品データJSON。ページの心臓部。 */
  function readAppData() {
    const el = document.getElementById('item-page-app-data');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      AZR.warn('item-page-app-data の解析に失敗:', e);
      return null;
    }
  }

  function fromAppData(app) {
    const sku = app?.api?.data?.itemInfoSku ?? app?.newApi?.itemInfoSku;
    if (!sku) return null;

    const priceInfo = sku.purchaseInfo?.purchaseBySellType?.normalPurchase?.price;
    const images = (sku.media?.images ?? sku.pcFields?.images ?? [])
      .map((im) => (typeof im === 'string' ? im : im.location))
      .filter(Boolean);

    return {
      // 商品名に <br> を入れる店舗がある（textContent で出すので、そのまま文字で見えてしまう）
      title: (sku.title || '').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim(),
      minPrice: priceInfo?.minPrice ?? null,
      maxPrice: priceInfo?.maxPrice ?? null,
      // フローティングクーポンの問い合わせに使う（定期購入の無い商品では定期購入専用クーポンを除く）
      // 楽天のバンドルと同じく、空のオブジェクトは「無い」とみなす
      hasSubscription: Object.keys(sku.purchaseInfo?.purchaseBySellType?.subscriptionPurchase || {}).length > 0,
      images,
      video: videoFromAppData(sku),
      itemId: sku.itemId || null,
      shop: {
        id: sku.shopId || null,
        code: app.shop?.shopUrl || '',
        name: app.shop?.shopName || '',
        url: `https://www.rakuten.co.jp/${app.shop?.shopUrl || ''}/`
      },
      jan: janFromAppData(sku),
      // 送料込みなら0。送料別の金額は届け先で変わり、このデータには無いので分からない（null）
      shippingFee: sku.shipping?.postageIncluded === true ? 0 : null,
      variants: (sku.variantSelectors || []).map((v) => v.label).filter(Boolean),
      review: reviewFromAppData(sku),
      // 商品説明文 → 販売説明文 の順（元のページと同じ並び）
      descriptionHtml: [
        sku.pcFields?.productDescription || sku.newProductDescription,
        sku.salesDescription
      ].filter((s) => typeof s === 'string' && s.trim())
    };
  }

  /**
   * JANコード（articleNumber）。Amazonで同じ商品を引くのに使う。
   * SKUごとに入っていて、選んだSKUで別の商品になる。どのSKUでも同じ1つのときだけ使う
   * （容量違い・色違いが並ぶ商品では、いまどれを見ているのかをこの時点では決められない）。
   */
  function janFromAppData(sku) {
    const list = Array.isArray(sku?.sku) ? sku.sku : [];
    const codes = new Set(list.map((v) => v?.articleNumber?.value).filter(Boolean));
    if (codes.size === 1) return [...codes][0];
    return sku?.articleNumber?.value || null;
  }

  /**
   * 商品動画。JSONにあるのは静止画と縦横比だけで、プレーヤーは楽天の動画スクリプトが
   * 元のページの画像欄（.item-pc-movie-<番号>）に後から描く。それを移設して使う（mountVideo）。
   */
  function videoFromAppData(sku) {
    const p = sku?.video?.parameters;
    if (!p) return null;
    const [w, hgt] = String(p.aspectRatioStr || '').split(':').map(Number);
    return {
      still: p.stillUrl || p.thumbnailUrl || '',
      name: p.name || '',
      ratio: w > 0 && hgt > 0 ? `${w} / ${hgt}` : '16 / 9'
    };
  }

  /** レビューの件数・評価もJSONに入っている。DOMから数字を拾うより確実。 */
  function reviewFromAppData(sku) {
    const summary = sku?.itemReviewInfo?.summary;
    if (!summary) return null;
    const count = Number.isFinite(summary.itemReviewCount) ? summary.itemReviewCount : null;
    // float32で埋め込まれるので 4.699999809265137 のような値で来る
    const raw = summary.itemReviewRating;
    const score = Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) / 100 : null;
    if (!count && !score) return null;
    return {
      href: sku.shopId && sku.itemId
        ? `https://review.rakuten.co.jp/item/1/${sku.shopId}_${sku.itemId}/1.1/`
        : null,
      count,
      score
    };
  }

  /** JSONが無い/欠けている場合のDOMフォールバック */
  function fromDom() {
    const nameArea = pick(document, SEL.nameArea);
    const priceEl = pick(document, SEL.price);
    const metaImages = Array.from(document.querySelectorAll('meta[itemprop="image"]'))
      .map((m) => m.content).filter(Boolean);
    const code = location.pathname.split('/').filter(Boolean)[0] || '';

    return {
      title: nameArea?.textContent?.trim()
        || document.querySelector('meta[itemprop="name"]')?.content
        || document.title.replace(/^【楽天市場】/, '').split('：')[0].trim(),
      minPrice: parseYen(priceEl?.textContent)
        || parseYen(document.querySelector('[itemprop="price"]')?.getAttribute('content')),
      maxPrice: null,
      images: metaImages,
      video: null,
      itemId: null,
      jan: null,
      shop: { id: null, code, name: code, url: `https://www.rakuten.co.jp/${code}/` },
      variants: [],
      review: null,
      descriptionHtml: []
    };
  }

  function harvestReview() {
    // 「レビューを書く」等ではなく、件数が書かれたリンクを選ぶ
    const links = pickAll(document, SEL.reviewLink);
    const link = links.find((a) => /\d+\s*件/.test(a.textContent || '')) || links[0];
    if (!link) return null;
    const text = (link.textContent || '').replace(/[,，\s]/g, '');
    const count = text.match(/(\d+)件/);
    // 評価点はレビューリンク周辺の「4.52」形式を探す
    const near = (link.closest('div, td, section')?.textContent || '').replace(/\s+/g, ' ');
    const score = near.match(/([0-5]\.\d{1,2})/);
    return {
      href: link.href,
      count: count ? Number(count[1]) : null,
      score: score ? Number(score[1]) : null
    };
  }

  /** 件数・評価はJSONを優先し、リンク先だけは実物のhrefを優先する。 */
  function mergeReview(fromJson, fromLink) {
    if (!fromJson && !fromLink) return null;
    const merged = {
      href: fromLink?.href || fromJson?.href || null,
      count: fromJson?.count ?? fromLink?.count ?? null,
      score: fromJson?.score ?? fromLink?.score ?? null
    };
    return merged.href || merged.count || merged.score ? merged : null;
  }

  /**
   * 商品説明文と販売説明文。どちらも店舗が自由に書くHTML。
   *
   * DOMの .sale_desc / .item_desc からは取らない。店舗のHTMLには
   * 「閉じタグ」（楽天のテンプレートの span/td を先に閉じるもの）が入っていることがあり、
   * 中身の大半が入れ物の外へこぼれる。実際に .sale_desc には <style> しか残らず、
   * LPの画像17枚は隣の div にあった。JSONの文字列から組み立てれば、この崩れを受けない。
   * scriptは実行されないが、念のため取り除く。
   */
  function descriptionFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const s of doc.querySelectorAll('script')) s.remove();
    return h('div.azr-desc-part', Array.from(doc.body.childNodes));
  }

  /** 店舗が説明に貼った動画も勝手に再生させない（YouTube などの埋め込みは autoplay=1 を落とす） */
  function disarmAutoplay(root) {
    for (const m of root.querySelectorAll('video[autoplay], audio[autoplay]')) {
      m.removeAttribute('autoplay');
      m.pause();
      m.controls = true; // 自動再生まかせで操作バーを付けていないことがある
    }
    for (const f of root.querySelectorAll('iframe[src*="autoplay=1"]')) {
      f.setAttribute('src', f.getAttribute('src').replace(/([?&])autoplay=1/g, '$1autoplay=0'));
    }
  }

  /** JSONに説明が無いページ用。DOMのものを移設する。 */
  function harvestDescriptions() {
    const nodes = [];
    for (const el of document.querySelectorAll(SEL.descriptions)) {
      // 入れ子は親だけを移設する（同じ中身を二度出さない）
      if (nodes.some((n) => n.contains(el))) continue;
      nodes.push(el);
    }
    return nodes;
  }

  const priceLabel = (min, max) => (min && max && max !== min ? `${yen(min)}〜${yen(max)}` : yen(min));

  /**
   * クーポンを適用したあとの価格。
   * 条件（最低購入金額・個数・定期購入限定）を満たさないクーポンは、持っていても効かせない。
   * 使えるものが複数あるときは、いちばん安くなる1枚（楽天のクーポンは1店舗1枚しか使えない）。
   *
   * 価格に幅がある商品（SKUで値段が違う）は、安い方で選んだクーポンを高い方にも当てる。
   * 幅の両端で別のクーポンが最良になることはあるが、どちらか片方の名前しか出せない以上、
   * 「この1枚を使うと、いくらになるか」を通しで見せる方が読み違えにくい。
   */
  function couponPricing(data, coupons) {
    const best = AZR.coupons.itemPrice((coupons || []).filter(affectsPrice), data.minPrice);
    if (!best) return null;
    const high = data.maxPrice && data.maxPrice !== data.minPrice
      ? AZR.coupons.itemPrice([best.coupon], data.maxPrice)?.price ?? data.maxPrice
      : null;
    return { coupon: best.coupon, min: best.price, max: high };
  }

  /**
   * 今の「クーポン適用後の価格」。item-amazon.js が Amazon との値差に使う。
   * クーポンは後から（フローティングの応答・内容の確認で）増えたり内容が変わったりするので、
   * 今の値と、変わったときの知らせの両方を渡す。効くクーポンが無ければ value は null。
   */
  AZR.itemPricing = { value: null, watchers: [] };
  function publishPricing(pricing) {
    AZR.itemPricing.value = pricing;
    for (const cb of AZR.itemPricing.watchers) {
      try {
        cb(pricing);
      } catch (e) {
        AZR.warn('価格の変化を受け取る側で失敗:', e);
      }
    }
  }

  /** 価格の行。クーポンが効くときは、適用後を主役にして元の価格に取り消し線を引く。 */
  function priceNodes(data, pricing, nowSpec) {
    if (!pricing) return [h(nowSpec, { text: priceLabel(data.minPrice, data.maxPrice) })];
    return [
      h(nowSpec, { text: priceLabel(pricing.min, pricing.max) }),
      h('span.azr-price-was', { text: priceLabel(data.minPrice, data.maxPrice) }),
      h('span.azr-price-note', { text: tr('クーポン適用後'), title: pricing.coupon.label })
    ];
  }

  /** 4.7 なら星5つ分の94%を塗る。四捨五入せず半端な点も見た目に出す。 */
  function stars(score) {
    if (!score) return null;
    const pct = Math.max(0, Math.min(100, (score / 5) * 100));
    return h('span.azr-stars', { title: tr('5段階評価で {score}', { score: score.toFixed(2) }) },
      h('span.azr-stars-fill', { style: { width: `${pct}%` }, text: '★★★★★' })
    );
  }

  /*
   * 右ペインのショップ欄。店舗は決まった場所にロゴを2種類置いている（楽天自身もここを読む）。
   *   /<店>/logo/logo1.jpg  正方形のアイコン（960x960）
   *   /<店>/logo/logo2.jpg  横長のロゴ（960x160）
   * 無い店舗は 404 になるので、読めなかったものは消して店舗名の文字で代える。
   */
  const shopLogoUrl = (code, n) => `https://tshop.r10s.jp/${code}/logo/logo${n}.jpg`;
  const shopReviewUrl = (id) => `https://review.rakuten.co.jp/shop/4/${id}_${id}/1.1/`;

  function loadOrDrop(img, url, px, onFail) {
    img.onerror = () => {
      img.onerror = img.onload = null;
      img.remove();
      onFail?.();
    };
    img.onload = () => { if (isPlaceholder(img)) img.onerror(); };
    img.src = imageAt(url, px);
  }

  /**
   * 商品の評価点とショップの評価は、商品ページのどこにも無い（JSONは件数だけ）。
   * service worker に商品レビューのページから両方まとめて取ってもらう。
   */
  async function fetchRatings(data) {
    if (!data.shop.id) return null;
    try {
      return await chrome.runtime.sendMessage({ type: 'azr:reviewRatings', shopId: data.shop.id, itemId: data.itemId });
    } catch (e) {
      AZR.warn('評価の取得に失敗:', e);
      return null;
    }
  }

  function fillShopRating(link, r) {
    if (!r?.score) return;
    link.append(
      h('span.azr-shop-rating-label', { text: tr('ショップ評価') }),
      stars(r.score),
      h('span.azr-score', { text: r.score.toFixed(2) }),
      r.count ? h('span.azr-count', { text: `(${r.count.toLocaleString(AZR.numberLocale)})` }) : ''
    );
    link.hidden = false;
  }

  /** 商品名の下の評価。レビューのページの点が正なので、ページから拾った点があっても差し替える。 */
  function fillItemRating(link, r) {
    if (!link || !r?.score) return;
    for (const el of link.querySelectorAll('.azr-stars, .azr-score')) el.remove();
    link.prepend(stars(r.score), h('span.azr-score', { text: r.score.toFixed(2) }));
    // JSONの件数が無いページでも、件数は出す
    if (!link.querySelector('.azr-count') && r.count) {
      link.append(h('span.azr-count', { text: tr('{count}件のレビュー', { count: r.count.toLocaleString(AZR.numberLocale) }) }));
    }
  }

  function buildShopCard(shop) {
    const name = h('span.azr-shop-card-name', { text: shop.name, hidden: 'hidden' });
    const icon = h('img.azr-shop-icon', { alt: '' });
    const logo = h('img.azr-shop-logo', { alt: shop.name });
    const rating = h('a.azr-shop-rating', {
      href: shop.id ? shopReviewUrl(shop.id) : null,
      target: '_blank',
      rel: 'noopener',
      title: tr('ショップレビューを見る'),
      hidden: 'hidden'
    });
    const card = h('div.azr-shop-card',
      // アイコンとロゴは同じ行き先。読み上げでは1つのリンクに見えるよう、アイコン側は隠す。
      h('a.azr-shop-icon-link', { href: shop.url, tabindex: '-1', 'aria-hidden': 'true' }, icon),
      h('a.azr-shop-card-main', { href: shop.url, title: tr('{name} のトップへ', { name: shop.name }) }, logo, name),
      rating
    );

    if (shop.code) {
      loadOrDrop(icon, shopLogoUrl(shop.code, 1), 96, () => card.classList.add('no-icon'));
      loadOrDrop(logo, shopLogoUrl(shop.code, 2), 600, () => { name.hidden = false; });
    } else {
      icon.remove();
      logo.remove();
      card.classList.add('no-icon');
      name.hidden = false;
    }
    return card;
  }

  function buildLayout(data, gallery) {
    const info = h('div.azr-info',
      h('h1.azr-title', { text: data.title }),
      h('a.azr-shop', { href: data.shop.url, text: data.shop.name }),
      data.review && h('a.azr-review', { href: data.review.href, target: '_blank', rel: 'noopener' },
        stars(data.review.score),
        data.review.score ? h('span.azr-score', { text: data.review.score.toFixed(2) }) : '',
        data.review.count ? h('span.azr-count', { text: tr('{count}件のレビュー', { count: data.review.count.toLocaleString(AZR.numberLocale) }) }) : ''
      ),
      // 価格とクーポンは、拾い直しやAPIの応答のたびに出し直す（paintCoupons）
      h('div.azr-price-block'),
      h('div.azr-coupons-slot'),
      data.variants.length ? h('div.azr-variants', {
        text: tr('選択項目: {v}（右のボックスで選択）', { v: data.variants.join(' / ') })
      }) : ''
    );

    const buybox = h('aside.azr-buybox',
      h('div.azr-buybox-price'),
      h('div.azr-buybox-slot', h('div.azr-buybox-loading', { text: tr('購入エリアを読み込み中…') }))
    );

    // 右ペインはショップ欄と購入ボックス。購入エリアはお届け先や販売期間まで入って縦に長く、
    // 下に置くと画面の外に沈むので、ショップ欄を上に置く
    const side = h('div.azr-side', buildShopCard(data.shop), buybox);

    // 商品説明は真ん中のペイン（商品情報）の末尾に置く
    if (data.descriptionNodes.length) {
      info.append(h('section.azr-detail',
        h('h2.azr-h2', { text: tr('商品説明') }),
        h('div.azr-detail-body')
      ));
    }

    return h('div.azr-item-root', { id: 'azr-item-root' },
      h('div.azr-grid', gallery.node, info, side),
      gallery.overlay
    );
  }

  /** 「Amazonized」の印。押すと元のページと切り替わる。 */
  const brandBadge = () => h('button.azr-brand', {
    type: 'button',
    title: tr('クリックで元のページと切り替え'),
    onclick: () => document.documentElement.classList.toggle('azr-simplified')
  }, h('span', { text: 'Amazon' }), 'ized');

  /**
   * ヘッダーは楽天市場の共通ヘッダー（.riShopHdrWrap）をそのまま使う。
   * 検索の候補や Language の吹き出しもこの中で完結しているので、移設せず元の場所で見せ、
   * 左端に印を足すだけにする（中の irc="Header" はReactが描くので触らない）。
   * 共通ヘッダーが無いページは、最低限の自前バーで代える。
   */
  function mountHeader(root) {
    const header = document.querySelector('body > .riShopHdrWrap');
    if (header) {
      header.classList.add('azr-header');
      header.prepend(brandBadge());
      return;
    }
    root.prepend(h('div.azr-topbar',
      brandBadge(),
      h('span.azr-topbar-links',
        h('a', { href: 'https://www.rakuten.co.jp/', text: tr('楽天市場') }),
        h('a', { href: 'https://basket.step.rakuten.co.jp/rms/mall/bs/cartall/', text: tr('買い物かご') })
      )
    ));
  }

  /** 説明の画像を選り分け、移すものをギャラリーへ足す。終わったら印を付ける（検証用の目印にもなる）。 */
  async function moveDescriptionImages(root, gallery, candidates) {
    try {
      const { moved, dropped, left } = await sortDescriptionImages(gallery.items, candidates);
      gallery.add(moved);
      const detail = root.querySelector('.azr-detail');
      if (detail && isEmptyDescription(detail.querySelector('.azr-detail-body'))) detail.hidden = true;
      AZR.log('gallery', JSON.stringify({ moved: moved.length, dropped, left }));
    } catch (e) {
      // 途中で落ちても、隠したままの画像を説明に戻す
      AZR.warn('説明の画像の整理に失敗:', e);
      for (const c of candidates) if (c.img.classList.contains('azr-desc-pending')) restore(c.img);
    }
    document.documentElement.dataset.azrGallery = 'settled';
  }

  /**
   * 楽天の動画プレーヤーを動画の枠へ移設する。プレーヤーは楽天の動画スクリプトが
   * 元のページの画像欄（.item-pc-movie-<番号>）に後から描く。購入エリアと同じく、
   * 移設しても再生ボタンや操作バーは動く。勝手に再生させないのは video-guard.js の役目。
   * 元のページに戻すときのために、元の位置に印を残して moved に積む。
   */
  const VIDEO_WAIT_MS = 15000;

  async function mountVideo(slot, moved) {
    await AZR.domReady;
    const player = await waitFor(
      () => document.querySelector('[class*="item-pc-movie-"]:has(video)'),
      { timeout: VIDEO_WAIT_MS }
    );
    if (!slot.isConnected) return; // 待つあいだに元のページへ戻した
    AZR.health.check('item.video', player, '[class*="item-pc-movie-"] の video が出てこない');
    if (!player) {
      slot.querySelector('.azr-gallery-video-status').textContent = tr('動画を読み込めませんでした');
      document.documentElement.dataset.azrVideo = 'failed'; // 検証用の目印
      return;
    }
    const mark = document.createComment('azr-video');
    player.replaceWith(mark);
    moved.push([mark, player]);
    slot.replaceChildren(player);
    document.documentElement.dataset.azrVideo = 'mounted';
  }

  /**
   * 購入エリアの枠（#rakutenLimitedId_aroundCart）はHTMLに入っていて、
   * 中の irc="Quantity" / irc="AddToCartPurchaseButtonFixed" などにReactのバンドルが後から描き込む。
   * 再構成はバンドルより先に始まるので、枠を先に移設しておき、中身はその場で描かれるのに任せる。
   * 枠が無いページ（形が変わった等）は元のページに戻す。いつまでも「読み込み中」にしないよう、
   * バンドルが走り終わって（DOMContentLoaded）から少し待って、それでも無ければ諦める。
   */
  const BUYBOX_GRACE_MS = 3000;

  async function mountBuybox(root, revert) {
    let buyboxNode = pick(document, SEL.buybox);
    if (!buyboxNode) {
      await AZR.domReady;
      buyboxNode = await waitFor(() => pick(document, SEL.buybox), { timeout: BUYBOX_GRACE_MS });
    }
    AZR.health.check('item.buybox', buyboxNode, `${SEL.buybox.join(', ')} が無い`);
    if (!buyboxNode) {
      AZR.warn('購入エリアが見つからないため、元のページに戻します');
      return revert();
    }
    // 複製ではなく移設する。Reactのハンドラは移設後も動くことを確認済み。
    const slot = root.querySelector('.azr-buybox-slot');
    slot.replaceChildren(buyboxNode);
    document.documentElement.dataset.azrBuybox = 'mounted'; // 検証用の目印
  }

  AZR.register('item', 'item-simplify', async () => {
    if (!AZR.settings.simplifyItem) return;

    const app = readAppData();
    const fromJson = fromAppData(app);
    AZR.health.check('item.appData', fromJson, app ? 'JSONに itemInfoSku が無い（形が変わった）' : '#item-page-app-data が無い');
    const base = fromJson || fromDom();
    // JSONで欠けた項目はDOMで補う
    if (!base.title || !base.minPrice || !base.images.length) {
      const dom = fromDom();
      base.title = base.title || dom.title;
      base.minPrice = base.minPrice || dom.minPrice;
      if (!base.images.length) base.images = dom.images;
      if (!base.shop.name) base.shop = dom.shop;
    }

    const data = {
      ...base,
      review: mergeReview(base.review, harvestReview()),
      coupons: AZR.settings.couponList ? harvestCoupons() : [],
      descriptionNodes: base.descriptionHtml.length
        ? base.descriptionHtml.map(descriptionFromHtml)
        : harvestDescriptions()
    };
    // 商品ページの他のモジュール（item-amazon.js）はここから読む
    AZR.itemData = data;
    AZR.log('harvested', data);

    AZR.health.check('item.titlePrice', data.title && data.minPrice, { title: Boolean(data.title), price: Boolean(data.minPrice) });
    if (!data.title || !data.minPrice) {
      AZR.warn('商品名か価格を取得できないため、元のページを表示します');
      return AZR.unhide();
    }

    setGrabContext({ shop: data.shop.name || '', item: data.title, url: location.origin + location.pathname });

    const items = data.images.filter(Boolean).map(galleryItem);
    // 動画は1枚目の画像の隣に置く（後ろにすると、説明から足す数十枚に埋もれる）
    if (data.video?.still) {
      items.splice(Math.min(1, items.length), 0, { src: data.video.still, tall: false, video: data.video });
    }
    const gallery = buildGallery(items, data.title);
    // 説明に入れる前に、ギャラリーへ移す候補の読み込みを止めておく
    const candidates = takeCandidates(data.descriptionNodes);
    for (const node of data.descriptionNodes) disarmAutoplay(node);
    const root = buildLayout(data, gallery);

    /* 価格とクーポン欄は、フローティングクーポンの応答・Reactが描いた分の拾い直し・
     * クーポン内容の確認（refineCoupon）のたびに出し直す。最初の1回も同じ道を通る。 */
    let shownCoupons = data.coupons;
    const paintPrice = () => {
      const pricing = couponPricing(data, shownCoupons);
      root.querySelector('.azr-price-block').replaceChildren(...priceNodes(data, pricing, 'span.azr-price'));
      root.querySelector('.azr-buybox-price').replaceChildren(...priceNodes(data, pricing, 'span.azr-price-now'));
      publishPricing(pricing);
    };
    const paintCoupons = () => {
      root.querySelector('.azr-coupons-slot')
        .replaceChildren(shownCoupons.length ? buildCoupons(shownCoupons, { onChange: paintPrice }) : '');
      paintPrice();
    };
    paintCoupons();

    document.body.append(root);
    mountHeader(root);

    // DOMから移設する説明（JSONに説明が無いページ）は、元のページに戻すときのために元の位置を覚えておく
    const detailBody = root.querySelector('.azr-detail-body');
    const moved = [];
    for (const node of data.descriptionNodes) {
      if (node.parentNode) {
        const mark = document.createComment('azr-desc');
        node.replaceWith(mark);
        moved.push([mark, node]);
      }
      detailBody?.append(node);
    }

    document.documentElement.classList.add('azr-simplified');
    // 楽天の動画プレーヤーの自動再生を video-guard.js（MAINワールド）に止めさせる
    document.documentElement.setAttribute('data-azr-no-autoplay', '');
    AZR.unhide();

    mountBuybox(root, () => {
      for (const [mark, node] of moved) mark.replaceWith(node);
      document.documentElement.classList.remove('azr-simplified');
      document.documentElement.removeAttribute('data-azr-no-autoplay');
      document.querySelector('.azr-header > .azr-brand')?.remove();
      document.querySelector('.azr-header')?.classList.remove('azr-header');
      root.remove();
    });

    // 画像の選り分けは数十枚を読むので、購入エリアを描くバンドルの取得と帯域を取り合わないよう後に回す
    AZR.domReady.then(() => moveDescriptionImages(root, gallery, candidates));
    if (gallery.videoSlot) mountVideo(gallery.videoSlot, moved);

    if (AZR.settings.couponList) {
      // フローティングクーポン（元のページで右下に出る枠）を先頭に、ページから拾ったものを後ろに並べる。
      // 同じクーポンへのリンクがページにもあれば、フローティングの方だけを残す。
      let floating = [];
      const mergeCoupons = () => {
        const taken = new Set(floating.map((c) => `getkey:${c.getKey}`));
        shownCoupons = [...floating, ...data.coupons.filter((c) => !c.href || !taken.has(couponKey(c.href)))];
        paintCoupons();
      };

      // 元のページと同じく、通常購入の価格で問い合わせる。ログインしていないと何も返らない。
      if (data.itemId && data.shop.id && data.minPrice) {
        chrome.runtime.sendMessage({
          type: 'azr:floatingCoupons',
          itemId: data.itemId,
          shopId: data.shop.id,
          price: data.minPrice,
          hasSubscription: data.hasSubscription
        }).then((r) => {
          AZR.log('floating coupons', r);
          if (!r?.coupons?.length) return;
          floating = r.coupons.map(fromFloating);
          mergeCoupons();
        }).catch((e) => AZR.warn('フローティングクーポンの問い合わせに失敗:', e));
      }

      // クーポンの一部（トピックス欄など）はReactが描くので、バンドルが走り終わってから拾い直す
      AZR.domReady.then(() => {
        const later = harvestCoupons();
        const keys = (list) => list.map((c) => c.href || c.label).join('\n');
        if (keys(later) === keys(data.coupons)) return;
        data.coupons = later;
        mergeCoupons();
      });
    }

    fetchRatings(data).then((r) => {
      if (data.shop.id) AZR.health.check('item.ratings', r, 'レビューのページから評価を取れない');
      fillItemRating(root.querySelector('.azr-review'), r?.item);
      fillShopRating(root.querySelector('.azr-shop-rating'), r?.shop);
      document.documentElement.dataset.azrRatings = 'settled'; // 検証用の目印
    });
  });
})();
