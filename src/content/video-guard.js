/*
 * Amazonize Rakuten - 商品動画の自動再生を止める（MAINワールドで動く）
 *
 * 商品動画のプレーヤー（stream.cms.rakuten.co.jp の動画スクリプト）は、
 * 画面に6割見えた時点・読み込み終わった時点・マウスを載せた時点に、自分で video.play() を呼ぶ。
 * ギャラリーに動画を並べると、選んだだけで再生が始まってしまう。
 *
 * そこで play() を差し替え、そのプレーヤーの中を押した直後（再生ボタンや操作バー）以外は
 * ブラウザが自動再生を拒んだときと同じ NotAllowedError で断る。プレーヤーはこの拒否を
 * 想定していて、再生ボタンを出したまま待つ。
 *
 * play() はページ側の関数なので、コンテンツスクリプト（分離ワールド）からは差し替えられない。
 * 止めるのは item.js が再構成したときだけ（<html data-azr-no-autoplay>）。
 *
 * 店によっては、動画を店のサイト（www.rakuten.ne.jp/gold/…）のページごと iframe で埋め込む。
 * その中にも入り、止めるかどうかは商品ページ（最上位）の上の印を postMessage で聞いて従う。
 * 答えが来るまでは止めておく（読み込み時の自動再生を通さないため）。
 */
(() => {
  const USER_GRACE_MS = 1000;
  const ITEM_ORIGIN = 'https://item.rakuten.co.jp';
  const MSG = 'azr:noAutoplay';
  const inFrame = window.top !== window;
  if (inFrame) {
    const ancestors = location.ancestorOrigins;
    if (!ancestors?.length || ancestors[ancestors.length - 1] !== ITEM_ORIGIN) return; // 商品ページの中だけ
  }

  let frameBlocked = true;
  const blocked = () => (inFrame ? frameBlocked : document.documentElement.hasAttribute('data-azr-no-autoplay'));

  if (inFrame) {
    window.addEventListener('message', (e) => {
      if (e.source !== window.top || e.origin !== ITEM_ORIGIN || e.data?.type !== MSG) return;
      frameBlocked = Boolean(e.data.on);
      // 印が付く前の答えで流れ始めていたら止める
      if (frameBlocked) for (const v of document.querySelectorAll('video')) if (!v.paused) v.pause();
    });
    window.top.postMessage({ type: MSG, ask: true }, ITEM_ORIGIN);
  } else {
    // 中の iframe に聞かれたら答え、印が変わったら全部の iframe に知らせる
    const tell = (win, origin = '*') => { try { win.postMessage({ type: MSG, on: blocked() }, origin); } catch { /* 閉じた枠 */ } };
    window.addEventListener('message', (e) => {
      if (e.data?.type === MSG && e.data.ask && e.source) tell(e.source, e.origin);
    });
    new MutationObserver(() => { for (let i = 0; i < window.frames.length; i++) tell(window.frames[i]); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-azr-no-autoplay'] });
  }
  let lastInput = { target: null, at: 0 };

  const note = (e) => {
    if (e.isTrusted) lastInput = { target: e.target, at: performance.now() };
  };
  window.addEventListener('pointerdown', note, true);
  window.addEventListener('keydown', note, true);

  /** そのプレーヤーの中を、いま押したところか */
  function pressedInside(media) {
    const { target, at } = lastInput;
    if (!(target instanceof Node) || performance.now() - at > USER_GRACE_MS) return false;
    const box = media.closest('.video-player') || media.parentElement || media;
    return box.contains(target);
  }

  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(...args) {
    try {
      if (blocked() && !pressedInside(this)) {
        return Promise.reject(new DOMException('Amazonize Rakuten: 自動再生を止めました', 'NotAllowedError'));
      }
    } catch { /* ページ側の再生は絶対に壊さない */ }
    return nativePlay.apply(this, args);
  };
})();
