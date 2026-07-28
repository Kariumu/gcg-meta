#!/usr/bin/env node
/**
 * scripts/push-gd05-reprint-20260728.js  (2026-07-28)
 * GD05再録パラレル8種の反映を GitHub(kariumu/gcg-meta, main) へ push する。
 *
 * 設計:
 *  - 候補ファイルを列挙 → git blob SHA をローカル計算 → GitHub の tree と突合し、
 *    「新規」「変更あり」のみを push 対象にする（scripts/rebuild-push-step1-diff.js と同方式）。
 *    無関係なファイルを巻き込まないよう、候補は本変更が影響し得る範囲に限定する。
 *  - push は チャンク分割＋チェックポイント再開型（scripts/push-gd05-sc01-release.js と同方式）。
 *    中断しても再実行で続きから。DELETIONS は無し（削除ファイルなし）。
 *  - 事前検証: HTML終端 / JSONパース / XML終端 / NUL混入 / 空ファイル / webp署名。
 *
 * 使い方（E:\GCGSTATS）:
 *   node scripts\push-gd05-reprint-20260728.js --dry-run    # 差分の列挙のみ（push しない）
 *   node scripts\push-gd05-reprint-20260728.js              # push 実行
 *   node scripts\push-gd05-reprint-20260728.js --budget-ms 240000   # 時間予算つき（再実行で続きから）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { githubAPI } = require('../git-push.js');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'kariumu', REPO = 'gcg-meta', BRANCH = 'main';
const STATE_PATH = path.join(ROOT, 'tmp', 'push-gd05-reprint-state.json');
const CHUNK_BYTES = parseInt(process.env.PUSH_CHUNK_BYTES || '1500000', 10);
const COMMIT_MESSAGE = process.env.COMMIT_MESSAGE
  || 'fix: GD05収録の再録パラレル8種を反映（公式カードリストとの突合で未登録を検出）';

const NEW_IDS = ['ST01-010_p4', 'ST01-011_p5', 'ST02-010_p5', 'ST03-010_p2', 'ST03-011_p4', 'ST04-010_p6', 'ST07-009_p3', 'GD01-093_p2'];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || process.env.DRY_RUN === '1';
const budgetArg = args.find((a) => a.startsWith('--budget-ms'));
const BUDGET_MS = budgetArg ? parseInt(budgetArg.split('=')[1] || args[args.indexOf(budgetArg) + 1], 10) : 0;
const T0 = Date.now();
const overBudget = () => BUDGET_MS && (Date.now() - T0) > BUDGET_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gitBlobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf-8');
  const h = crypto.createHash('sha1');
  h.update('blob ' + b.length + '\0');
  h.update(b);
  return h.digest('hex');
}

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ': socket timeout ' + ms + 'ms')), ms))]);
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
        await sleep(delay); delay = Math.min(delay * 2, 60000); continue;
      }
      throw new Error('[' + label + '] ' + msg);
    }
  }
}

/** 本変更が影響し得る範囲のみを候補にする（無関係ファイルの巻き込み防止） */
function listCandidates() {
  const text = [], bin = [];
  for (const rel of ['data/cards_master.json', 'cards.html', 'deck-builder.html', 'sitemap.xml', 'scripts/fetch-gd05-reprint-parallels.js', 'scripts/push-gd05-reprint-20260728.js']) {
    if (fs.existsSync(path.join(ROOT, rel))) text.push(rel);
  }
  // 【2026-07-28 修正】ディスク上の全ディレクトリではなく cards_master.json のキーで絞る。
  // 旧版はディスク走査だったため、マスタ未登録の残骸ページ9件（OCR誤認識由来の不正ID）を
  // 公開リポジトリへ巻き込んで push してしまった。マスタが正であり、ページの正当性はマスタで判定する。
  const master = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cards_master.json'), 'utf-8'));
  const cardsDir = path.join(ROOT, 'cards');
  const skipped = [];
  for (const name of fs.readdirSync(cardsDir)) {
    const idx = path.join(cardsDir, name, 'index.html');
    if (!fs.existsSync(idx)) continue;
    if (!master[name]) { skipped.push(name); continue; }
    text.push('cards/' + name + '/index.html');
  }
  if (skipped.length) console.log('マスタ未登録のため候補から除外: ' + skipped.length + '件 → ' + skipped.join(', '));
  for (const id of NEW_IDS) {
    const rel = 'images/cards/' + id + '.webp';
    if (fs.existsSync(path.join(ROOT, rel))) bin.push(rel);
  }
  return { text, bin };
}

