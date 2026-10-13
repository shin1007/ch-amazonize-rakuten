/* 訳（tools/translations）から _locales/<言語>/messages.json を作る
 *
 *   node tools/build-locales.mjs          messages.json を作り直す
 *   node tools/build-locales.mjs split    _bulk.json（番号→訳）を言語ごとの <言語>.json に分ける（移行用の一回きり）
 *
 * 文言は日本語の原文がキー。訳が無い文言は原文（日本語）が出るので、足りなければ警告する。
 * 拡張の実行時に使う訳は、言語を設定で選べるようにするため src/lib/i18n-data.js に全言語ぶん書き出す。
 * _locales の messages.json はストアの名前・説明（manifest）のためのもの。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TR = join(ROOT, 'tools/translations');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const write = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');

/** 原文の前後の空白を訳にも付ける（「 ＋送料」のように、つなぎ目の空白も文言のうち） */
const withEdges = (src, text) => src.match(/^\s*/)[0] + text.trim() + src.match(/\s*$/)[0];

const source = read(join(TR, 'en.json')); // 原文の一覧（キー）。値は英語
const keys = Object.keys(source);

const [cmd] = process.argv.slice(2);

if (cmd === 'split') {
  const bulk = read(join(TR, '_bulk.json'));
  for (const [lang, byNo] of Object.entries(bulk)) {
    const out = {};
    keys.forEach((k, i) => {
      const t = byNo[String(i + 1)];
      if (t == null) console.warn(`${lang}: ${i + 1} (${k}) が無い`);
      else out[k] = withEdges(k, t);
    });
    write(join(TR, `${lang}.json`), out);
    console.log(lang, Object.keys(out).length);
  }
} else {
  const app = read(join(TR, '_app.json'));
  // 拡張の実行時に使う訳は、言語の選択に対応するため messages.json ではなくこのファイルから引く（i18n.js）
  const langs = readdirSync(TR).filter((f) => /^[a-z]{2}(_[A-Z]{2})?\.json$/.test(f)).map((f) => f.replace('.json', ''));
  const data = {};
  for (const lang of langs) data[lang] = read(join(TR, `${lang}.json`));
  writeFileSync(join(ROOT, 'src/lib/i18n-data.js'), `/* 自動生成（node tools/build-locales.mjs）。訳の一覧。使い方は i18n.js
 * ポップアップ・確認のページと service worker が読む。content script は読まない（service worker から自分の言語の分だけ受け取る）。 */
(() => {
  const g = typeof window !== 'undefined' ? window : self;
  const AZR = (g.AZR = g.AZR || {});
  AZR.messages = ${JSON.stringify(data, null, 2).split(String.fromCharCode(10)).join(String.fromCharCode(10) + '  ')};
})();
`);
  console.log('src/lib/i18n-data.js');
  for (const lang of langs) {
    const dict = read(join(TR, `${lang}.json`));
    const ph = (x) => (x.match(/\{\w+\}/g) || []).sort().join();
    for (const k of keys) {
      if (dict[k] == null) console.warn(`${lang}: 訳が無い: ${k}`);
      else if (ph(k) !== ph(dict[k])) console.warn(`${lang}: {} が食い違う: ${k} -> ${dict[k]}`);
    }
  }
  for (const lang of Object.keys(app)) {
    const msgs = {};
    const a = app[lang];
    if (a.description.length > 132) throw new Error(`${lang}: 説明が132文字を超える (${a.description.length})`);
    msgs.appName = { message: a.name };
    msgs.appDescription = { message: a.description };
    const dir = join(ROOT, '_locales', lang);
    mkdirSync(dir, { recursive: true });
    write(join(dir, 'messages.json'), msgs);
    console.log(`_locales/${lang}/messages.json`, Object.keys(msgs).length);
  }
}
