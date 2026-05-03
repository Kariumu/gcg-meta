#!/usr/bin/env node
/**
 * 既存のshopbattle JSONから winner フィールドを削除する
 * （プライバシー配慮、Phase Y-9b）
 *
 * 使い方:
 *   node scripts/remove-winner-field.js
 *   node scripts/remove-winner-field.js --month 2026-05
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHOPBATTLE_DIR = path.join(ROOT, 'data', 'shopbattle');

function cleanFile(filePath) {
  console.log(`\n📂 ${path.basename(filePath)}`);

  const data = JSON.parse(fs.readFileSync(filePath));
  let removedWinner = 0;
  let removedUsers = 0;

  if (Array.isArray(data.events)) {
    for (const event of data.events) {
      if ('winner' in event) {
        delete event.winner;
        removedWinner++;
      }

      // rankings配列の user情報も念のため削除
      if (Array.isArray(event.rankings)) {
        event.rankings = event.rankings.map(r => {
          const cleaned = { rank: r.rank, playerCount: r.playerCount ?? (r.users?.length || 0) };
          if ('users' in r) removedUsers++;
          return cleaned;
        });
      }
    }
  }

  if (removedWinner > 0 || removedUsers > 0) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`  ✅ winner フィールドを ${removedWinner} 件から削除`);
    if (removedUsers > 0) console.log(`  ✅ users 情報を ${removedUsers} エントリから削除`);
  } else {
    console.log(`  ℹ️ winner フィールドなし（既にクリーン）`);
  }
}

function main() {
  const args = process.argv.slice(2);
  let monthLabel = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--month') monthLabel = args[i + 1];
  }

  if (monthLabel) {
    const filePath = path.join(SHOPBATTLE_DIR, `${monthLabel}.json`);
    if (fs.existsSync(filePath)) {
      cleanFile(filePath);
    } else {
      console.error(`❌ ${filePath} が見つかりません`);
      process.exit(1);
    }
  } else {
    // 全shopbattleファイルを対象
    const files = fs.readdirSync(SHOPBATTLE_DIR)
      .filter(f => /^\d{4}-\d{2}\.json$/.test(f));

    console.log(`📋 対象ファイル: ${files.length}件`);
    for (const file of files) {
      cleanFile(path.join(SHOPBATTLE_DIR, file));
    }
  }

  console.log(`\n✅ 完了`);
}

main();
