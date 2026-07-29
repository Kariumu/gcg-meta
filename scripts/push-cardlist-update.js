#!/usr/bin/env node
/**
 * scripts/push-cardlist-update.js  (2026-07-28)
 * カードデータ更新（マスタ追加・ページ再生成）の成果物を GitHub(kariumu/gcg-meta, main) へ push する汎用スクリプト。
 * 2026-07-28 の一度きりの push-gd05-reprint-20260728.js を一般化し、事故の再発防止策を組み込んだもの。
 *
 * 【この設計になった経緯】
 *  2026-07-28、cards/ 配下のディスク上の全ディレクトリを push 候補にした結果、cards_master.json に
 *  存在しない残骸ページ9件（OCR誤認識由来の不正ID）を公開してしまった（commit 8dfbcd3 → deb7f08 で削除）。
 *  また差分件数が想定（約45件）を大きく超えていた（実際は追加27・変更694）にもかかわらず、
 *  そのまま push まで進めてしまった。本スクリプトは次の2点でこれを防ぐ。
 *   (1) 候補は cards_master.json のキー＋ data/preview_card_pages.json の許可リストに限定する
 *       （ディスク走査ではなくマスタが正。不正IDは構造的に候補へ入らない）
 *       許可リストは data/cards_preview.json（自動蓄積）と data/preview_card_pages.json（手動例外）の和集合
 *   (2) push 対象が --max（既定200）を超えたら自動停止する。続行には --force-count が必要
 *
 * 【処理】
 *  候補列挙 → git blob SHA をローカル計算 → GitHub の tree と突合 → 新規/変更のみを push。
 *  push はチャンク分割＋チェックポイント再開型（中断しても再実行で続きから）。
 *  事前検証: HTML終端 / JSONパース / XML終端 / NUL混入 / 空ファイル / webp署名。
 *
 * 【対象】
 *  - data/cards_master.json, data/preview_card_pages.json, data/cards_preview.json
 *  - cards.html, deck-builder.html, sitemap.xml
 *  - cards/<id>/index.html （id は master のキー ∪ 許可リストのプレビューID）
 *  - images/cards/<id>.webp （同上）
 *  - images/ogp/*.png （記事のOGP画像。全件を候補にし、差分のあるものだけ push）
 *  - --extra=... で明示指定したファイル（スクリプト等。既定では対象外＝無関係なローカル編集を巻き込まない）
 *
 * 【使い方】（E:\GCGSTATS）
 *   node scripts\push-cardlist-update.js --dry-run
 *   node scripts\push-cardlist-update.js --message "fix: ..." --extra=scripts/foo.js
 *   node scripts\push-cardlist-update.js --force-count      # 200件超を承知で続行
 *   node scripts\push-cardlist-update.js --budget-ms 240000 # 時間予算（再実行で続きから）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { githubAPI } = require('../git-push.js');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'kariumu', REPO = 'gcg-meta', BRANCH = 'main';
const MASTER_PATH = path.join(ROOT, 'data', 'cards_master.json');
const ALLOW_PATH = path.join(ROOT, 'data', 'preview_card_pages.json');
const PREVIEW_DATA_PATH = path.join(ROOT, 'data', 'cards_preview.json');
const STATE_PATH = path.join(ROOT, 'tmp', 'push-cardlist-state.json');
const CHUNK_BYTES = parseInt(process.env.PUSH_CHUNK_BYTES || '1500000', 10);
/** バイナリとして送るファイルの拡張子 */
const BINARY_EXT = /\.(webp|png|jpe?g|gif|ico)$/i;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || process.env.DRY_RUN === '1';
const FORCE_COUNT = args.includes('--force-count');
const getVal = (name, def) => {
  const a = args.find((x) => x.startsWith(name + '='));
  if (a) return a.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const MAX_FILES = parseInt(getVal('--max', '200'), 10);
const BUDGET_MS = parseInt(getVal('--budget-ms', '0'), 10);
const EXTRA = (getVal('--extra', '') || '').split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
const COMMIT_MESSAGE = getVal('--message', process.env.COMMIT_MESSAGE || 'chore: カードデータ更新とページ再生成');

const T0 = Date.now();
const overBudget = () => BUDGET_MS && (Date.now() - T0) > BUDGET_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gitBlobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf-8');
  const h = crypto.createHash('sha1');
  h.update('blob ' + b.length + '\0'); h.update(b);
  return h.digest('hex');
}
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

