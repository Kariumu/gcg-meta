#!/usr/bin/env node
/**
 * scripts/push-rebuild-after-march-merge.js
 *
 * 3月ニュータイプチャレンジマージ後の静的HTML再生成結果を GitHub に push する。
 *
 * 設計:
 *  - 対象パス群をローカルから読み取り、git blob SHA を計算
 *  - GitHub 側の最新 tree と照合して差分のあるファイルのみ push（効率化）
 *  - pushFiles() の実体はGitHub REST API 経由なのでローカル .git は不要
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { githubAPI, pushFiles } = require('../git-push.js');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'kariumu';
const REPO = 'gcg-meta';
const BRANCH = 'main';

function gitBlobSha(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
  const header = 'blob ' + buf.length + '\0';
  const h = crypto.createHash('sha1');
  h.update(header);
  h.update(buf);
  return h.digest('hex');
}

function listLocalTargets() {
  const files = [];

  // events/*.html
  const eventsDir = path.join(ROOT, 'events');
  for (const name of fs.readdirSync(eventsDir)) {
    if (name.endsWith('.html')) {
      files.push({ repoPath: 'events/' + name, localPath: path.join(eventsDir, name) });
    }
  }

  // cards/*/index.html
  const cardsDir = path.join(ROOT, 'cards');
  for (const name of fs.readdirSync(cardsDir)) {
    const sub = path.join(cardsDir, name);
    if (fs.statSync(sub).isDirectory()) {
      const idx = path.join(sub, 'index.html');
      if (fs.existsSync(idx)) {
        files.push({ repoPath: 'cards/' + name + '/index.html', localPath: idx });
      }
    }
  }

  // ルート静的ページ
  for (const name of ['index.html', 'events.html', 'meta.html', 'cards.html', 'sitemap.xml']) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) {
      files.push({ repoPath: name, localPath: p });
    }
  }

  return files;
}

async function main() {
  console.log('=== push-rebuild-after-march-merge ===');
  const t0 = Date.now();

  // 1) ローカル対象一覧
  const local = listLocalTargets();
  console.log('ローカル対象: ' + local.length + ' ファイル');

  // 2) GitHub 最新 HEAD の tree を recursive=1 で取得
  const ref = await githubAPI('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  const headSha = ref.object.sha;
  const headCommit = await githubAPI('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + headSha);
  const headTreeSha = headCommit.tree.sha;
  console.log('GitHub HEAD: ' + headSha.substring(0, 7) + ' tree=' + headTreeSha.substring(0, 7));

  const tree = await githubAPI('GET',
    '/repos/' + OWNER + '/' + REPO + '/git/trees/' + headTreeSha + '?recursive=1');
  if (tree.truncated) {
    console.warn('  ⚠ tree が truncated。全差分検出が不完全の可能性。全件pushにフォールバック。');
  }
  const remoteShaByPath = {};
  for (const item of (tree.tree || [])) {
    if (item.type === 'blob') remoteShaByPath[item.path] = item.sha;
  }
  console.log('GitHub 側ファイル数: ' + Object.keys(remoteShaByPath).length);

  // 3) 差分検出
  const changed = [];
  const unchanged = [];
  const added = [];
  for (const f of local) {
    const content = fs.readFileSync(f.localPath, 'utf-8');
    const localSha = gitBlobSha(content);
    const remoteSha = remoteShaByPath[f.repoPath];
    if (!remoteSha) {
      added.push({ path: f.repoPath, content });
    } else if (remoteSha !== localSha) {
      changed.push({ path: f.repoPath, content });
    } else {
      unchanged.push(f.repoPath);
    }
  }
  console.log('差分検出: 新規=' + added.length + ', 更新=' + changed.length + ', 同一=' + unchanged.length);

  const toPush = added.concat(changed);
  if (toPush.length === 0) {
    console.log('push対象なし。正常終了。');
    return;
  }

  // 4) push 実行
  const msg = 'build: 3月NCマージ後の静的ページ再生成（新規' + added.length + '件・更新' + changed.length + '件）';
  console.log('pushする: ' + toPush.length + ' ファイル, message="' + msg + '"');
  const commit = await pushFiles(toPush, msg);
  console.log('=== SUCCESS ===');
  console.log('Commit: ' + commit.sha);
  console.log('URL: https://github.com/' + OWNER + '/' + REPO + '/commit/' + commit.sha);
  console.log('elapsed: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
