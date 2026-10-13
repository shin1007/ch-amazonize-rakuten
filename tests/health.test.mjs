/* セルフチェック（src/lib/health.js と service worker の記録）。
 * 開発版（manifest に update_url が無い）でだけ記録し、ストア版では何もしないこと。
 *
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadServiceWorker } from './load.mjs';

const settle = () => new Promise((r) => setTimeout(r, 10));

test('開発版: 失敗が続くと回数を数え、成功すると失敗中でなくなる', async () => {
  const storage = {};
  const sw = loadServiceWorker({ storage, manifest: {} });
  const { health } = sw.AZR;
  assert.equal(health.dev, true);

  health.check('amazon.searchParse', false, '読めない');
  await settle();
  health.check('amazon.searchParse', false, '別の理由');
  await settle();
  let c = storage.azrHealth.checks['amazon.searchParse'];
  assert.equal(c.ok, false);
  assert.equal(c.fails, 2);
  assert.equal(c.detail, '別の理由');
  const since = c.since;
  assert.ok(since > 0);

  health.check('amazon.searchParse', true);
  await settle();
  c = storage.azrHealth.checks['amazon.searchParse'];
  assert.equal(c.ok, true);
  assert.equal(c.since, null);
  assert.ok(c.okAt >= since);
});

test('開発版: 前回と同じ結果は記録し直さない', async () => {
  const storage = {};
  const { AZR } = loadServiceWorker({ storage, manifest: {} });
  AZR.health.check('rakuten.reviewPage', false, '同じ');
  AZR.health.check('rakuten.reviewPage', false, '同じ');
  await settle();
  assert.equal(storage.azrHealth.checks['rakuten.reviewPage'].fails, 1);
});

test('開発版: 出来事は未読の回数を数える', async () => {
  const storage = {};
  const sw = loadServiceWorker({ storage, manifest: {} });
  await sw.recordHealth({ kind: 'event', id: 'warn:x', detail: 'a', at: 1 });
  await sw.recordHealth({ kind: 'event', id: 'warn:x', detail: 'b', at: 2 });
  const e = storage.azrHealth.events['warn:x'];
  assert.equal(e.count, 2);
  assert.equal(e.unseen, 2);
  assert.equal(e.detail, 'b');
});

test('ストア版: 何も記録しない', async () => {
  const storage = {};
  const { AZR } = loadServiceWorker({ storage });
  assert.equal(AZR.health.dev, false);
  AZR.health.check('amazon.searchParse', false, '読めない');
  AZR.health.event('warn:x', 'a');
  await settle();
  assert.equal(storage.azrHealth, undefined);
});

test('説明: 登録していない id は種類から作る', () => {
  const { AZR } = loadServiceWorker({ manifest: {} });
  assert.match(AZR.health.label('module:item-simplify'), /item-simplify/);
  assert.match(AZR.health.label('warn:購入エリア'), /^警告: /);
  assert.equal(AZR.health.label('unknown.id'), 'unknown.id');
});

test('content script には1言語分の訳だけを渡し、足りない文言は英語で埋める', async () => {
  const storage = {};
  const sw = loadServiceWorker({ storage });
  const ko = await sw.messagesFor('ko');
  assert.equal(ko['閉じる'], sw.AZR.messages.ko['閉じる']);
  assert.ok(Object.keys(ko).length >= Object.keys(sw.AZR.messages.en).length);
  assert.ok(Object.keys(storage).some((k) => k.startsWith('azrI18n:ko:')));
  assert.equal(await sw.messagesFor('xx'), null);
});
