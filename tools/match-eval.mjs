/* 商品名の突き合わせ方を比べる
 *
 *   node tools/match-eval.mjs collect   中継サーバー（Yahoo!ショッピング）から評価用のデータを集め、fixtures/match-eval.json に保存
 *   node tools/match-eval.mjs           保存したデータで、突き合わせ方ごとの当たり外れを出す
 *
 * 正解はJANで決める。Yahoo!ショッピングの検索結果にはJANが入っているので、
 *   1. いろいろな分野の語で引き、JANのある出品を「こちらの商品」として選ぶ
 *   2. その商品名から拡張と同じ検索語（buildQuery）を作って引き直す
 *   3. 返った候補のうち、JANが同じものが正解、違うものが不正解（JANの無い候補は判定できないので除く）
 * 「こちらの商品名」は出品者が付けた宣伝入りの名前で、楽天の商品名と同じ癖がある。
 *
 * 選び方は「点がいちばん高い候補を、合格点以上なら選ぶ」。違う商品の値段を出す方が、何も出さないより悪いので、
 * 誤り（違う商品を選んだ）を 3 回分の見逃しと同じ重さに数え、各方法で最も良い合格点のときの成績を比べる。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAZR } from '../tests/load.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'fixtures/match-eval.json');
const RELAY = 'https://amazon-rakuten-link.shin1007.workers.dev/yahoo';
const AZR = loadAZR(['src/lib/amazon-match.js']);
const A = AZR.amazon;

const CATEGORIES = [
  'シャンプー', 'ワイヤレスイヤホン', '洗濯洗剤', 'コーヒー豆', '乾電池', 'マウス', 'プロテイン', 'ドッグフード',
  '化粧水', '電動歯ブラシ', 'LANアダプター', 'モバイルバッテリー', 'ボールペン', '日焼け止め', 'インスタントラーメン',
  'ミネラルウォーター', 'ヘアドライヤー', 'USBメモリ', 'キャットフード', 'ボディソープ', '入浴剤', 'サプリメント',
  'おむつ', 'ゲームソフト', '文庫本', 'プリンターインク', '炭酸水', 'マスク', 'ハンドクリーム', 'SDカード'
];
const PER_CATEGORY = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function yahoo(keyword) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${RELAY}?keyword=${encodeURIComponent(keyword)}`);
    if (r.status === 429) { await sleep(30000); continue; }
    await sleep(1500); // 中継の回数制限（1分60回）に当たらないように
    const j = await r.json().catch(() => ({}));
    return Array.isArray(j.items) ? j.items : [];
  }
  return [];
}

async function collect() {
  // 途中で止まっても集めた分は残し、続きから集める
  const cases = existsSync(DATA) ? JSON.parse(readFileSync(DATA, 'utf8')) : [];
  const used = new Set(cases.map((c) => c.jan));
  const done = new Set(cases.map((c) => c.category));
  for (const cat of CATEGORIES) {
    if (done.has(cat)) continue;
    const seeds = (await yahoo(cat)).filter((it) => A.isJan(it.janCode) && !used.has(it.janCode));
    let n = 0;
    for (const seed of seeds) {
      if (n >= PER_CATEGORY) break;
      used.add(seed.janCode);
      const query = A.buildQuery(seed.itemName);
      if (!query) continue;
      let items = await yahoo(query);
      if (!items.length && query.split(' ').length > 3) items = await yahoo(query.split(' ').slice(0, 3).join(' '));
      const candidates = items
        .filter((it) => it.itemUrl !== seed.itemUrl && A.isJan(it.janCode) && it.itemPrice > 0)
        .map((it) => ({ title: it.itemName, price: it.itemPrice, same: it.janCode === seed.janCode }));
      if (!candidates.length) continue;
      cases.push({ category: cat, title: seed.itemName, price: seed.itemPrice, jan: seed.janCode, candidates });
      n++;
      writeFileSync(DATA, JSON.stringify(cases, null, 1));
      console.log(cat, candidates.filter((c) => c.same).length, '/', candidates.length, seed.itemName.slice(0, 40));
    }
  }
  writeFileSync(DATA, JSON.stringify(cases, null, 1));
  console.log(cases.length, '件 ->', DATA);
}

/* 比べる突き合わせ方 ---------------------------------------------------------- */

