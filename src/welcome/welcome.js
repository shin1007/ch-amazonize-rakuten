/* Amazonize Rakuten - 自動で行う操作への同意（入れた直後に開く） */
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

  $('#start').addEventListener('click', async () => {
    const scan = $('#campaignAutoScan').checked;
    const patch = {
      couponAutoGrab: $('#couponAutoGrab').checked,
      couponAutoApplyConfirm: !$('#couponAutoSwitch').checked,
      campaignScanOnTop: scan,
      consentAt: Date.now()
    };
    if (scan) patch.campaignScanEntry = true;
    await chrome.storage.sync.set(patch);
    $('#status').textContent = tr('設定しました。このタブは閉じてかまいません。');
  });
})();