function listCandidates() {
  const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf-8'));
  // 正当なページIDは3系統の和集合。scripts/check-official-cardlist-sync.js と同じ判定にする。
  //  (1) cards_master.json のキー
  //  (2) data/cards_preview.json のキー（auto-news.js が公式Xの新カード紹介から自動蓄積）
  //  (3) data/preview_card_pages.json の preview_pages（手動の例外リスト）
  const preview = new Set();
  if (fs.existsSync(PREVIEW_DATA_PATH)) {
    try { Object.keys(JSON.parse(fs.readFileSync(PREVIEW_DATA_PATH, 'utf-8'))).forEach((id) => preview.add(id)); }
    catch (e) { console.warn('  警告: data/cards_preview.json を読めません: ' + e.message); }
  }
  if (fs.existsSync(ALLOW_PATH)) {
    (JSON.parse(fs.readFileSync(ALLOW_PATH, 'utf-8')).preview_pages || []).forEach((p) => preview.add(p.id));
  }
  const validIds = new Set([...Object.keys(master), ...preview]);

  const text = [], bin = [];
  for (const rel of ['data/cards_master.json', 'data/preview_card_pages.json', 'data/cards_preview.json', 'cards.html', 'deck-builder.html', 'sitemap.xml']) {
    if (fs.existsSync(path.join(ROOT, rel))) text.push(rel);
  }
  // --extra は拡張子でテキスト/バイナリを振り分ける。
  // 画像をテキストとして送るとバイナリが壊れるため（2026-07-29 修正）。
  for (const rel of EXTRA) {
    if (!fs.existsSync(path.join(ROOT, rel))) { console.warn('  警告: --extra で指定された ' + rel + ' が見つかりません'); continue; }
    (BINARY_EXT.test(rel) ? bin : text).push(rel);
  }
  const cardsDir = path.join(ROOT, 'cards');
  const skipped = [];
  if (fs.existsSync(cardsDir)) {
    for (const name of fs.readdirSync(cardsDir)) {
      if (!fs.existsSync(path.join(cardsDir, name, 'index.html'))) continue;
      if (!validIds.has(name)) { skipped.push(name); continue; }
      text.push('cards/' + name + '/index.html');
    }
  }
  for (const id of validIds) {
    const rel = 'images/cards/' + id + '.webp';
    if (fs.existsSync(path.join(ROOT, rel))) bin.push(rel);
  }
  // OGP画像（記事のog:imageが参照する。2026-07-29 に候補へ追加）
  const ogpDir = path.join(ROOT, 'images', 'ogp');
  if (fs.existsSync(ogpDir)) {
    for (const name of fs.readdirSync(ogpDir)) {
      if (BINARY_EXT.test(name)) bin.push('images/ogp/' + name);
    }
  }
  return { text, bin, skipped, masterCount: Object.keys(master).length, previewCount: preview.size };
}

function validate(rel, isBin) {
  const p = path.join(ROOT, rel); const errs = [];
  if (isBin) {
    const b = fs.readFileSync(p);
    if (b.length < 1000) errs.push('サイズ異常(' + b.length + ')');
    if (/\.webp$/i.test(rel)) {
      if (b.slice(0, 4).toString('ascii') !== 'RIFF' || b.slice(8, 12).toString('ascii') !== 'WEBP') errs.push('webp署名不正');
    } else if (/\.png$/i.test(rel)) {
      if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') errs.push('png署名不正');
    }
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
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); } catch (e) { return null; } };
const saveState = (st) => { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(st)); };

