#!/usr/bin/env node
/**
 * ステップ2: /tmp/rebuild_push_diff.json の toPush を読み、並列で blob 作成 → tree → commit → ref 更新
 * 並列度 10, 1コミットで完結。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { githubAPI } = require('../git-push.js');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'kariumu', REPO = 'gcg-meta', BRANCH = 'main';
const DIFF = '/tmp/rebuild_push_diff.json';
const PARALLEL = 10;

async function createBlob(content) {
  const body = {
    content: Buffer.from(content, 'utf-8').toString('base64'),
    encoding: 'base64'
  };
  const blob = await githubAPI('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', body);
  return blob.sha;
}

async function runPool(items, worker, parallel) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  const workers = [];
  for (let w = 0; w < parallel; w++) {
    workers.push((async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) break;
        results[i] = await worker(items[i], i);
        done++;
        if (done % 25 === 0) console.log('  progress: ' + done + ' / ' + items.length);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

(async () => {
  const t0 = Date.now();
  const diff = JSON.parse(fs.readFileSync(DIFF, 'utf-8'));
  const paths = diff.toPush;
  console.log('push対象: ' + paths.length + ' ファイル');

  // 1) 内容読み込み
  const files = paths.map(p => ({ path: p, content: fs.readFileSync(path.join(ROOT, p), 'utf-8') }));
  const totalKB = files.reduce((s,f)=>s+Buffer.byteLength(f.content,'utf-8'),0)/1024;
  console.log('合計サイズ: ' + totalKB.toFixed(1) + ' KB');

  // 2) HEAD 最新を取得（コンフリクト回避）
  const ref = await githubAPI('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  const headSha = ref.object.sha;
  const headCommit = await githubAPI('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + headSha);
  const baseTreeSha = headCommit.tree.sha;
  console.log('HEAD: ' + headSha.substring(0,7));

  // 3) blob 並列作成
  console.log('blob 作成開始 (並列度=' + PARALLEL + ')...');
  const tBlob = Date.now();
  const shas = await runPool(files, async (f) => createBlob(f.content), PARALLEL);
  console.log('blob 完了: ' + ((Date.now()-tBlob)/1000).toFixed(1) + 's');

  // 4) tree 作成
  const treeItems = files.map((f, i) => ({ path: f.path, mode: '100644', type: 'blob', sha: shas[i] }));
  const newTree = await githubAPI('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', {
    base_tree: baseTreeSha,
    tree: treeItems
  });
  console.log('tree: ' + newTree.sha.substring(0,7));

  // 5) commit 作成
  const msg = 'build: 3月NCマージ後の静的ページ再生成（新規' + diff.added + '件・更新' + diff.changed + '件）';
  const newCommit = await githubAPI('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
    message: msg, tree: newTree.sha, parents: [headSha]
  });
  console.log('commit: ' + newCommit.sha.substring(0,7));

  // 6) ref 更新
  await githubAPI('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH, {
    sha: newCommit.sha
  });
  console.log('=== SUCCESS ===');
  console.log('commit URL: https://github.com/' + OWNER + '/' + REPO + '/commit/' + newCommit.sha);
  console.log('総経過: ' + ((Date.now()-t0)/1000).toFixed(1) + 's');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
