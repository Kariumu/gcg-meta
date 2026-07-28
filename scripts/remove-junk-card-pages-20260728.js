#!/usr/bin/env node
/**
 * scripts/remove-junk-card-pages-20260728.js  (2026-07-28)
 * cards_master.json に存在しないカードIDのページ9件を、公開リポジトリから削除する。
 *
 * 経緯:
 *  - 2026-07-28 の push（commit 8dfbcd3）で、cards/ 配下のディスク上の全ディレクトリを
 *    push 候補に含めた結果、マスタに存在しない残骸ページ9件が公開されてしまった。
 *  - 9件はいずれも 2026-07-16 生成の、プレビュー画像OCRの誤認識由来と見られる不正ID
 *    （GD05→G005 / 6005 の誤読、および fetch-official-cardlist.js に既知記載のある EB01-045R）。
 *  - sitemap.xml には未登録（generate_cards.js がマスタ基準のため）。本スクリプトでページ実体を削除する。
 *  - ローカル側は _to_delete/cards-junk-20260728/ へ退避済み。
 *
 * 対象外（今回は触らない）:
 *  - cards/ST11-009, ST12-005, ST12-007, ST14-005 は本 push 以前から公開済み。
 *    プレビュー由来と見られるが判断は松岡さんに委ねる。
 *
 * 使い方（E:\GCGSTATS）:
 *   node scripts\remove-junk-card-pages-20260728.js --dry-run   # 存在確認のみ
 *   node scripts\remove-junk-card-pages-20260728.js             # 削除コミット
 */
'use strict';
const path = require('path');
const { githubAPI } = require('../git-push.js');

const OWNER = 'kariumu', REPO = 'gcg-meta', BRANCH = 'main';
const COMMIT_MESSAGE = process.env.COMMIT_MESSAGE
  || 'fix: マスタ未登録の不正カードID ページ9件を削除（OCR誤認識由来、2026-07-28 push の巻き込み分）';

const TARGETS = [
  'cards/6005-004/index.html',
  'cards/EB01-045R/index.html',
  'cards/G005-067/index.html',
  'cards/G005-073/index.html',
  'cards/G005-094/index.html',
  'cards/G005-098/index.html',
  'cards/G005-108/index.html',
  'cards/G005-123/index.html',
  'cards/G005-130/index.html',
];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || process.env.DRY_RUN === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ': socket timeout')), ms))]);
}
async function api(method, url, body, label) {
  let delay = 4000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try { return await withTimeout(githubAPI(method, url, body), 90000, label); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (/403|429|502|503|secondary rate|abuse|rate limit|socket timeout|ECONNRESET|ETIMEDOUT/i.test(msg) && attempt < 6) {
        console.log('  [' + label + '] 再試行' + attempt + ': ' + msg.substring(0, 70));
        await sleep(delay); delay = Math.min(delay * 2, 60000); continue;
      }
      throw new Error('[' + label + '] ' + msg);
    }
  }
}

(async () => {
  const ref = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH, null, 'getRef');
  const head = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + ref.object.sha, null, 'getCommit');
  const tree = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/trees/' + head.tree.sha + '?recursive=1', null, 'getTree');
  if (tree.truncated) { console.error('中止: tree が truncated'); process.exit(1); }

  const remote = new Set();
  for (const it of (tree.tree || [])) if (it.type === 'blob') remote.add(it.path);

  const present = TARGETS.filter((p) => remote.has(p));
  const absent = TARGETS.filter((p) => !remote.has(p));

  console.log('HEAD ' + ref.object.sha.substring(0, 7) + ' / リモート ' + remote.size + ' ファイル');
  console.log('削除対象: ' + present.length + ' / ' + TARGETS.length);
  for (const p of present) console.log('  - ' + p);
  for (const p of absent) console.log('  (既に不在) ' + p);

  // 安全確認: マスタに載る正規ページを巻き込んでいないこと（IDパターンの二重チェック）
  const bad = present.filter((p) => !/^cards\/(6005-004|EB01-045R|G005-(067|073|094|098|108|123|130))\/index\.html$/.test(p));
  if (bad.length) { console.error('中止: 想定外の削除対象 ' + bad.join(',')); process.exit(1); }

  if (present.length === 0) { console.log('削除対象なし。終了。'); return; }
  if (DRY_RUN) { console.log('\n[dry-run] ここで終了。削除していません。'); return; }

  const items = present.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: null }));
  const nt = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', { base_tree: head.tree.sha, tree: items }, 'tree');
  const commit = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', { message: COMMIT_MESSAGE, tree: nt.sha, parents: [ref.object.sha] }, 'commit');
  await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH, { sha: commit.sha, force: false }, 'updateRef');

  console.log('\n削除コミット完了: ' + commit.sha.substring(0, 7));
  console.log('  ' + COMMIT_MESSAGE);
  console.log('DELETE_COMPLETE');
})().catch((e) => { console.error('致命的エラー:', e.message); process.exit(1); });
// EOF
