#!/usr/bin/env node
/**
 * deploy-results.js  (E:\GCGSTATS 直下・常設 / 指示書51 Task3)
 *
 * NTC結果反映後の生成物を GitHub(kariumu/gcg-meta main) へ SHA差分push する。
 * 土台: .sched-run-tmp/deploy-ntc-june-6791.js（候補リスト・SHA差分・DRY・pushFiles=REST API を踏襲）。
 *
 * 変更点:
 *  - E:\GCGSTATS 直下常設のため ROOT=__dirname。
 *  - tree truncated 時は push せず中断して報告（差分検出が不完全なため安全側）。
 *  - コミットメッセージ既定: `data: NTC結果 YYYY-MM-DD分反映（新規N・更新M）`（env COMMIT_MSG 上書き可）。
 *  - 対象外の維持: cards.html / cards_preview.json / tmp/ / .sched-run-tmp/ / node_modules/。
 *  - push対象0なら何もしない（オフシーズンのno-op保証）。
 *
 * 環境変数: DRY=1（差分一覧のみ・push無し） / INCLUDE_SERIES_JSON=1（series.json説明更新時のみ含める） / COMMIT_MSG。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { githubAPI, pushFiles } = require('./git-push.js');

const ROOT = __dirname;
const OWNER = 'kariumu', REPO = 'gcg-meta', BRANCH = 'main';
const DRY = process.env.DRY === '1';

function gitBlobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf-8');
  const h = crypto.createHash('sha1');
  h.update('blob ' + b.length + '\0');
  h.update(b);
  return h.digest('hex');
}

function listLocalTargets() {
  const files = [];
  const add = (repoPath, localPath) => {
    if (fs.existsSync(localPath)) files.push({ repoPath, localPath });
  };

  // データ
  add('data/events.json', path.join(ROOT, 'data', 'events.json'));
  add('data/summary.json', path.join(ROOT, 'data', 'summary.json'));
  add('data/missing_data.json', path.join(ROOT, 'data', 'missing_data.json'));
  if (process.env.INCLUDE_SERIES_JSON === '1') {
    add('data/series.json', path.join(ROOT, 'data', 'series.json'));
  }

  // data/series/*.json
  const seriesDataDir = path.join(ROOT, 'data', 'series');
  if (fs.existsSync(seriesDataDir)) {
    for (const n of fs.readdirSync(seriesDataDir)) {
      if (n.endsWith('.json')) add('data/series/' + n, path.join(seriesDataDir, n));
    }
  }

  // series/*.html
  const seriesDir = path.join(ROOT, 'series');
  if (fs.existsSync(seriesDir)) {
    for (const n of fs.readdirSync(seriesDir)) {
      if (n.endsWith('.html')) add('series/' + n, path.join(seriesDir, n));
    }
  }

  // events/*.html
  const eventsDir = path.join(ROOT, 'events');
  if (fs.existsSync(eventsDir)) {
    for (const n of fs.readdirSync(eventsDir)) {
      if (n.endsWith('.html')) add('events/' + n, path.join(eventsDir, n));
    }
  }

  // cards/*/index.html（全数。SHA差分で実際に変わった分だけpushされる）
  const cardsDir = path.join(ROOT, 'cards');
  if (fs.existsSync(cardsDir)) {
    for (const n of fs.readdirSync(cardsDir)) {
      const sub = path.join(cardsDir, n);
      if (fs.statSync(sub).isDirectory()) {
        add('cards/' + n + '/index.html', path.join(sub, 'index.html'));
      }
    }
  }

  // ルート静的ページ + sitemap（cards.html は対象外）
  for (const n of ['index.html', 'events.html', 'meta.html', 'sitemap.xml']) {
    add(n, path.join(ROOT, n));
  }

  return files;
}