// Amazonの商品ページ（amazon-link.js）で使っていた、文字の2文字ずつの重なり（Dice係数）と規格の食い違い
const bigrams = (s) => {
  const t = s.toLowerCase().replace(/[【\[（(][^】\])）]*[】\])）]/g, '').replace(/[\s\-_/・|｜,、]+/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
};
const dice = (a, b) => {
  const x = bigrams(a);
  const y = bigrams(b);
  let hit = 0;
  x.forEach((g) => { if (y.has(g)) hit++; });
  return x.size + y.size ? (2 * hit) / (x.size + y.size) : 0;
};
const toHalfNum = (s) => s.replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const specsOf = (s) => {
  const m = new Map();
  for (const [, n, unit] of toHalfNum(s).matchAll(/(\d+(?:\.\d+)?)\s*(入力|出力|台|ポート|口|個|枚|本|袋|箱|セット|GB|TB|mAh|W|ml|L|kg|g|cm|mm|インチ|型)/gi)) {
    const u = unit.toLowerCase();
    if (!m.has(u)) m.set(u, new Set());
    m.get(u).add(Number(n));
  }
  return m;
};
const specMismatch = (a, b) => {
  const sa = specsOf(a);
  for (const [u, nums] of specsOf(b)) {
    const x = sa.get(u);
    if (x && ![...nums].some((n) => x.has(n))) return true;
  }
  return false;
};
const priceGap = (p, q) => (p ? Math.min(Math.abs(q - p) / p, 1) : 0);

const METHODS = {
  // 楽天・Yahoo!の商品ページで使っているもの
  scoreMatch: (q, c) => A.scoreMatch(q.title, c.title),
  // Amazonの商品ページで使っていたもの（規格が食い違えば外し、価格差で少し下げる）
  dice: (q, c) => (specMismatch(q.title, c.title) ? 0 : dice(q.title, c.title) - 0.3 * priceGap(q.price, c.price)),
  diceNoPrice: (q, c) => (specMismatch(q.title, c.title) ? 0 : dice(q.title, c.title)),
  // scoreMatch に規格の食い違いを足す
  scoreMatchSpec: (q, c) => (specMismatch(q.title, c.title) ? 0 : A.scoreMatch(q.title, c.title)),
  // 両方の平均（scoreMatch の容量・セット数の減点はそのまま効く）
  hybrid: (q, c) => (specMismatch(q.title, c.title) ? 0 : (A.scoreMatch(q.title, c.title) + dice(A.normalizeTitle(q.title), A.normalizeTitle(c.title))) / 2),
  hybridNoSpec: (q, c) => (A.scoreMatch(q.title, c.title) + dice(A.normalizeTitle(q.title), A.normalizeTitle(c.title))) / 2,
  // scoreMatch を両方向で見て低い方（相手の名前に余計な語が多いときも下がる）
  scoreMatchBoth: (q, c) => Math.min(A.scoreMatch(q.title, c.title), A.scoreMatch(c.title, q.title)),
  scoreMatchBothSpec: (q, c) => (specMismatch(q.title, c.title) ? 0 : Math.min(A.scoreMatch(q.title, c.title), A.scoreMatch(c.title, q.title))),
  scoreMatchMean: (q, c) => (A.scoreMatch(q.title, c.title) + A.scoreMatch(c.title, q.title)) / 2
};

const WRONG_WEIGHT = Number(process.env.WRONG_WEIGHT) || 3;

function evaluate(cases, fn) {
  const scored = cases.map((q) => {
    const list = A.sameCondition(q.title, q.candidates).map((c) => ({ ...c, score: fn(q, c) }));
    const best = list.reduce((a, b) => (!a || b.score > a.score ? b : a), null);
    return { best, hasAnswer: q.candidates.some((c) => c.same) };
  });
  let top = null;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    let right = 0;
    let wrong = 0;
    let missed = 0;
    for (const { best, hasAnswer } of scored) {
      const pick = best && best.score >= t ? best : null;
      if (pick?.same) right++;
      else if (pick) wrong++;
      else if (hasAnswer) missed++;
    }
    const cost = wrong * WRONG_WEIGHT + missed;
    if (!top || cost < top.cost) top = { t: Math.round(t * 100) / 100, right, wrong, missed, cost };
  }
  return top;
}

if (process.argv[2] === 'collect') {
  await collect();
} else {
  if (!existsSync(DATA)) throw new Error('先に node tools/match-eval.mjs collect');
  const seeds = JSON.parse(readFileSync(DATA, 'utf8'));
  /*
   * API を呼ばずに件数を増やす: 正解の候補（JANが同じ出品）も「こちらの商品」にできる。
   * その出品から見ると、元の商品と、JANが同じほかの出品が正解、残りは不正解になる。
   */
  const cases = seeds.flatMap((q) => [q, ...q.candidates.filter((c) => c.same).map((p) => ({
    ...q, title: p.title, price: p.price,
    candidates: [{ title: q.title, price: q.price, same: true }, ...q.candidates.filter((c) => c !== p)]
  }))]);
  const answerable = cases.filter((q) => q.candidates.some((c) => c.same)).length;
  console.log(`${seeds.length}件の商品から ${cases.length}件（正解が候補にあるもの ${answerable}件）。誤りは見逃し${WRONG_WEIGHT}回分で数える`);
  console.log('方法'.padEnd(16), '合格点', '正解', '誤り', '見逃し', '損失');
  for (const [name, fn] of Object.entries(METHODS)) {
    const r = evaluate(cases, fn);
    console.log(name.padEnd(16), String(r.t).padEnd(6), String(r.right).padEnd(4), String(r.wrong).padEnd(4), String(r.missed).padEnd(6), r.cost);
  }
}
