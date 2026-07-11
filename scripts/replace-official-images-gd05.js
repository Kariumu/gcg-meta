#!/usr/bin/env node
/**
 * scripts/replace-official-images-gd05.js  (2026-07-11)
 * GD05 全130種のカード画像を「公式カードリスト画像」で取得・差し替えする一回限りのスクリプト。
 *
 * 背景:
 *  - プレビュー期に取得した画像が images/cards/GD05-*.webp に28種分残っている。
 *  - 2026-07-10 の公式カードリスト公開に伴い、全130種を公式画像で統一する
 *    (scripts/replace-official-images.js の EB01/ST10 差し替えと同じ方針)。
 *
 * 取得元: https://www.gundam-gcg.com/jp/images/cards/card/GD05-XXX.webp
 *
 * 安全設計 (replace-official-images.js 踏襲):
 *  - --dry-run: DL/検証のみで既存ファイル変更なし
 *  - 上書き前に既存画像を tmp/cards-img-backup-20260711/ へバックアップ
 *  - 200以外 / サイズ<=1000 / webpマジック不一致は「既存維持」
 *  - 公式サーバ配慮で1件ごとに待機 (REQUEST_DELAY_MS=1500、変更禁止)
 *  - 進捗は tmp/gd05-img-manifest.json に記録し、再実行で続きから (--budget-ms 対応)
 *  - 対象は GD05-001..130 のみ。他セットには一切触れない。
 *
 * 使い方:
 *   node scripts/replace-official-images-gd05.js --dry-run
 *   node scripts/replace-official-images-gd05.js --budget-ms 35000   # 再実行で続きから
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const CARDS_DIR = path.join(ROOT, 'images', 'cards');
const BACKUP_DIR = path.join(ROOT, 'tmp', 'cards-img-backup-20260711');
const MANIFEST = path.join(ROOT, 'tmp', 'gd05-img-manifest.json');
const COUNT = 130;
const REQUEST_DELAY_MS = 1500; // 公式サーバ配慮（変更禁止）
const MIN_SIZE = 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.gundam-gcg.com/jp/';

const DRY_RUN = process.argv.includes('--dry-run');
const args = process.argv.slice(2);
const budgetArg = args.find(a => a.startsWith('--budget-ms'));
const BUDGET_MS = budgetArg ? parseInt(budgetArg.split('=')[1] || args[args.indexOf(budgetArg) + 1], 10) : 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isWebp(buf) {
  return buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
}

function downloadImage(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) { resolve({ ok: false, reason: 'too-many-redirects' }); return; }
    https.get(new URL(url), { headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        resolve(downloadImage(res.headers.location, depth + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, reason: 'http ' + res.statusCode }); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < MIN_SIZE || !isWebp(buf)) { resolve({ ok: false, reason: 'invalid (size=' + buf.length + ')' }); return; }
        resolve({ ok: true, buf, size: buf.length });
      });
    }).on('error', reject);
  });
}

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')); } catch (e) { return {}; }
}

async function main() {
  const manifest = loadManifest();
  const started = Date.now();
  let replaced = 0, added = 0, kept = 0, skipped = 0;
  if (!DRY_RUN) { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.mkdirSync(path.dirname(MANIFEST), { recursive: true }); }

  for (let i = 1; i <= COUNT; i++) {
    const id = `GD05-${String(i).padStart(3, '0')}`;
    if (manifest[id] && manifest[id].ok) { skipped++; continue; }
    if (BUDGET_MS && Date.now() - started > BUDGET_MS) {
      console.log(`[時間予算] ${BUDGET_MS}ms 到達。処理済 ${skipped + replaced + added + kept}/${COUNT} で中断(再実行で続きから)`);
      if (!DRY_RUN) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1), 'utf-8');
      return;
    }
    await sleep(REQUEST_DELAY_MS);
    const url = `https://www.gundam-gcg.com/jp/images/cards/card/${id}.webp`;
    let r;
    try { r = await downloadImage(url); } catch (e) { r = { ok: false, reason: e.message }; }
    const dest = path.join(CARDS_DIR, `${id}.webp`);
    const existed = fs.existsSync(dest);
    if (!r.ok) {
      kept++;
      console.warn(`  ✗ ${id}: 公式取得失敗(${r.reason}) → ${existed ? '既存維持' : '画像なしのまま'}`);
      manifest[id] = { ok: false, reason: r.reason };
      continue;
    }
    if (DRY_RUN) {
      console.log(`  [dry] ${id}: 公式OK (${r.size}B) → ${existed ? '差し替え予定' : '新規配置予定'}`);
      continue;
    }
    if (existed) {
      fs.copyFileSync(dest, path.join(BACKUP_DIR, `${id}.webp`));
      fs.writeFileSync(dest, r.buf);
      replaced++;
      console.log(`  ✓ ${id}: 差し替え (${r.size}B, 旧版はバックアップ済)`);
    } else {
      fs.writeFileSync(dest, r.buf);
      added++;
      console.log(`  ✓ ${id}: 新規配置 (${r.size}B)`);
    }
    manifest[id] = { ok: true, size: r.size, at: new Date().toISOString() };
  }
  if (!DRY_RUN) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1), 'utf-8');
  console.log(`\n--- 結果 --- 差し替え ${replaced} / 新規 ${added} / 既存維持(失敗) ${kept} / スキップ(処理済) ${skipped}`);
  if (replaced + added + skipped === COUNT) console.log('全130種 完了。');
}

main().catch((e) => { console.error('致命的エラー:', e.message); process.exit(1); });
// EOF
