/* Amazonize Rakuten - ポップアップ設定 */

// 既定値は content script と同じ settings.js のものを使う（2か所に書くとずれる）
const AZR = window.AZR;
const { DEFAULTS } = AZR;
  const tr = AZR.t;

// 静的なHTMLの文言を、表示言語に合わせて置き換える（日本語なら何もしない）
function translateStatic() {
  if (AZR.isJa) return;
  document.documentElement.lang = AZR.lang;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.trim();
    if (text) n.nodeValue = n.nodeValue.replace(text, tr(text));
  }
  for (const el of document.querySelectorAll('[placeholder]')) {
    el.placeholder = el.placeholder.split('\n').map((line) => tr(line)).join('\n');
  }
}

const $ = (sel) => document.querySelector(sel);
const status = $('#status');

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  AZR.setLanguage(s.language);
  translateStatic();

  const langSelect = $('#language');
  langSelect.append(new Option(tr('自動（ブラウザの言語）'), 'auto'), ...AZR.LANGUAGES.map(([code, name]) => new Option(name, code)));
  langSelect.value = AZR.LANGUAGES.some(([code]) => code === s.language) ? s.language : 'auto';
  langSelect.addEventListener('change', async () => {
    await chrome.storage.sync.set({ language: langSelect.value });
    location.reload(); // 静的な文言は日本語の原文から置き直すので、開き直す
  });

  // 自動で行う操作は同意するまで動かない。まだなら、選ぶページへの案内を出す
  $('#consentNotice').hidden = Boolean(s.consentAt);

  $('#enabled').checked = s.enabled;
  $('#enabled').addEventListener('change', (e) =>
    chrome.storage.sync.set({ enabled: e.target.checked }));

  for (const input of document.querySelectorAll('input[data-key]')) {
    const key = input.dataset.key;
    input.checked = Boolean(s[key]);
    input.addEventListener('change', () =>
      chrome.storage.sync.set({ [key]: input.checked }));
  }

  const urls = $('#campaignUrls');
  urls.value = (s.campaignUrls || []).join('\n');
  urls.addEventListener('change', () => {
    const list = urls.value.split('\n').map((v) => v.trim()).filter(Boolean);
    chrome.storage.sync.set({ campaignUrls: list });
  });

  /* 獲得したクーポン ---------------------------------------------------------
   * 商品ページで獲得できたもの（自動・手動とも）。service worker が新たに獲得できたときだけ残す。 */

  async function renderAcquired() {
    const { azrAcquired: items = [] } = await chrome.storage.local.get('azrAcquired');
    const list = $('#acquiredList');
    list.textContent = '';
    $('#acquiredCount').textContent = items.length ? `(${items.length})` : '';

    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = tr('まだありません');
      list.append(li);
      return;
    }
    for (const c of items) {
      const li = document.createElement('li');
      li.className = 'campaign';

      const label = c.url ? document.createElement('a') : document.createElement('span');
      if (c.url) {
        label.href = c.url;
        label.target = '_blank';
      }
      label.textContent = c.name || tr('（名前なし）');
      label.title = [c.name, c.shop && tr('ショップ: {s}', { s: c.shop }), c.item && tr('商品: {i}', { i: c.item })].filter(Boolean).join('\n');

      const state = document.createElement('span');
      state.className = 'campaign-state';
      state.textContent = `${day(c.at)}${c.auto ? tr(' 自動') : ''}`;

      li.append(label, state);
      list.append(li);
    }
  }

  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(AZR.numberLocale, { month: 'numeric', day: 'numeric' }) : '');
  renderAcquired();

  /* サイト変化チェック（開発版だけ） ------------------------------------------
   * 各機能が報告した結果（service worker が azrHealth に書く）。失敗中の確認と未読の警告を上に出す。 */

  const when = (ms) => (ms ? new Date(ms).toLocaleString(AZR.numberLocale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

  function healthRow({ id, text, url, detail }) {
    const li = document.createElement('li');
    li.className = 'campaign';
    const label = document.createElement(url ? 'a' : 'span');
    if (url) { label.href = url; label.target = '_blank'; }
    label.textContent = AZR.health.label(id);
    label.title = [id, detail, url].filter(Boolean).join('\n');
    const state = document.createElement('span');
    state.className = 'campaign-state';
    state.textContent = text;
    li.append(label, state);
    return li;
  }

  async function renderHealth() {
    const { azrHealth: h = {} } = await chrome.storage.local.get('azrHealth');
    const checks = Object.entries(h.checks || {});
    const events = Object.entries(h.events || {});
    const failing = checks.filter(([, c]) => c.ok === false).sort(([, a], [, b]) => b.failAt - a.failAt);
    const unseen = events.filter(([, e]) => e.unseen > 0).sort(([, a], [, b]) => b.at - a.at);
    const ok = checks.filter(([, c]) => c.ok).sort(([a], [b]) => a.localeCompare(b));

    $('#healthSummary').textContent = failing.length || unseen.length
      ? `失敗中 ${failing.length}件 / 未読の警告 ${unseen.length}件（項目に載せるとURLと詳細が出ます）`
      : checks.length ? '問題は見つかっていません' : 'まだ記録がありません（楽天やAmazonのページを開くと記録されます）';
    $('#healthList').replaceChildren(
      ...failing.map(([id, c]) => healthRow({ id, url: c.url, detail: c.detail, text: `失敗 ${c.fails}回 ${when(c.since)}〜` })),
      ...unseen.map(([id, e]) => healthRow({ id, url: e.url, detail: e.detail, text: `${e.unseen}回 ${when(e.at)}` }))
    );
    $('#healthOkCount').textContent = `(${ok.length})`;
    $('#healthOkList').replaceChildren(...ok.map(([id, c]) => healthRow({ id, text: `OK ${when(c.okAt)}` })));
  }

  if (AZR.health.dev) {
    $('#health').hidden = false;
    renderHealth();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.azrHealth) renderHealth();
    });
    $('#healthSeen').addEventListener('click', async () => {
      const { azrHealth: h } = await chrome.storage.local.get('azrHealth');
      if (!h?.events) return;
      for (const e of Object.values(h.events)) e.unseen = 0;
      await chrome.storage.local.set({ azrHealth: h });
    });
    $('#healthClear').addEventListener('click', () => chrome.storage.local.remove('azrHealth'));
    $('#healthCopy').addEventListener('click', copyHealthReport);
    // 通知の権限は任意の権限（ストア版の利用者には確認を出さない）。許可はポップアップのボタンを押したときにしか求められない
    const notifyBtn = $('#healthNotify');
    chrome.permissions.contains({ permissions: ['notifications'] }).then((on) => { notifyBtn.hidden = on; });
    notifyBtn.addEventListener('click', async () => {
      if (await chrome.permissions.request({ permissions: ['notifications'] })) notifyBtn.hidden = true;
    });
  }

  /** 修正すべき箇所を、そのまま修正の依頼に貼れる形（Markdown）でクリップボードへ。id はソースを検索する手がかり */
  async function copyHealthReport() {
    const { azrHealth: h = {} } = await chrome.storage.local.get('azrHealth');
    const failing = Object.entries(h.checks || {}).filter(([, c]) => c.ok === false);
    const unseen = Object.entries(h.events || {}).filter(([, e]) => e.unseen > 0);
    const row = (id, c, state) => [
      `- [ ] **${AZR.health.label(id)}** — ${state}`,
      `  - id: \`${id}\``,
      c.detail && `  - 詳細: ${c.detail}`,
      c.url && `  - URL: ${c.url}`
    ].filter(Boolean).join('\n');
    const text = [
      `# 修正が必要な箇所（${new Date().toLocaleString('ja-JP')}、v${chrome.runtime.getManifest().version}）`,
      '',
      ...failing.map(([id, c]) => row(id, c, `失敗 ${c.fails}回（${when(c.since)}〜）`)),
      ...unseen.map(([id, e]) => row(id, e, `${e.unseen}回（最後 ${when(e.at)}）`))
    ].join('\n');
    await navigator.clipboard.writeText(failing.length || unseen.length ? text : '修正が必要な箇所はありません');
    const btn = $('#healthCopy');
    btn.textContent = 'コピーしました';
    setTimeout(() => { btn.textContent = '修正リストをコピー'; }, 1500);
  }

  /* キャンペーンの一括スキャン ---------------------------------------------- */

  const scanStatus = $('#scanStatus');
  const scanButton = $('#scanCampaigns');

  // 一覧に出す文言。status はキャンペーンページを実際に見て決めたもの。
  const STATUS_LABEL = {
    entered: tr('エントリーした'),
    already: tr('エントリー済み'),
    entry: tr('未エントリー'),
    suspect: tr('要確認'),
    none: tr('エントリー不要'),
    timeout: tr('時間切れ'),
    error: tr('失敗'),
    closed: tr('中断'),
    unknown: tr('不明')
  };
  const ORDER = ['suspect', 'entered', 'already', 'entry', 'timeout', 'error', 'closed', 'unknown', 'none'];

  async function renderCampaignList() {
    const items = (await chrome.runtime.sendMessage({ type: 'azr:campaignList' })) || [];
    const list = $('#campaignList');
    list.textContent = '';

    // 分母は「エントリーするものがあったページ」。特集ページまで数えても意味がない。
    const done = items.filter((i) => i.status === 'entered' || i.status === 'already');
    const target = items.filter((i) => ['entered', 'already', 'entry'].includes(i.status));
    $('#enteredCount').textContent = target.length ? `(${done.length}/${target.length})` : '';

    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = tr('まだ調べていません');
      list.append(li);
      return;
    }

    for (const item of [...items].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))) {
      const li = document.createElement('li');
      li.className = `campaign is-${item.status}`;

      const a = document.createElement('a');
      a.href = item.url;
      a.target = '_blank';
      a.textContent = item.title || item.url.replace('https://event.rakuten.co.jp/', '');
      a.title = item.url;

      const state = document.createElement('span');
      state.className = 'campaign-state';
      state.textContent = `${STATUS_LABEL[item.status] || item.status}${item.checkedAt ? ` ${day(item.checkedAt)}` : ''}`;

      li.append(a, state);
      list.append(li);
    }
  }

  /* 実行と進み具合 -----------------------------------------------------------
   * スキャンは数分かかり、その間にポップアップは閉じられる。閉じると sendMessage の応答は
   * 受け取れないので、進み具合は service worker に聞き、結果は session storage から読む。
   * 開き直したときも同じ道筋で、実行中なら進み具合を、終わっていれば前回の結果を出す。 */

  const batchButton = $('#batchEntry');
  const runButtons = [scanButton, batchButton];

  function describe(res) {
    if (!res?.ok) return tr('失敗しました: {e}', { e: tr(res?.error ?? '不明なエラー') });
    return tr('{n}件を確認 / 新たに{e}件エントリー / 既にエントリー済み{a}件', { n: res.checked, e: res.entered, a: res.alreadyEntered })
      + (res.suspect ? tr(' / 要確認{n}件', { n: res.suspect }) : '')
      + (res.failed ? tr(' / 判定できず{n}件', { n: res.failed }) : '')
      + (res.skipped ? tr(' / 対象外のURL {n}件', { n: res.skipped }) : '');
  }

  async function showLastResult({ withTime }) {
    let res = null;
    try {
      res = (await chrome.storage.session.get('azrScanResult')).azrScanResult;
    } catch { /* session storage 不可 */ }
    if (!res) return;
    const at = withTime && res.finishedAt
      ? tr('前回（{time}）: ', { time: new Date(res.finishedAt).toLocaleTimeString(AZR.numberLocale, { hour: '2-digit', minute: '2-digit' }) })
      : '';
    scanStatus.textContent = at + describe(res);
  }

  let pollTimer = null;
  function setRunning(on) {
    for (const b of runButtons) b.disabled = on;
    if (on && !pollTimer) {
      pollTimer = setInterval(pollScan, 800);
    } else if (!on && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollScan() {
    const s = await chrome.runtime.sendMessage({ type: 'azr:scanStatus' }).catch(() => null);
    if (!s?.running) {
      setRunning(false);
      await showLastResult({ withTime: false });
      await renderCampaignList();
      return;
    }
    scanStatus.textContent = s.total ? `${tr(s.phase)}… ${s.done}/${s.total}` : `${tr(s.phase)}…`;
  }

  async function start(message, firstText) {
    setRunning(true);
    scanStatus.textContent = firstText;
    const res = await chrome.runtime.sendMessage(message).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (res?.ok) return pollScan();
    // 別の実行がすでに走っていたなら、そちらの進み具合をそのまま追う
    const s = await chrome.runtime.sendMessage({ type: 'azr:scanStatus' }).catch(() => null);
    if (s?.running) return;
    // 対象のURLが無かったなど、始まらずに終わったものは保存されないので、ここで出す
    setRunning(false);
    scanStatus.textContent = describe(res);
    await renderCampaignList();
  }

  scanButton.addEventListener('click', () => {
    const entry = $('input[data-key="campaignScanEntry"]').checked;
    start({ type: 'azr:scanCampaigns', entry }, tr('トップページを読み込み中…'));
  });

  batchButton.addEventListener('click', () => {
    const list = urls.value.split('\n').map((v) => v.trim()).filter(Boolean);
    if (!list.length) {
      status.textContent = tr('URLを1行以上入力してください');
      return;
    }
    status.textContent = '';
    start({ type: 'azr:enterCampaignUrls', urls: list }, tr('エントリー中…'));
  });

  renderCampaignList();

  // 開いた時点で実行中なら進み具合を追い、終わっていれば前回の結果を出す
  const now = await chrome.runtime.sendMessage({ type: 'azr:scanStatus' }).catch(() => null);
  if (now?.running) {
    setRunning(true);
    pollScan();
  } else {
    showLastResult({ withTime: true });
  }
}

init();
