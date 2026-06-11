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
// blob 作成完了後の SHA チェックポイント。tree 以降で失敗してもここから再開可能
const BLOB_CHECKPOINT = '/tmp/rebuild_push_blobs.json';
// 2026-05-28 改修: GitHub API セカンダリレート制限対策のため並列度を下げ、リトライを追加
const PARALLEL = parseInt(process.env.PUSH_PARALLEL || '5', 10);
const MAX_RETRY = 5;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// GitHub API 呼び出しを指数バックオフでリトライする共通ラッパー
async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || '');
      const retriable = msg.includes('parse error') || msg.includes('rate limit') ||
                        msg.includes('abuse') || /GitHub API 5\d\d/.test(msg) ||
                        /GitHub API 403/.test(msg) || /GitHub API 429/.test(msg) ||
                        /ECONNRESET|ETIMEDOUT|socket hang up/.test(msg);
      if (!retriable || attempt === MAX_RETRY - 1) throw e;
      const wait = Math.min(60000, 2000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 1000);
      console.log('  [retry ' + (attempt + 1) + '/' + MAX_RETRY + '] ' + label + ' wait ' + (wait / 1000).toFixed(1) + 's: ' + msg.substring(0, 80));
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function createBlob(content) {
  const body = {
    content: Buffer.from(content, 'utf-8').toString('base64'),
    encoding: 'base64'
  };
  return withRetry('blob', async () => {
    const blob = await githubAPI('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', body);
    return blob.sha;
  });
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
  const ref = await withRetry('get-ref', () => githubAPI('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH));
  const headSha = ref.object.sha;
  const headCommit = await withRetry('get-commit', () => githubAPI('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + headSha));
  const baseTreeSha = headCommit.tree.sha;
  console.log('HEAD: ' + headSha.substring(0,7));

  // 3) blob 並列作成(checkpoint があれば skip)
  let shas;
  if (fs.existsSync(BLOB_CHECKPOINT)) {
    const cp = JSON.parse(fs.readFileSync(BLOB_CHECKPOINT, 'utf-8'));
    // checkpoint がファイル数・順序とも一致する場合のみ流用
    if (Array.isArray(cp.shas) && cp.shas.length === files.length &&
        Array.isArray(cp.paths) && cp.paths.join('|') === paths.join('|')) {
      shas = cp.shas;
      console.log('blob チェックポイントから ' + shas.length + ' 件を流用 (' + BLOB_CHECKPOINT + ')');
    }
  }
  if (!shas) {
    console.log('blob 作成開始 (並列度=' + PARALLEL + ')...');
    const tBlob = Date.now();
    shas = await runPool(files, async (f) => createBlob(f.content), PARALLEL);
    console.log('blob 完了: ' + ((Date.now()-tBlob)/1000).toFixed(1) + 's');
    // checkpoint 保存(後続失敗時にやり直し不要)
    try {
      fs.writeFileSync(BLOB_CHECKPOINT, JSON.stringify({ paths, shas }), 'utf-8');
      console.log('blob SHA チェックポイント保存: ' + BLOB_CHECKPOINT);
    } catch (e) {
      console.warn('  ⚠ チェックポイント保存失敗(無視): ' + e.message);
    }
  }

  // 4) tree 作成(リトライあり)
  // 2026-05-28: 1176 件など大量更新時、1 リクエストで全件渡すと GitHub 側が 502 を返すケースがある。
  // チャンク分割(既定 300 件/req)し、base_tree を前チャンクの結果でチェーンする。
  const TREE_CHUNK = parseInt(process.env.TREE_CHUNK || '300', 10);
  const treeItems = files.map((f, i) => ({ path: f.path, mode: '100644', type: 'blob', sha: shas[i] }));
  let currentBaseTree = baseTreeSha;
  let newTree;
  if (treeItems.length <= TREE_CHUNK) {
    newTree = await withRetry('tree', () => githubAPI('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', {
      base_tree: currentBaseTree,
      tree: treeItems
    }));
  } else {
    console.log('tree 作成: ' + treeItems.length + ' 件を ' + TREE_CHUNK + ' 件ずつ分割');
    for (let i = 0; i < treeItems.length; i += TREE_CHUNK) {
      const chunk = treeItems.slice(i, i + TREE_CHUNK);
      const idx = Math.floor(i / TREE_CHUNK) + 1;
      const total = Math.ceil(treeItems.length / TREE_CHUNK);
      const partial = await withRetry('tree-' + idx, () => githubAPI('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', {
        base_tree: currentBaseTree,
        tree: chunk
      }));
      currentBaseTree = partial.sha;
      newTree = partial;
      console.log('  tree chunk ' + idx + '/' + total + ': ' + partial.sha.substring(0, 7) + ' (' + chunk.length + ' 件)');
    }
  }
  console.log('tree: ' + newTree.sha.substring(0,7));

  // 5) commit 作成
  // 環境変数 COMMIT_MESSAGE があればそれを使い、無ければ汎用文を生成
  const msg = process.env.COMMIT_MESSAGE
    || ('build: 静的ページ再生成（新規' + diff.added + '件・更新' + diff.changed + '件）');
  const newCommit = await withRetry('commit', () => githubAPI('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
    message: msg, tree: newTree.sha, parents: [headSha]
  }));
  console.log('commit: ' + newCommit.sha.substring(0,7));

  // 6) ref 更新(リトライあり)
  await withRetry('update-ref', () => githubAPI('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH, {
    sha: newCommit.sha
  }));
  // 成功時のみ checkpoint を掃除
  try { fs.unlinkSync(BLOB_CHECKPOINT); } catch (_) {}
  console.log('=== SUCCESS ===');
  console.log('commit URL: https://github.com/' + OWNER + '/' + REPO + '/commit/' + newCommit.sha);
  console.log('総経過: ' + ((Date.now()-t0)/1000).toFixed(1) + 's');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