// 大量差分でも tree-too-large(422) を避ける堅牢push: blob作成→treeを分割チェーン→commit→ref更新。
// （git-push.js の pushFiles は全ファイルを1treeで作るため、数百件規模で422になり得る。指示書50で649枚push時に実証）
async function pushRobust(files, message, baseSha, baseTreeSha) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const items = [];
  let i = 0;
  for (const f of files) {
    const blob = await githubAPI('POST', `/repos/${OWNER}/${REPO}/git/blobs`,
      { content: Buffer.from(f.content, 'utf-8').toString('base64'), encoding: 'base64' });
    items.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    if (++i % 50 === 0) console.log(`  blobs ${i}/${files.length}`);
    if (files.length > 30) await sleep(100); // 二次レート制限回避（小規模なら不要）
  }
  let curTree = baseTreeSha;
  const B = 80; // 1tree=80件で分割チェーン（tree-too-large回避）
  for (let j = 0; j < items.length; j += B) {
    const t = await githubAPI('POST', `/repos/${OWNER}/${REPO}/git/trees`,
      { base_tree: curTree, tree: items.slice(j, j + B) });
    curTree = t.sha;
  }
  const nc = await githubAPI('POST', `/repos/${OWNER}/${REPO}/git/commits`,
    { message, tree: curTree, parents: [baseSha] });
  await githubAPI('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: nc.sha });
  return nc;
}

async function main() {
  console.log('=== deploy-results' + (DRY ? ' [DRY]' : '') + ' ===');
  const t0 = Date.now();

  const local = listLocalTargets();
  console.log('ローカル対象: ' + local.length + ' ファイル');

  const ref = await githubAPI('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const headSha = ref.object.sha;
  const headCommit = await githubAPI('GET', `/repos/${OWNER}/${REPO}/git/commits/${headSha}`);
  const headTreeSha = headCommit.tree.sha;
  console.log('GitHub HEAD: ' + headSha.slice(0, 7) + ' tree=' + headTreeSha.slice(0, 7));

  const tree = await githubAPI('GET',
    `/repos/${OWNER}/${REPO}/git/trees/${headTreeSha}?recursive=1`);
  if (tree.truncated) {
    // 差分検出が不完全＝取りこぼしの危険。安全側で中断（現行の「警告のみ」から変更）。
    console.error('  ✗ tree truncated: リモートtreeが大きく全ファイルを取得できませんでした。');
    console.error('    差分検出が不完全なため push を中断します。手動確認・分割push等で対応してください。');
    process.exit(2);
  }
  const remoteSha = {};
  for (const it of (tree.tree || [])) if (it.type === 'blob') remoteSha[it.path] = it.sha;
  console.log('GitHub 側ファイル数: ' + Object.keys(remoteSha).length);

  const added = [], changed = [];
  let unchanged = 0;
  for (const f of local) {
    const content = fs.readFileSync(f.localPath, 'utf-8');
    const lsha = gitBlobSha(content);
    const rsha = remoteSha[f.repoPath];
    if (!rsha) added.push({ path: f.repoPath, content });
    else if (rsha !== lsha) changed.push({ path: f.repoPath, content });
    else unchanged++;
  }
  console.log(`差分: 新規=${added.length}, 更新=${changed.length}, 同一=${unchanged}`);

  const toPush = added.concat(changed);
  if (toPush.length === 0) { console.log('push対象なし。終了（no-op）。'); return; }

  console.log('--- push対象 ---');
  for (const f of toPush.slice(0, 60)) console.log('  ' + f.path);
  if (toPush.length > 60) console.log(`  ...他 ${toPush.length - 60} 件`);
  if (toPush.length > 200) {
    console.warn(`  ⚠ push対象が${toPush.length}件と多め。大量バックフィル時は tree サイズ上限に注意（必要なら分割push）。`);
  }

  if (DRY) { console.log('[DRY] push スキップ。'); return; }

  const today = new Date().toISOString().split('T')[0];
  const msg = process.env.COMMIT_MSG ||
    `data: NTC結果 ${today}分反映（新規${added.length}・更新${changed.length}）`;
  const commit = await pushRobust(toPush, msg, headSha, headTreeSha);
  console.log('=== SUCCESS ===');
  console.log('Commit: ' + (commit && commit.sha));
  console.log('elapsed: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
