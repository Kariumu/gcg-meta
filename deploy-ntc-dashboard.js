#!/usr/bin/env node
/**
 * deploy-ntc-dashboard.js — NTC公式集計の生成物を GitHub(kariumu/gcg-meta main) へ差分push
 * 指示書63 Step 1-N §4。
 *
 * 対象3ファイル: data/ntc_dashboard.json / ntc-official.html / sitemap.xml
 *   - SHA(git blob)差分があるものだけを 1コミットで push(git-push.js の pushFiles)
 *   - deploy-results.js からは「SHA差分判定」と「REST API push」のみ踏襲する。
 *     exit(1)/exit(2) は踏襲しない: 本工程は夜間バッチ内で走るため
 *     終了コードは常に 0 固定・異常はログで判別する(指示書63 §4)。
 *
 * 使い方:
 *   node deploy-ntc-dashboard.js
 *   node deploy-ntc-dashboard.js --dry-run     # 差分一覧のみ・push無し(DRY=1 でも可)
 *   NTC_DASHBOARD_ROOT=/path/to/site node deploy-ntc-dashboard.js
 *
 * 注意: クラウド環境から実行する場合は `env -u GITHUB_TOKEN -u GH_TOKEN` を付けること
 *       (セッション既定トークンが .env を覆って401になる)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.NTC_DASHBOARD_ROOT || __dirname;
const OWNER = 'kariumu', REPO = 'gcg-meta', BRANCH = 'main';
const DRY = process.argv.includes('--dry-run') || process.env.DRY === '1';

const LOG = (...a) => console.log('[ntc-dashboard:deploy]', ...a);
const ERR = (...a) => console.error('[ntc-dashboard:deploy]', ...a);

/** UTC+9固定のJST日付(コミットメッセージ用) */
function jstDate() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function gitBlobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf-8');
  const h = crypto.createHash('sha1');
  h.update('blob ' + b.length + '\0');
  h.update(b);
  return h.digest('hex');
}

/** push候補(存在するものだけ) */
function listTargets() {
  const out = [];
  const add = (repoPath) => {
    const local = path.join(ROOT, repoPath.split('/').join(path.sep));
    if (fs.existsSync(local)) out.push({ repoPath, local });
    else LOG('  (未生成のためスキップ) ' + repoPath);
  };
  add('data/ntc_dashboard.json');
  add('ntc-official.html');
  add('sitemap.xml');
  return out;
}

async function main() {
  LOG('start' + (DRY ? ' [dry-run]' : ''));

  const targets = listTargets();
  if (targets.length === 0) { LOG('対象ファイルがありません。終了(no-op)。'); return; }

  // git-push.js は .env / 環境変数からトークンを読む。require はここで(dry-run時も同じ経路を通す)
  const { githubAPI, pushFiles } = require('./git-push.js');

  const ref = await githubAPI('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH);
  const headSha = ref.object.sha;
  const headCommit = await githubAPI('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + headSha);
  const headTreeSha = headCommit.tree.sha;
  LOG('GitHub HEAD: ' + headSha.slice(0, 7) + ' tree=' + headTreeSha.slice(0, 7));

  const tree = await githubAPI('GET',
    '/repos/' + OWNER + '/' + REPO + '/git/trees/' + headTreeSha + '?recursive=1');
  if (tree.truncated) {
    // 差分検出が不完全。安全側で push しない(ただし終了コードは0固定・ログで判別)
    ERR('tree truncated: リモートtreeを全取得できませんでした。差分検出が不完全なため push しません。');
    return;
  }
  const remoteSha = {};
  for (const it of (tree.tree || [])) if (it.type === 'blob') remoteSha[it.path] = it.sha;

  const toPush = [];
  let unchanged = 0;
  for (const t of targets) {
    const content = fs.readFileSync(t.local, 'utf-8');
    const lsha = gitBlobSha(content);
    const rsha = remoteSha[t.repoPath];
    if (!rsha) { toPush.push({ path: t.repoPath, content, state: '新規' }); }
    else if (rsha !== lsha) { toPush.push({ path: t.repoPath, content, state: '更新' }); }
    else unchanged++;
  }
  LOG('差分: push対象=' + toPush.length + ' / 同一=' + unchanged);
  for (const f of toPush) LOG('  [' + f.state + '] ' + f.path);

  if (toPush.length === 0) { LOG('push対象なし。終了(no-op)。'); return; }
  if (DRY) { LOG('[dry-run] push をスキップしました。'); return; }

  const msg = 'ntc-dashboard: ' + jstDate();
  const commit = await pushFiles(toPush.map((f) => ({ path: f.path, content: f.content })), msg);
  LOG('SUCCESS commit=' + (commit && commit.sha ? commit.sha.slice(0, 7) : '(不明)') + ' "' + msg + '"');
}

module.exports = { gitBlobSha, listTargets, jstDate };

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((e) => { ERR('FATAL: ' + (e && e.message)); process.exit(0); });
}