function validate(rel, isBin) {
  const p = path.join(ROOT, rel);
  const errs = [];
  if (isBin) {
    const buf = fs.readFileSync(p);
    if (buf.length < 1000) errs.push('サイズ異常(' + buf.length + ')');
    if (buf.slice(0, 4).toString('ascii') !== 'RIFF' || buf.slice(8, 12).toString('ascii') !== 'WEBP') errs.push('webp署名不正');
    return errs;
  }
  const c = fs.readFileSync(p, 'utf-8');
  if (c.length === 0) errs.push('空ファイル');
  if (c.indexOf(String.fromCharCode(0)) >= 0) errs.push('NUL混入');
  if (rel.endsWith('.html') && !c.trimEnd().endsWith('</html>')) errs.push('html終端なし');
  if (rel.endsWith('.json')) { try { JSON.parse(c); } catch (e) { errs.push('JSONパース失敗'); } }
  if (rel.endsWith('.xml') && !c.trimEnd().endsWith('</urlset>')) errs.push('XML終端なし');
  return errs;
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch (e) { return null; } }
function saveState(st) { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(st)); }

(async () => {
  let st = loadState();

  if (!st) {
    const cand = listCandidates();
    console.log('候補: テキスト ' + cand.text.length + ' / バイナリ ' + cand.bin.length);

    const ref = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH, null, 'getRef');
    const head = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + ref.object.sha, null, 'getCommit');
    const tree = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/trees/' + head.tree.sha + '?recursive=1', null, 'getTree');
    if (tree.truncated) { console.error('中止: GitHub tree が truncated（候補列挙方式を見直す必要あり）'); process.exit(1); }
    const remote = {};
    for (const it of (tree.tree || [])) if (it.type === 'blob') remote[it.path] = it.sha;
    console.log('HEAD ' + ref.object.sha.substring(0, 7) + ' / リモート ' + Object.keys(remote).length + ' ファイル');

    const pick = (list, isBin) => {
      const added = [], changed = [];
      for (const rel of list) {
        const sha = gitBlobSha(fs.readFileSync(path.join(ROOT, rel)));
        if (!remote[rel]) added.push(rel);
        else if (remote[rel] !== sha) changed.push(rel);
      }
      return { added, changed, all: added.concat(changed) };
    };
    const t = pick(cand.text, false), b = pick(cand.bin, true);

    console.log('\n--- 差分 ---');
    console.log('テキスト: 新規 ' + t.added.length + ' / 変更 ' + t.changed.length + ' (対象外 ' + (cand.text.length - t.all.length) + ')');
    console.log('バイナリ: 新規 ' + b.added.length + ' / 変更 ' + b.changed.length + ' (対象外 ' + (cand.bin.length - b.all.length) + ')');
    for (const rel of t.added) console.log('  + ' + rel);
    for (const rel of t.changed) console.log('  M ' + rel);
    for (const rel of b.added) console.log('  + ' + rel + ' (bin)');
    for (const rel of b.changed) console.log('  M ' + rel + ' (bin)');

    if (t.all.length === 0 && b.all.length === 0) { console.log('\n差分なし。push 不要です。'); return; }

    let bad = 0;
    for (const rel of t.all) { const e = validate(rel, false); if (e.length) { console.error('  NG ' + rel + ': ' + e.join(',')); bad++; } }
    for (const rel of b.all) { const e = validate(rel, true); if (e.length) { console.error('  NG ' + rel + ': ' + e.join(',')); bad++; } }
    if (bad) { console.error('\n事前検証エラー ' + bad + ' 件。中止。'); process.exit(1); }
    console.log('事前検証: 全ファイルOK');

    if (DRY_RUN) { console.log('\n[dry-run] ここで終了。push は行っていません。'); return; }

    st = { headSha: ref.object.sha, baseTree: head.tree.sha, textFiles: t.all, binFiles: b.all, ti: 0, blobs: {}, binTreeDone: false };
    saveState(st);
    console.log('\nHEAD ' + st.headSha.substring(0, 7) + ' を親に push 開始');
  } else {
    console.log('再開: text ' + st.ti + '/' + st.textFiles.length + ' / blobs ' + Object.keys(st.blobs).length + '/' + st.binFiles.length + ' / binTree=' + st.binTreeDone);
    if (DRY_RUN) { console.log('[dry-run] 中断中の state があります。終了。'); return; }
  }

  while (st.ti < st.textFiles.length) {
    if (overBudget()) { console.log('[予算] text ' + st.ti + '/' + st.textFiles.length + ' で中断（再実行で続きから）'); return; }
    const items = []; let bytes = 0, j = st.ti;
    while (j < st.textFiles.length) {
      const rel = st.textFiles[j];
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      const sz = Buffer.byteLength(content);
      if (items.length > 0 && bytes + sz > CHUNK_BYTES) break;
      items.push({ path: rel, mode: '100644', type: 'blob', content });
      bytes += sz; j++;
    }
    const nt = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', { base_tree: st.baseTree, tree: items }, 'tree@' + st.ti);
    st.baseTree = nt.sha; st.ti = j; saveState(st);
    console.log('  text: ' + st.ti + '/' + st.textFiles.length + ' (' + (bytes / 1e6).toFixed(2) + 'MB)');
    await sleep(800);
  }

  for (const rel of st.binFiles) {
    if (st.blobs[rel]) continue;
    if (overBudget()) { console.log('[予算] blobs ' + Object.keys(st.blobs).length + '/' + st.binFiles.length + ' で中断'); return; }
    const buf = fs.readFileSync(path.join(ROOT, rel));
    const blob = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', { content: buf.toString('base64'), encoding: 'base64' }, 'blob');
    st.blobs[rel] = blob.sha; saveState(st);
    console.log('  blob: ' + rel + ' (' + buf.length + 'B)');
    await sleep(150);
  }

  if (!st.binTreeDone && st.binFiles.length) {
    if (overBudget()) { console.log('[予算] bin-tree前で中断'); return; }
    const items = st.binFiles.map((rel) => ({ path: rel, mode: '100644', type: 'blob', sha: st.blobs[rel] }));
    const nt = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', { base_tree: st.baseTree, tree: items }, 'bin-tree');
    st.baseTree = nt.sha; st.binTreeDone = true; saveState(st);
    console.log('  bin-tree: +' + items.length + '件');
  }

  const commit = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', { message: COMMIT_MESSAGE, tree: st.baseTree, parents: [st.headSha] }, 'commit');
  try {
    await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + BRANCH, { sha: commit.sha, force: false }, 'updateRef');
  } catch (e) {
    if (/fast.forward|422/i.test(String(e.message))) {
      console.error('ref競合（並行push検知）。state を破棄します。再実行で新HEADから再計算されます。');
      try { fs.unlinkSync(STATE_PATH); } catch (x) {}
      process.exit(2);
    }
    throw e;
  }
  try { fs.unlinkSync(STATE_PATH); } catch (x) {}
  console.log('\npush 完了: ' + commit.sha.substring(0, 7));
  console.log('  ' + COMMIT_MESSAGE);
  console.log('PUSH_COMPLETE');
})().catch((e) => { console.error('致命的エラー:', e.message); process.exit(1); });
// EOF
