/* Amazonize Rakuten - 楽天市場で自動で行う操作への同意と、ほかのサイトの価格を出すかの選択（入れた直後に開く） */
(async () => {
  const AZR = window.AZR;
  const tr = AZR.t;
  const $ = (sel) => document.querySelector(sel);

  const s = await chrome.storage.sync.get(AZR.DEFAULTS);
  AZR.setLanguage(s.language);
  // 静的な文言を表示言語に合わせる（popup.js と同じやり方）
  if (!AZR.isJa) {
    document.documentElement.lang = AZR.lang;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue.trim();
      if (text) n.nodeValue = n.nodeValue.replace(text, tr(text));
    }
  }

  // 今の設定を初期値にする（同意の前から使っている人は、使っていた設定のまま選べる）
  $('#couponAutoGrab').checked = Boolean(s.couponAutoGrab);
  $('#couponAutoSwitch').checked = Boolean(s.couponAutoApply && !s.couponAutoApplyConfirm);
  $('#campaignAutoScan').checked = Boolean(s.campaignScanOnTop && s.campaignScanEntry);
  const priceInputs = [...document.querySelectorAll('input[data-key]')];
  for (const input of priceInputs) input.checked = Boolean(s[input.dataset.key]);

  $('#start').addEventListener('click', async () => {
    const scan = $('#campaignAutoScan').checked;
    const patch = {
      couponAutoGrab: $('#couponAutoGrab').checked,
      couponAutoApplyConfirm: !$('#couponAutoSwitch').checked,
      campaignScanOnTop: scan,
      consentAt: Date.now()
    };
    for (const input of priceInputs) patch[input.dataset.key] = input.checked;
    if (scan) patch.campaignScanEntry = true;
    await chrome.storage.sync.set(patch);
    $('#status').textContent = tr('設定しました。このタブは閉じてかまいません。');
  });
})();
