#!/usr/bin/env node
/**
 * .sched-run-tmp/deploy-ntc-0518-0524.js
 *
 * NTC 5/18〜5/24 反映後の生成物を GitHub(kariumu/gcg-meta main) へ push する。
 * push-rebuild-after-march-merge.js と同設計:
 *   - ローカル対象の git blob SHA を計算
 *   - GitHub HEAD tree(recursive) と照合し差分のみ push
 *   - pushFiles() は REST API 経由(ローカル .git 非依存、作業ツリーの無関係変更を巻き込まない)
 *
 * 環境変数 DRY=1 で差分一覧の表示のみ(push しない)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { githubAPI, pushFiles } = require('../git-push.js');

const ROOT = path.resolve(__dirname, '..');
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
  // series.json は説明文を更新した場合のみ含める
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
  for (const n of fs.readdirSync(eventsDir)) {
    if (n.endsWith('.html')) add('events/' + n, path.join(eventsDir, n));
  }

  // cards/*/index.html
  const cardsDir = path.join(ROOT, 'cards');
  for (const n of fs.readdirSync(cardsDir)) {
    const sub = path.join(cardsDir, n);
    if (fs.statSync(sub).isDirectory()) {
      add('cards/' + n + '/index.html', path.join(sub, 'index.html'));
    }
  }

  // ルート静的ページ + sitemap
  for (const n of ['index.html', 'events.html', 'meta.html', 'sitemap.xml']) {
    add(n, path.join(ROOT, n));
  }

  return files;
}

async function main() {
  console.log('=== deploy-ntc-0518-0524' + (DRY ? ' [DRY]' : '') + ' ===');
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
  if (tree.truncated) console.warn('  ⚠ tree truncated: 差分検出が不完全な可能性');
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
  if (toPush.length === 0) { console.log('push対象なし。終了。'); return; }

  console.log('--- push対象 ---');
  for (const f of toPush.slice(0, 60)) console.log('  ' + f.path);
  if (toPush.length > 60) console.log(`  ...他 ${toPush.length - 60} 件`);

  if (DRY) { console.log('\n[DRY] push スキップ。'); return; }

  const msg = process.env.COMMIT_MSG ||
    `data: NTC MISSION3 5/18〜5/24分反映（新規${added.length}・更新${changed.length}）`;
  const commit = await pushFiles(toPush, msg);
  console.log('=== SUCCESS ===');
  console.log('Commit: ' + commit.sha);
  console.log('URL: https://github.com/' + OWNER + '/' + REPO + '/commit/' + commit.sha);
  console.log('elapsed: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
