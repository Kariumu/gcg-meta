#!/usr/bin/env node
// push-gd05-sc01-release v2: チェックポイント再開型 (2026-07-11)
const fs = require('fs');
const path = require('path');
const { githubAPI } = require('../git-push.js');
const ROOT = path.resolve(__dirname, '..');
const OWNER = 'kariumu', REPO = 'gcg-meta', BRANCH = 'main';
const CHUNK_BYTES = parseInt(process.env.PUSH_CHUNK_BYTES || '1500000', 10);
const DRY = process.env.DRY_RUN === '1';
const DELETIONS = ['sets/gd05.html'];
const STATE_PATH = '/tmp/push-state.json';
const T0 = Date.now();
const budgetArg = process.argv.find(a => a.startsWith('--budget-ms'));
const BUDGET_MS = budgetArg ? parseInt(budgetArg.split('=')[1] || process.argv[process.argv.indexOf(budgetArg) + 1], 10) : 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const overBudget = () => BUDGET_MS && (Date.now() - T0) > BUDGET_MS;
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ': socket timeout ' + ms + 'ms')), ms))
  ]);
}
async function api(method, url, body, label) {
  let delay = 4000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await withTimeout(githubAPI(method, url, body), 90000, label);
    } catch (e) {
      const msg = String((e && e.message) || e);
      const retryable = /403|429|502|503|secondary rate|abuse|rate limit|socket timeout|ECONNRESET|ETIMEDOUT/i.test(msg);
      if (retryable && attempt < 6) {
        console.log('  [' + label + '] 再試行' + attempt + ': ' + msg.substring(0, 70));
        await sleep(delay);
        delay = Math.min(delay * 2, 60000);
        continue;
      }
      throw new Error('[' + label + '] ' + msg);
    }
  }
}
function readList(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').map(s => s.trim()).filter(Boolean);
}
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch (e) { return null; } }
function saveState(st) { fs.writeFileSync(STATE_PATH, JSON.stringify(st)); }
function validateText(rel, content) {
  const errs = [];
  if (content.indexOf(String.fromCharCode(0)) >= 0) errs.push('NUL混入');
  if (rel.endsWith('.html') && !content.trimEnd().endsWith('</html>')) errs.push('html終端なし');
  if (rel.endsWith('.json')) { try { JSON.parse(content); } catch (e) { errs.push('JSONパース失敗'); } }
  if (rel.endsWith('.xml') && !content.trimEnd().endsWith('</urlset>')) errs.push('XML終端なし');
  if (content.length === 0) errs.push('空ファイル');
  return errs;
}
(async () => {
  const textFiles = readList('/tmp/push-list-text.txt');
  const binFiles = readList('/tmp/push-list-bin.txt');
  let st = loadState();
  if (!st) {
    console.log('push対象: テキスト ' + textFiles.length + ' / バイナリ ' + binFiles.length + ' / 削除 ' + DELETIONS.length);
    let bad = 0;
    for (const rel of textFiles) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) { console.error('  不在: ' + rel); bad++; continue; }
      const errs = validateText(rel, fs.readFileSync(p, 'utf-8'));
      if (errs.length) { console.error('  NG ' + rel + ': ' + errs.join(',')); bad++; }
    }
    for (const rel of binFiles) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) { console.error('  不在: ' + rel); bad++; continue; }
      const buf = fs.readFileSync(p);
      if (buf.length < 1000 || buf.slice(0, 4).toString('ascii') !== 'RIFF') { console.error('  NG ' + rel + ': webp異常'); bad++; }
    }
    if (bad > 0) { console.error('検証エラー ' + bad + ' 件。中止。'); process.exit(1); }
    console.log('事前検証: 全ファイルOK');
    if (DRY) { console.log('[DRY_RUN] 終了'); return; }
    const ref = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH, null, 'getRef');
    const headCommit = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + ref.object.sha, null, 'getCommit');
    st = { headSha: ref.object.sha, baseTree: headCommit.tree.sha, ti: 0, blobs: {}, binTreeDone: false };
    saveState(st);
    console.log('HEAD ' + st.headSha.substring(0, 7) + ' を親に新規開始');
  } else {
    console.log('再開: text ' + st.ti + '/' + textFiles.length + ', blobs ' + Object.keys(st.blobs).length + '/' + binFiles.length + ', binTree=' + st.binTreeDone);
  }
  if (DRY) { console.log('[DRY_RUN] state存在のため終了'); return; }
  while (st.ti < textFiles.length) {
    if (overBudget()) { console.log('[予算] text ' + st.ti + '/' + textFiles.length + ' で中断'); return; }
    const items = [];
    let bytes = 0;
    let j = st.ti;
    while (j < textFiles.length) {
      const rel = textFiles[j];
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      const sz = Buffer.byteLength(content);
      if (items.length > 0 && bytes + sz > CHUNK_BYTES) break;
      items.push({ path: rel, mode: '100644', type: 'blob', content: content });
      bytes += sz; j++;
    }
    const nt = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', { base_tree: st.baseTree, tree: items }, 'tree@' + st.ti);
    st.baseTree = nt.sha; st.ti = j;
    saveState(st);
    console.log('  text: ' + st.ti + '/' + textFiles.length + ' (' + (bytes / 1e6).toFixed(2) + 'MB)');
    await sleep(800);
  }
  for (const rel of binFiles) {
    if (st.blobs[rel]) continue;
    if (overBudget()) { console.log('[予算] blobs ' + Object.keys(st.blobs).length + '/' + binFiles.length + ' で中断'); return; }
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const blob = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', { content: buf.toString('base64'), encoding: 'base64' }, 'blob');
    st.blobs[rel] = blob.sha;
    if (Object.keys(st.blobs).length % 10 === 0) { saveState(st); console.log('  blobs: ' + Object.keys(st.blobs).length + '/' + binFiles.length); }
    await sleep(120);
  }
  saveState(st);
  if (!st.binTreeDone) {
    if (overBudget()) { console.log('[予算] bin-tree前で中断'); return; }
    const items = binFiles.map(function (rel) { return { path: rel, mode: '100644', type: 'blob', sha: st.blobs[rel] }; });
    for (const del of DELETIONS) items.push({ path: del, mode: '100644', type: 'blob', sha: null });
    for (let s = 0; s < items.length; s += 400) {
      const part = items.slice(s, s + 400);
      const nt = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', { base_tree: st.baseTree, tree: part }, 'bin-tree');
      st.baseTree = nt.sha;
      saveState(st);
      console.log('  bin-tree: +' + part.length + '件');
      await sleep(800);
    }
    st.binTreeDone = true;
    saveState(st);
  }
  const msg = process.env.COMMIT_MESSAGE || 'feat: GD05正式カードリスト反映(130種+公式画像130) + SC01パラレル45種 + GD05 LR色別考察記事5本 + プレビュー整理';
  const commit = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', { message: msg, tree: st.baseTree, parents: [st.headSha] }, 'commit');
  try {
    await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH, { sha: commit.sha, force: false }, 'updateRef');
  } catch (e) {
    if (/fast.forward|422/i.test(String(e.message))) {
      console.error('ref競合（並行push検知）。state破棄。再実行で新HEADから。');
      fs.unlinkSync(STATE_PATH);
      process.exit(2);
    }
    throw e;
  }
  fs.unlinkSync(STATE_PATH);
  console.log('push 完了: ' + commit.sha.substring(0, 7));
  console.log('PUSH_COMPLETE');
})().catch(function (e) { console.error('致命的エラー:', e.message); process.exit(1); });
