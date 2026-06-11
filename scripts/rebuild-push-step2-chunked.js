#!/usr/bin/env node
/**
 * rebuild-push-step2-chunked.js  (2026-05-30 追加)
 *
 * 目的: rebuild-push-step2-push.js が個別 blob を 1 ファイルずつ POST するため
 *       大量ファイル(約1600件)で GitHub の secondary rate limit (403) に阻まれる問題を回避する。
 *
 * 方式: 個別 blob 生成をやめ、git/trees API の「インライン content」で blob を暗黙生成する。
 *       toPush をサイズ基準でチャンク分割し、base_tree をチェーンして tree を積み上げ、
 *       最後に commit を 1 つ作って ref を更新する(= push は単一コミット・原子的)。
 *       書き込み API 呼び出しは「チャンク数 + 2」回程度に激減するため rate limit を回避できる。
 *       403/429/secondary rate limit/abuse は指数バックオフで自動再試行する。
 *
 * 前提: 先に rebuild-push-step1-diff.js を実行し /tmp/rebuild_push_diff.json を生成しておくこと。
 * 環境変数:
 *   COMMIT_MESSAGE     コミットメッセージ(未指定時は既定文)
 *   PUSH_CHUNK_BYTES   1 tree あたりの content 合計上限バイト(既定 2000000 = 2MB)
 *   PUSH_SLEEP_MS      チャンク間スリープ ms(既定 2000)
 */
const fs = require('fs');
const path = require('path');
const { githubAPI } = require('../git-push.js');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'kariumu', REPO = 'gcg-meta', BRANCH = 'main';
const DIFF = '/tmp/rebuild_push_diff.json';
const CHUNK_BYTES = parseInt(process.env.PUSH_CHUNK_BYTES || '2000000', 10);
const SLEEP_MS = parseInt(process.env.PUSH_SLEEP_MS || '2000', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rate limit に強い API ラッパー(指数バックオフ)
async function api(method, url, body, label) {
  let delay = 5000;
  const maxAttempts = 7;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await githubAPI(method, url, body);
    } catch (e) {
      const msg = String((e && e.message) || e);
      const rateLimited = /\b403\b|\b429\b|secondary rate|abuse|rate limit/i.test(msg);
      if (rateLimited && attempt < maxAttempts) {
        console.log(`  [${label}] rate limit 検知。${Math.round(delay / 1000)}s 待機して再試行 (${attempt}/${maxAttempts - 1})...`);
        await sleep(delay);
        delay = Math.min(delay * 2, 90000);
        continue;
      }
      throw new Error(`[${label}] ${msg}`);
    }
  }
}

(async () => {
  const t0 = Date.now();
  if (!fs.existsSync(DIFF)) {
    console.error('ERR: ' + DIFF + ' が見つかりません。先に rebuild-push-step1-diff.js を実行してください。');
    process.exit(1);
  }
  const diff = JSON.parse(fs.readFileSync(DIFF, 'utf-8'));
  const paths = diff.toPush || [];
  if (!paths.length) { console.log('push対象 0 件。終了します。'); return; }
  console.log('push対象: ' + paths.length + ' ファイル / チャンク上限: ' + (CHUNK_BYTES / 1e6).toFixed(1) + ' MB');

  // 現在の HEAD と base tree を取得(失敗した前回の途中 blob は無視され、ここから作り直す)
  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`, null, 'getRef');
  const curSha = ref.object.sha;
  if (diff.headSha && diff.headSha !== curSha) {
    console.warn('  ⚠ remote HEAD が step1 時点(' + String(diff.headSha).substring(0, 7) + ')と異なります: ' + curSha.substring(0, 7) + ' → 現 HEAD を親として続行します');
  }
  const headCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${curSha}`, null, 'getCommit');
  let baseTree = headCommit.tree.sha;
  console.log('HEAD: ' + curSha.substring(0, 7) + ' / baseTree: ' + baseTree.substring(0, 7));

  // サイズ基準でチャンク化し、tree をチェーン(base_tree=直前 tree)で積み上げる
  let i = 0, chunkNo = 0, pushed = 0;
  while (i < paths.length) {
    const items = [];
    let bytes = 0;
    while (i < paths.length) {
      const p = paths[i];
      const content = fs.readFileSync(path.join(ROOT, p), 'utf-8');
      const sz = Buffer.byteLength(content, 'utf-8');
      if (items.length > 0 && bytes + sz > CHUNK_BYTES) break; // 1 チャンク最低 1 ファイルは保証
      items.push({ path: p, mode: '100644', type: 'blob', content });
      bytes += sz; i++;
    }
    chunkNo++;
    const nt = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: baseTree, tree: items }, 'tree#' + chunkNo);
    baseTree = nt.sha;
    pushed += items.length;
    console.log(`  tree#${chunkNo}: +${items.length}件 (${(bytes / 1e6).toFixed(2)}MB) 累計 ${pushed}/${paths.length} -> ${baseTree.substring(0, 7)}`);
    if (i < paths.length) await sleep(SLEEP_MS);
  }

  const msg = process.env.COMMIT_MESSAGE || 'rebuild: card detail pages (chunked)';
  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, { message: msg, tree: baseTree, parents: [curSha] }, 'commit');
  await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha }, 'updateRef');

  console.log('=== SUCCESS ===');
  console.log('commit: ' + commit.sha.substring(0, 7));
  console.log('commit URL: https://github.com/' + OWNER + '/' + REPO + '/commit/' + commit.sha);
  console.log('総経過: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
})().catch((e) => { console.error('ERR:', (e && e.message) || e); process.exit(1); });