(async () => {
  let st = loadState();

  if (!st) {
    const cand = listCandidates();
    console.log('候補: テキスト ' + cand.text.length + ' / バイナリ ' + cand.bin.length
      + '（master ' + cand.masterCount + ' + プレビュー許可 ' + cand.previewCount + '）');
    if (cand.skipped.length) {
      console.log('マスタ・許可リストのどちらにも無いため候補から除外: ' + cand.skipped.length + '件 → ' + cand.skipped.join(', '));
      console.log('  ※ 意図的な公開ページなら data/preview_card_pages.json に追記してください');
    }

    const ref = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + BRANCH, null, 'getRef');
    const head = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + ref.object.sha, null, 'getCommit');
    const tree = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/trees/' + head.tree.sha + '?recursive=1', null, 'getTree');
    if (tree.truncated) { console.error('中止: GitHub tree が truncated'); process.exit(1); }
    const remote = {};
    for (const it of (tree.tree || [])) if (it.type === 'blob') remote[it.path] = it.sha;
    console.log('HEAD ' + ref.object.sha.substring(0, 7) + ' / リモート ' + Object.keys(remote).length + ' ファイル');

    const pick = (list) => {
      const added = [], changed = [];
      for (const rel of list) {
        const sha = gitBlobSha(fs.readFileSync(path.join(ROOT, rel)));
        if (!remote[rel]) added.push(rel); else if (remote[rel] !== sha) changed.push(rel);
      }
      return { added, changed, all: added.concat(changed) };
    };
    const t = pick(cand.text), b = pick(cand.bin);
    const total = t.all.length + b.all.length;

    console.log('\n--- 差分 ---');
    console.log('テキスト: 新規 ' + t.added.length + ' / 変更 ' + t.changed.length);
    console.log('バイナリ: 新規 ' + b.added.length + ' / 変更 ' + b.changed.length);
    const show = (arr, mark) => { for (const rel of arr.slice(0, 40)) console.log('  ' + mark + ' ' + rel); if (arr.length > 40) console.log('  ...他 ' + (arr.length - 40) + ' 件'); };
    show(t.added, '+'); show(b.added, '+'); show(t.changed, 'M'); show(b.changed, 'M');

    if (total === 0) { console.log('\n差分なし。push 不要です。'); return; }

    if (total > MAX_FILES && !FORCE_COUNT) {
      console.error('\n★中止: push 対象 ' + total + ' 件が上限 ' + MAX_FILES + ' 件を超えています。');
      console.error('  意図した変更かを確認してください（無関係なローカル差分が混ざっていないか）。');
      console.error('  承知のうえ続行する場合は --force-count を付けて再実行してください。');
      process.exit(1);
    }

    let bad = 0;
    for (const rel of t.all) { const e = validate(rel, false); if (e.length) { console.error('  NG ' + rel + ': ' + e.join(',')); bad++; } }
    for (const rel of b.all) { const e = validate(rel, true); if (e.length) { console.error('  NG ' + rel + ': ' + e.join(',')); bad++; } }
    if (bad) { console.error('\n事前検証エラー ' + bad + ' 件。中止。'); process.exit(1); }
    console.log('事前検証: 全 ' + total + ' ファイルOK');

    if (DRY_RUN) { console.log('\n[dry-run] ここで終了。push は行っていません。'); return; }

    st = { headSha: ref.object.sha, baseTree: head.tree.sha, textFiles: t.all, binFiles: b.all, ti: 0, blobs: {}, binTreeDone: false, message: COMMIT_MESSAGE };
    saveState(st);
    console.log('\nHEAD ' + st.headSha.substring(0, 7) + ' を親に push 開始');
  } else {
    console.log('再開: text ' + st.ti + '/' + st.textFiles.length + ' / blobs ' + Object.keys(st.blobs).length + '/' + st.binFiles.length);
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
      items.push({ path: rel, mode: '100644', type: 'blob', content }); bytes += sz; j++;
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
    for (let s = 0; s < items.length; s += 400) {
      const nt = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', { base_tree: st.baseTree, tree: items.slice(s, s + 400) }, 'bin-tree');
      st.baseTree = nt.sha; saveState(st);
    }
    st.binTreeDone = true; saveState(st);
    console.log('  bin-tree: +' + items.length + '件');
  }

  const commit = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', { message: st.message || COMMIT_MESSAGE, tree: st.baseTree, parents: [st.headSha] }, 'commit');
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
  console.log('  ' + (st.message || COMMIT_MESSAGE));
  console.log('PUSH_COMPLETE');
})().catch((e) => { console.error('致命的エラー:', e.message); process.exit(1); });
// EOF
