/* content script（window.AZR に生やす IIFE）を Node で読むための最小の土台。
 * ブラウザでしか意味のない部分（DOM・postMessage）は空の実装で置き換える。 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** files を manifest と同じ順に読み、window.AZR を返す */
export function loadAZR(files) {
  const noop = () => {};
  const window = { addEventListener: noop, postMessage: noop };
  const context = vm.createContext({
    window,
    document: { readyState: 'complete', addEventListener: noop },
    location: { host: '', pathname: '/', origin: 'https://example.invalid' },
    console
  });
  for (const f of files) {
    vm.runInContext(readFileSync(join(ROOT, f), 'utf8'), context, { filename: f });
  }
  return window.AZR;
}

/**
 * service worker を Node で読む。chrome API とネットワークは差し替える。
 * 中の関数は function 宣言なので、文脈のグローバルとして触れる。
 *   const sw = loadServiceWorker({ fetch: async () => ({ ok: true, text: async () => html }) });
 *   sw.parseAmazonSearch(html)
 */
export function loadServiceWorker({ fetch = async () => { throw new Error("fetch されない前提"); }, storage = {}, manifest = { update_url: 'https://clients2.google.com/service/update2/crx' } } = {}) {
  const noop = () => {};
  const listener = { addListener: noop };
  const ctx = vm.createContext({
    console,
    fetch,
    setInterval: noop,
    clearInterval: noop,
    setTimeout, // 空で返ったときの読み直しの待ちに使う
    URL,
    URLSearchParams,
    TextDecoder,
    AbortSignal: { timeout: () => null },
    chrome: {
      // manifest に update_url が無い = 開発版（セルフチェックが動く）
      runtime: { onInstalled: listener, onMessage: listener, getPlatformInfo: async () => ({}), getManifest: () => manifest },
      tabs: { onUpdated: listener, onRemoved: listener },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      declarativeNetRequest: { updateSessionRules: async () => {} },
      storage: {
        session: { setAccessLevel: noop },
        onChanged: listener,
        // chrome.storage.local の代わり。渡した storage をそのまま読み書きする。
        local: {
          get: async (key) => (key in storage ? { [key]: storage[key] } : {}),
          set: async (obj) => Object.assign(storage, obj)
        }
      }
    }
  });
  ctx.self = ctx;
  // service worker の importScripts は拡張のルートからの絶対パス
  ctx.importScripts = (path) => vm.runInContext(readFileSync(join(ROOT, path.replace(/^\//, '')), 'utf8'), ctx, { filename: path });
  vm.runInContext(readFileSync(join(ROOT, "src/background/service_worker.js"), "utf8"), ctx, { filename: "service_worker.js" });
  return ctx;
}
