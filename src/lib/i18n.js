/* Amazonize Rakuten - 表示文言の切り替え
 *
 * 文言は日本語の原文をそのままキーにして呼ぶ: AZR.t('かごの合計')。
 * 訳は i18n-data.js の AZR.messages[言語][原文]。無ければ原文（日本語）が出る。
 * 差し込みは {名前} で書く: AZR.t('{n}件', { n: 3 })。
 *
 * 言語は設定（language）で選べる。'auto' のときはブラウザの表示言語から選び、
 * 対応していない言語なら英語にする。設定を読み込んだ後に AZR.setLanguage を呼ぶ
 * （settings.js の loadSettings がやる）。それまでは自動選択の言語。
 * 訳は tools/translations/<言語>.json に置き、node tools/build-locales.mjs で i18n-data.js と _locales にする。
 *
 * i18n-data.js（全言語で約120KB）は content script には入れない。日本語なら訳は要らず、ほかの言語でも要るのは1言語分だけなので、
 * loadMessages が service worker から自分の言語の分（足りない文言は英語で埋めたもの）を受け取り、chrome.storage.local に覚えておく。
 * 次からは storage から読むだけで済む（拡張を更新したら版が変わるので取り直す）。
 * 表示言語の取得に失敗したとき（テストなど）は日本語のまま。
 */
(() => {
  const AZR = (window.AZR = window.AZR || {});
  if (AZR.t) return;

  // 設定に出す言語。名前は各言語での自称
  AZR.LANGUAGES = [
    ['ja', '日本語'], ['en', 'English'], ['zh_CN', '简体中文'], ['zh_TW', '繁體中文'],
    ['ko', '한국어'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia']
  ];

  /** ブラウザの表示言語 → 対応している言語 */
  function detect() {
    let ui = 'ja';
    try {
      ui = chrome.i18n.getUILanguage() || 'ja';
    } catch { /* chrome API が無い */ }
    const l = ui.toLowerCase().replace('_', '-');
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('zh')) return /^zh-(tw|hk|mo|hant)/.test(l) ? 'zh_TW' : 'zh_CN';
    if (l.startsWith('ko')) return 'ko';
    if (l.startsWith('vi')) return 'vi';
    if (l.startsWith('id') || l.startsWith('in')) return 'id';
    return 'en';
  }

  const NUMBER_LOCALE = { ja: 'ja-JP', en: 'en-US', zh_CN: 'zh-CN', zh_TW: 'zh-TW', ko: 'ko-KR', vi: 'vi-VN', id: 'id-ID' };

  AZR.setLanguage = (choice) => {
    const code = AZR.LANGUAGES.some(([c]) => c === choice) ? choice : detect();
    AZR.lang = code;
    AZR.isJa = code === 'ja';
    AZR.numberLocale = NUMBER_LOCALE[code];
    return code;
  };
  AZR.setLanguage('auto');

  /** 今の言語の訳をそろえる。content script の loadSettings が、設定を読んだ後に待つ */
  AZR.loadMessages = async () => {
    if (AZR.isJa || AZR.messages?.[AZR.lang]) return;
    const lang = AZR.lang;
    try {
      const key = `azrI18n:${lang}:${chrome.runtime.getManifest().version}`;
      let dict = (await chrome.storage.local.get(key))[key];
      if (!dict) dict = await chrome.runtime.sendMessage({ type: 'azr:messages', lang });
      if (dict && typeof dict === 'object') AZR.messages = { ...AZR.messages, [lang]: dict };
    } catch { /* 取れなければ日本語の原文のまま */ }
  };

  AZR.t = (ja, params) => {
    let s = ja;
    if (!AZR.isJa) s = AZR.messages?.[AZR.lang]?.[ja] ?? AZR.messages?.en?.[ja] ?? ja;
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? params[k] : m));
    return s;
  };
})();
