#!/usr/bin/env node
/**
 * 月次ショップバトル差分取得（Coworkスケジュール用）
 *
 * 当月の event-ids から、まだ取得できていない event_id を抽出して取得。
 * - 既に success のものは除外
 * - 開催日が今日より未来のものは除外
 * - 開催日が今日以前で status=pending か未取得 のものを取得
 *
 * 使い方:
 *   node scripts/monthly-shopbattle-update.js
 *   node scripts/monthly-shopbattle-update.js --month 2026-05
 *   node scripts/monthly-shopbattle-update.js --dry-run
 *   node scripts/monthly-shopbattle-update.js --force  (3日チェックをスキップ)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// シリーズID対応表
const SERIES_MAP = {
  '2026-04': '6490',
  '2026-05': '6768',
  '2026-06': '7065',
};

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function main() {
  const args = process.argv.slice(2);
  let monthLabel = null;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--month') monthLabel = args[i + 1];
    if (args[i] === '--dry-run') dryRun = true;
    if (args[i] === '--force') force = true;
  }

  if (!monthLabel) monthLabel = getCurrentMonth();

  // 3日経過チェックは廃止（毎日 cron で差分取得を進めるため）。
  // lastRunPath は最終実行日の記録用に後続処理で使用する。
  const lastRunPath = path.join(ROOT, 'data', 'shopbattle', '.last-monthly-run');

  const seriesId = SERIES_MAP[monthLabel];
  if (!seriesId) {
    console.error(`❌ 未対応の月: ${monthLabel}`);
    console.error(`   SERIES_MAP に追加してください`);
    process.exit(1);
  }

  console.log(`📅 対象月: ${monthLabel} (seriesId=${seriesId})`);

  // 1. event-ids.json を読み込み
  const eventIdsPath = path.join(ROOT, 'data', 'shopbattle', `${monthLabel}-sb-event-ids.json`);
  if (!fs.existsSync(eventIdsPath)) {
    console.error(`❌ event-ids が見つかりません: ${eventIdsPath}`);
    console.error(`   先に fetch-organizer-events.js で event_id を収集してください`);
    process.exit(1);
  }
  const allEventIds = JSON.parse(fs.readFileSync(eventIdsPath));
  console.log(`📋 全event_id: ${allEventIds.length}件`);

  // 2. 既存の取得結果を読み込み
  const existingPath = path.join(ROOT, 'data', 'shopbattle', `${monthLabel}.json`);
  let existingEvents = [];
  let successIds = new Set();
  let pendingIds = new Set();

  if (fs.existsSync(existingPath)) {
    const existing = JSON.parse(fs.readFileSync(existingPath));
    existingEvents = existing.events || [];
    for (const e of existingEvents) {
      if (e.status === 'success') successIds.add(e.eventId);
      else if (e.status === 'pending') pendingIds.add(e.eventId);
    }
    console.log(`📂 既存データ: success=${successIds.size}件, pending=${pendingIds.size}件`);
  }

  // 3. 取得対象の event_id を抽出
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const eventDateMap = new Map();
  for (const e of existingEvents) {
    if (e.eventId && e.startDatetime) {
      eventDateMap.set(e.eventId, new Date(e.startDatetime));
    }
  }

  const targetIds = [];
  let skippedFuture = 0;
  let skippedSuccess = 0;

  for (const eventId of allEventIds) {
    if (successIds.has(eventId)) { skippedSuccess++; continue; }
    const startDate = eventDateMap.get(eventId);
    if (startDate && startDate > today) { skippedFuture++; continue; }
    targetIds.push(eventId);
  }

  console.log(`\n=== 取得対象抽出結果 ===`);
  console.log(`  全event_id: ${allEventIds.length}件`);
  console.log(`  すでにsuccess (除外): ${skippedSuccess}件`);
  console.log(`  未来開催 (除外): ${skippedFuture}件`);
  console.log(`  → 取得対象: ${targetIds.length}件`);
  console.log(`  想定時間: ${Math.round(targetIds.length * 6 / 60)}分（6秒/件）`);

  if (targetIds.length === 0) {
    console.log(`\n✅ 取得対象なし。終了。`);
    if (!dryRun) fs.writeFileSync(lastRunPath, new Date().toISOString());
    return;
  }

  if (dryRun) {
    console.log(`\n[dry-run] 実行をスキップしました`);
    return;
  }

  // 4. 既存JSONから対象pendingエントリを除去（再取得させるため）
  const targetIdSet = new Set(targetIds);
  const filteredEvents = existingEvents.filter(e => !targetIdSet.has(e.eventId));
  const existingBackup = existingPath + '.bak';
  fs.copyFileSync(existingPath, existingBackup);
  fs.writeFileSync(existingPath, JSON.stringify({ events: filteredEvents }, null, 2));
  console.log(`\n📝 対象${targetIds.length}件のpendingを既存JSONから一時除去`);

  // 5. 取得対象IDを一時ファイルに保存
  const tempIdsPath = path.join('/tmp', `monthly-update-${monthLabel}-${Date.now()}.json`);
  fs.writeFileSync(tempIdsPath, JSON.stringify(targetIds, null, 2));

  // 6. fetch-shopbattle-by-ids.js を実行（既存JSONにpendingがないので自然に再取得される）
  console.log(`🚀 取得開始...`);
  try {
    execSync(
      `node ${path.join(ROOT, 'scripts', 'fetch-shopbattle-by-ids.js')} ` +
      `--ids ${tempIdsPath} --month ${monthLabel} --series ${seriesId}`,
      { stdio: 'inherit' }  // タイムアウト指定なし（最後まで取得させる）
    );
  } catch (err) {
    console.warn(`\n⚠️ 取得中にタイムアウトまたはエラー: ${err.message}`);
    console.log(`差分取得対応のため、再実行で続きから取得可能です`);
  }

  // バックアップ削除
  try { fs.unlinkSync(existingBackup); } catch (e) {}

  // 6. 最終結果のサマリ
  let newSuccess = successIds.size;
  if (fs.existsSync(existingPath)) {
    const updated = JSON.parse(fs.readFileSync(existingPath));
    const updatedEvents = updated.events || [];
    newSuccess = updatedEvents.filter(e => e.status === 'success').length;
    const newPending = updatedEvents.filter(e => e.status === 'pending').length;

    console.log(`\n=== 取得完了 ===`);
    console.log(`  success: ${successIds.size} → ${newSuccess}件 (+${newSuccess - successIds.size})`);
    console.log(`  pending: ${pendingIds.size} → ${newPending}件`);
    console.log(`  取得率: ${(newSuccess / allEventIds.length * 100).toFixed(1)}%`);

    // 7. 変更があれば git push（git-push.js使用）
    if (newSuccess > successIds.size) {
      console.log(`\n📤 GitHubへ自動push...`);
      try {
        const { pushFiles } = require(path.join(ROOT, 'git-push'));
        const content = fs.readFileSync(existingPath, 'utf-8');
        pushFiles(
          [{ path: `data/shopbattle/${monthLabel}.json`, content }],
          `chore: 月次SB差分取得 ${monthLabel} (success +${newSuccess - successIds.size}件, 合計${newSuccess}/${allEventIds.length})`
        ).then(r => {
          console.log(`✅ push完了: ${r.sha}`);
        }).catch(e => {
          console.warn(`⚠️ push失敗: ${e.message}`);
        });
      } catch (err) {
        console.warn(`⚠️ git push失敗: ${err.message}`);
      }
    }
  }

  // 最終実行日を記録
  fs.writeFileSync(lastRunPath, new Date().toISOString());

  // ログ記録
  const logPath = path.join(ROOT, 'data', 'shopbattle', `.run-log-${monthLabel}.txt`);
  const logEntry = `${new Date().toISOString()}: +${newSuccess - successIds.size}件, 合計${newSuccess}/${allEventIds.length} (${(newSuccess / allEventIds.length * 100).toFixed(1)}%)\n`;
  fs.appendFileSync(logPath, logEntry);

  // 一時ファイル削除
  try { fs.unlinkSync(tempIdsPath); } catch (e) {}
}

main();
