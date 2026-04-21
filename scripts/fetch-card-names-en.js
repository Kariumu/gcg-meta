#!/usr/bin/env node
/**
 * scripts/fetch-card-names-en.js
 *
 * 海外版公式サイト (https://www.gundam-gcg.com/en/cards/) から
 * 全カードの英語名を取得し、data/cards_master_en.json を生成・更新する。
 *
 * 設計:
 *   - cards_master.json の全 ID を対象とする
 *   - 既存の cards_master_en.json があれば読み込み、未取得分のみ再取得（レジューム）
 *   - 各リクエスト間に --delay-ms で指定した時間だけ待機（デフォルト 800ms）
 *   - --time-budget-ms で指定した時間を超えたら保存して正常終了（bash timeout 対策）
 *   - 失敗カードは failed_cards リストに記録し、次回実行で再試行
 *
 * 使い方:
 *   node scripts/fetch-card-names-en.js                              # 全件、時間無制限
 *   node scripts/fetch-card-names-en.js --time-budget-ms=40000      # 40秒で区切って保存終了
 *   node scripts/fetch-card-names-en.js --delay-ms=1000              # 1秒間隔
 *   node scripts/fetch-card-names-en.js --retry-failed                # failed のみ再試行
 *   node scripts/fetch-card-names-en.js --only=GD04-001,GD04-002     # 指定IDのみ
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ========== 引数解析 ==========
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (!m) continue;
  args[m[1]] = m[2] === undefined ? true : m[2];
}

const DELAY_MS = parseInt(args['delay-ms'] || '800', 10);
const TIME_BUDGET_MS = parseInt(args['time-budget-ms'] || '0', 10); // 0 = unlimited
const ONLY = args.only ? args.only.split(',').map(s => s.trim()).filter(Boolean) : null;
const RETRY_FAILED = !!args['retry-failed'];
const MAX_RETRIES_PER_CARD = parseInt(args['max-retries'] || '3', 10);
const REQUEST_TIMEOUT_MS = parseInt(args['request-timeout-ms'] || '15000', 10);
const VERBOSE = !!args.verbose;

// ========== パス ==========
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const MASTER_PATH = path.join(DATA_DIR, 'cards_master.json');
const OUT_PATH = path.join(DATA_DIR, 'cards_master_en.json');
const META_PATH = path.join(DATA_DIR, 'cards_master_en.meta.json'); // failed_cards 等を保存

// ========== ユーティリティ ==========
const UA = 'Mozilla/5.0 gcg-stats-en-name-fetcher/1.0 (+https://gcg-stats.com; contact: maintainer)';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchHtml(urlString) {
  return new Promise((resolve, reject) => {
    const req = https.request(urlString, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 簡易リダイレクト追従
        res.resume();
        return fetchHtml(new URL(res.headers.location, urlString).toString())
          .then(resolve, reject);
      }
      if (!res.statusCode || res.statusCode >= 400) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => resolve(buf));
    });
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// よく使われる HTML エンティティを正規文字に戻す（公式サイトが &#039; 等を生出しする対策）
const HTML_ENTITY_MAP = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#039;': "'", '&apos;': "'", '&nbsp;': ' '
};
function decodeHtmlEntities(s) {
  return s.replace(/&[a-zA-Z#0-9]+;/g, (m) => {
    if (HTML_ENTITY_MAP[m] !== undefined) return HTML_ENTITY_MAP[m];
    // 数値文字参照 (&#NNNN;)
    if (m.startsWith('&#') && m.endsWith(';')) {
      const num = parseInt(m.slice(2, -1).replace(/^x/, ''), m.startsWith('&#x') ? 16 : 10);
      if (!Number.isNaN(num)) return String.fromCharCode(num);
    }
    return m;
  });
}

function extractNameFromHtml(html, cardId) {
  // 最初に現れる「<cardId>.webp ... alt="..."」を取る
  // URL のクエリパラメータや属性順序に揺れがあっても拾えるようにする
  const escapedId = cardId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(escapedId + '\\.webp[^>]*alt="([^"]+)"'),
    new RegExp(escapedId + '\\.webp[^>]*alt=\'([^\']+)\'')
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return null;
}

function load(pathStr, fallback) {
  try {
    return JSON.parse(fs.readFileSync(pathStr, 'utf-8'));
  } catch (_) { return fallback; }
}

function save(pathStr, obj) {
  const tmp = pathStr + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, pathStr);
}

// ========== メイン ==========
(async function main() {
  const t0 = Date.now();

  const master = load(MASTER_PATH, null);
  if (!master) {
    console.error('FATAL: cards_master.json が読めません:', MASTER_PATH);
    process.exit(2);
  }
  const allIds = Object.keys(master);

  // 既存の成果物を読み込み（レジューム）
  const result = load(OUT_PATH, {});
  const meta = load(META_PATH, { failed_cards: {}, last_updated: null });

  // 対象 ID の決定
  let targetIds;
  if (ONLY) {
    targetIds = ONLY;
  } else if (RETRY_FAILED) {
    targetIds = Object.keys(meta.failed_cards || {});
  } else {
    // 未取得（en が未定義 or null のまま）を残し、既に成功したものはスキップ
    targetIds = allIds.filter(id => !(result[id] && typeof result[id].en === 'string' && result[id].en.length > 0));
  }

  console.log(`対象: ${targetIds.length}件 / 全${allIds.length}件`);
  console.log(`設定: delay=${DELAY_MS}ms, time-budget=${TIME_BUDGET_MS || '無制限'}ms, max-retries/card=${MAX_RETRIES_PER_CARD}`);

  let processed = 0, ok = 0, ng = 0, budgetHit = false;

  for (let i = 0; i < targetIds.length; i++) {
    const cardId = targetIds[i];
    const jp = master[cardId] ? (master[cardId].name_jp || master[cardId].name || '') : '';

    // 時間予算チェック（開始前）
    if (TIME_BUDGET_MS > 0 && (Date.now() - t0) > TIME_BUDGET_MS) {
      budgetHit = true;
      break;
    }

    const url = `https://www.gundam-gcg.com/en/cards/index.php?freeword=${encodeURIComponent(cardId)}`;

    let en = null;
    let lastErr = null;
    let attempts = 0;
    while (attempts < MAX_RETRIES_PER_CARD) {
      attempts++;
      try {
        const html = await fetchHtml(url);
        en = extractNameFromHtml(html, cardId);
        if (en) break;
        // 抽出できなかった（海外版未リリース等の可能性） → リトライしない
        lastErr = new Error('alt not found');
        break;
      } catch (e) {
        lastErr = e;
        if (attempts < MAX_RETRIES_PER_CARD) {
          await sleep(500 + attempts * 500);
        }
      }
    }

    processed++;
    if (en) {
      result[cardId] = { en, jp };
      if (meta.failed_cards && meta.failed_cards[cardId]) delete meta.failed_cards[cardId];
      ok++;
    } else {
      // 抽出できないケース: alt not found は「海外版未リリース」の可能性が高い
      const note = (lastErr && /alt not found/.test(lastErr.message)) ? '海外版未リリースの可能性' : ('fetch_error: ' + (lastErr && lastErr.message));
      result[cardId] = { en: null, jp, note };
      meta.failed_cards = meta.failed_cards || {};
      meta.failed_cards[cardId] = {
        attempts,
        last_error: lastErr ? lastErr.message : 'unknown',
        at: new Date().toISOString()
      };
      ng++;
    }

    // 都度保存（10件ごと）
    if (processed % 10 === 0) {
      meta.last_updated = new Date().toISOString();
      save(OUT_PATH, result);
      save(META_PATH, meta);
      if (VERBOSE) {
        console.log(`  [${processed}/${targetIds.length}] ok=${ok}, ng=${ng}, last=${cardId} -> ${en || '(null)'}`);
      }
    }

    // レート制御
    if (i < targetIds.length - 1) await sleep(DELAY_MS);
  }

  // 最終保存
  meta.last_updated = new Date().toISOString();
  save(OUT_PATH, result);
  save(META_PATH, meta);

  const totalEn = Object.values(result).filter(v => v && typeof v.en === 'string' && v.en.length > 0).length;
  const totalNull = Object.keys(result).length - totalEn;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('=== 実行結果 ===');
  console.log(`このバッチ: 処理=${processed}, OK=${ok}, NG=${ng}, 経過=${elapsed}s, 予算切れ=${budgetHit}`);
  console.log(`累積     : 取得済(en!=null)=${totalEn}, null件=${totalNull}, 全対象=${allIds.length}`);
  console.log(`残り     : ${allIds.filter(id => !(result[id] && typeof result[id].en === 'string' && result[id].en.length > 0)).length}件`);
  console.log(`failed_cards: ${Object.keys(meta.failed_cards || {}).length}件`);
  console.log(`out: ${OUT_PATH}`);
  console.log(`meta: ${META_PATH}`);
})().catch(err => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
