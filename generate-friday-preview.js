#!/usr/bin/env node
/**
 * generate-friday-preview.js  ―  金曜プレビューの素材生成（指示書68 §2-B）
 *
 * 木曜（JST）の夜間バッチから1工程として呼ばれ、翌日の金曜13:00に手で予約するための
 * 素材（画像 + 文面 + 予約手順）を出力する。**X には一切投稿しない。**
 *
 *   node generate-friday-preview.js                 # 通常（木曜以外は即スキップ）
 *   node generate-friday-preview.js --dry-run       # 出力0件。集計と文面の確認のみ
 *   node generate-friday-preview.js --date 2026-08-13
 *
 * 時刻源について（指示書68 発行元の指摘 2026-08-07）:
 *   「今日」の決め方は **1系統だけ**にする。分裂させると窓ずれ事故の芽になる。
 *   - 入力は `process.argv` の `--date` か、無ければ JST の現在日。この2つだけ
 *   - JST 現在日の式は post-x-daily.js:123-126 の getTodayJst() と**同一**
 *     （`new Date(Date.now() + 9h).toISOString().slice(0,10)`）
 *   - post-x-daily.js も同じ argv から `--date` を読むが、その値（FIXED_DATE）が
 *     使われるのは post-x-daily の main() の中だけで、**require 時には実行されない**。
 *     本スクリプトは post-x-daily から `weightedLength`（純関数）しか使わない
 *   - `--date` の**重複指定は拒否**する。post-x-daily の argValue() は最初の1つを、
 *     こちらのパーサは最後の1つを採るため、重複を許すと両者の「今日」がずれる
 *
 * 設計上の鉄則（指示書68 §2-B/§5）:
 *   - **X 投稿・メディアアップロードへ到達する経路を持たない**
 *   - 窓 = 前週金曜 〜 当週木曜（実行日）。集計は data/events_index.json で完結
 *   - **木曜以外は即スキップ**（ログのみ）
 *   - イベント0の週は生成をスキップ（ログのみ）
 *   - 出力先が既に存在する場合は**上書きせずエラー**（RC に記録するが exit は 0）
 *   - **exit code は常に 0**（夜間バッチのタスク成否を左右しない。RC はログに残す）
 *   - **状態ファイル（post-x-daily の state）には一切触らない**
 *   - 生成物は push 対象外（tmp\ 配下）
 *
 * 作成: 2026-08-07（指示書68 実装セッション）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_BASE = path.join(ROOT, 'tmp', 'x-weekly-pack');
const PLANNED_TIME = '13:00';
const MAX_WEIGHTED = 280;

// -------------------------------------------------------------------
// 引数（post-x-daily.js を require する前に自分で検証する）
//   post-x-daily.js は require 時に自プロセスの argv を解釈する。--dry-run / --date は
//   同名・同義なので競合しないが、不正値のまま渡すと向こうで静かに終了してしまう。
// -------------------------------------------------------------------
const KNOWN_FLAGS = ['--help', '--dry-run'];
const KNOWN_OPTS = ['--date', '--out'];

function parseArgs(argv) {
  const out = { flags: {}, opts: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error('引数の解釈に失敗しました（値だけが置かれています）: ' + a);
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : null;
    // 重複指定を拒否する。post-x-daily.js の argValue() は最初の1つを採るため、
    // こちらが最後の1つを採ると「今日」が2系統に分裂する（時刻源の一本化）。
    if (out.flags[name] !== undefined || out.opts[name] !== undefined) {
      throw new Error(name + ' が複数回指定されています（1回だけ指定してください）');
    }
    if (KNOWN_FLAGS.includes(name)) { out.flags[name] = true; continue; }
    if (KNOWN_OPTS.includes(name)) {
      let v = inline;
      if (v === null) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) throw new Error(name + ' には値が必要です');
        v = next; i++;
      }
      out.opts[name] = v;
      continue;
    }
    throw new Error('未知のオプションです: ' + name
      + '（使えるのは ' + KNOWN_FLAGS.concat(KNOWN_OPTS).join(' / ') + '）');
  }
  return out;
}

const USAGE = [
  'generate-friday-preview.js ― 金曜プレビューの素材生成（指示書68 §2-B）',
  '',
  '  node generate-friday-preview.js [--date YYYY-MM-DD] [--out <dir>] [--dry-run]',
  '',
  '  --date       基準日（既定: 実行日 JST）。木曜以外はスキップします',
  '  --out        出力先（既定: tmp\\x-weekly-pack\\friday-<金曜日付>）',
  '  --dry-run    集計と文面を表示するだけ。ファイル出力 0 件',
  '',
  '  ※ X への投稿は行いません（投稿経路を持ちません）。素材を作るだけです',
  '  ※ 終了コードは常に 0 です（夜間バッチの成否を左右しません）'
].join('\n');

// -------------------------------------------------------------------
// ログ（RC を最後に1行で出す。バッチはこの行を拾う）
// -------------------------------------------------------------------
const RC = { OK: 0, SKIP_NOT_THURSDAY: 10, SKIP_NO_EVENTS: 11, ERR_OUT_EXISTS: 20, ERR: 30 };
function log(m) { console.log('[generate-friday-preview] ' + m); }
function warn(m) { log('*** 警告 *** ' + m); }
function err(m) { log('*** ERROR *** ' + m); }

// -------------------------------------------------------------------
// 本体
// -------------------------------------------------------------------
async function run(args) {
  const banner = require('./x-weekly-banner.js');
  const dryRun = !!args.flags['--dry-run'];

  // 基準日
  // 「今日」はここでしか決めない（時刻源の一本化）。
  // 式は post-x-daily.js:125 の getTodayJst() と同一にすること。
  let today = args.opts['--date'];
  if (today === undefined) {
    today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);   // JST
  } else if (!banner.isDateStr(today)) {
    err('--date の形式が不正です（YYYY-MM-DD）: ' + today);
    return RC.ERR;
  }

  const dow = banner.dayOfWeek(today);
  log('基準日(JST) ' + today + '（' + ['日', '月', '火', '水', '木', '金', '土'][dow] + '）'
    + (dryRun ? ' *** DRY-RUN ***' : ''));

  // --- 木曜以外は即スキップ ---
  if (dow !== 4) {
    log('木曜ではないためスキップします（この工程は木曜だけ動きます）');
    return RC.SKIP_NOT_THURSDAY;
  }

  const friday = banner.addDays(today, 1);
  const win = banner.windowFriday(today);
  log('窓: ' + win.from + '〜' + win.to + '（前週金曜〜当週木曜）/ 投稿予定 ' + friday + ' ' + PLANNED_TIME);

  // --- 集計（events_index.json だけで完結）---
  const idx = banner.loadIndex(ROOT);
  const series = banner.loadSeries(ROOT);
  const agg = banner.aggregateWindow(idx, series.ntc, win.from, win.to);
  log('集計: ' + agg.eventCount + 'イベント / ' + agg.deckTotal + 'デッキ / '
    + agg.distinctTypes + 'タイプ / データ最新日 ' + (agg.latestDate || 'なし'));

  // --- イベント0週はスキップ ---
  if (agg.eventCount === 0 || agg.deckTotal === 0) {
    log('この窓には対象イベントがありません。素材は生成しません（無投稿の週になります）');
    return RC.SKIP_NO_EVENTS;
  }

  // --- 文面（280検査は post-x-daily の weightedLength を注入して行う）---
  const { weightedLength } = require('./post-x-daily.js');
  const fitted = banner.fitText(banner.buildFridayText(agg), weightedLength, MAX_WEIGHTED);
  log('文面: 加重 ' + fitted.weighted + ' / ' + MAX_WEIGHTED
    + (fitted.dropped.length ? '（省略: ' + fitted.dropped.join(' / ') + '）' : ''));
  if (fitted.over) warn('加重が上限を超えています。手動で短くしてから予約してください');

  const spec = banner.buildSpec(agg, series, 'friday');
  const outDir = args.opts['--out'] || path.join(OUT_BASE, 'friday-' + friday);

  if (dryRun) {
    console.log('');
    console.log('----- ' + friday + ' ' + PLANNED_TIME + ' -----');
    for (const line of fitted.text.split('\n')) console.log('  | ' + line);
    console.log('');
    console.log('  画像: ' + spec.title + ' / ' + spec.sub);
    for (const r of spec.rows) console.log('    ' + r.label + ' ' + r.share + '% (' + r.count + ')');
    console.log('');
    log('[DRY-RUN] ファイル出力は行っていません（0 件）。出力先の予定: ' + outDir);
    return RC.OK;
  }

  // --- 出力先が既にあるなら上書きしない ---
  if (fs.existsSync(outDir)) {
    err('出力先が既に存在します。上書きしないため中断しました: ' + outDir
      + '（作り直す場合は、このディレクトリを削除してから再実行してください）');
    return RC.ERR_OUT_EXISTS;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const base = '00-金曜プレビュー-' + friday;
  const pngPath = path.join(outDir, base + '.png');
  const txtPath = path.join(outDir, base + '.txt');

  const r = await banner.renderBanner(spec, pngPath);
  fs.writeFileSync(txtPath, fitted.text.replace(/\n/g, '\r\n'), 'utf-8');   // BOM なし・CRLF
  fs.writeFileSync(path.join(outDir, base + '.svg'), r.svg, 'utf-8');       // 検証用（構図の突合）
  fs.writeFileSync(path.join(outDir, '予約手順.txt'),
    buildGuide({ friday, win, agg, fitted, base }), 'utf-8');

  log('出力しました: ' + outDir);
  log('  ' + base + '.png / ' + base + '.txt / ' + base + '.svg / 予約手順.txt');
  log('次にやること: 予約手順.txt のとおり、X の Web 版から ' + friday + ' ' + PLANNED_TIME + ' で予約してください');
  return RC.OK;
}

// -------------------------------------------------------------------
// 予約手順（UTF-8 BOM なし・CRLF）
// -------------------------------------------------------------------
function buildGuide(o) {
  const L = [];
  const push = (s) => L.push(s === undefined ? '' : s);

  push('金曜プレビュー 予約手順（指示書68 §2-B）');
  push('==============================================');
  push();
  push('■ いつ・何を');
  push('  投稿日時: ' + o.friday + '（金） **' + PLANNED_TIME + '**');
  push('  集計期間: ' + o.win.from + '〜' + o.win.to + '（前週金曜〜当週木曜の7日間）');
  push('  集計結果: ' + o.agg.eventCount + 'イベント / 上位入賞 ' + o.agg.deckTotal + 'デッキ');
  push();
  push('  土曜の対戦準備に間に合わせるための投稿です。');
  push('  **木曜の夜〜金曜の朝までに予約を登録してください。**');
  push();
  push('■ 予約のしかた');
  push('  1. ブラウザで https://x.com/ を開き、@gcg_stats でログインする');
  push('     ※ スマホアプリでは予約できません。必ず Web 版から。');
  push('  2. 「ポストする」（投稿の作成）を開く');
  push('  3. ' + o.base + '.txt をメモ帳などで開き、全選択してコピーし、本文へ貼り付ける');
  push('  4. 画像アイコンから ' + o.base + '.png を添付する');
  push('  5. カレンダーのアイコン（予約設定）を押す');
  push('  6. 日付を ' + o.friday + '、時刻を **午後 1:00（13:00）** に設定する');
  push('     - 「午前／午後」を選ぶ欄がある場合は **午後** を選びます。');
  push('       午前 1:00 にすると深夜 1 時の投稿になります。');
  push('     - 24 時間表記の欄なら **13:00** です。');
  push('  7. 「確認」→「予約設定」で確定する');
  push();
  push('■ 登録できたかの確認');
  push('  投稿の作成画面の下のほうにある「未送信のポスト」→「予約済み」タブに、');
  push('  **画像付き・' + o.friday + '・午後1:00** で並んでいれば OK です。');
  push();
  push('■ 登録しなかった場合');
  push('  その週は金曜プレビューの投稿がありません。それで問題ありません。');
  push('  （夜間の自動投稿や「今日のカード」には一切影響しません。');
  push('    この工程は素材を作るだけで、状態ファイルには何も書いていません。）');
  push('  あとから手で投稿するのは避けてください。予約が残っていた場合に二重になります。');
  push();
  push('■ 文面（目視確認用。コピー元は .txt のほうです）');
  push('  文字数: ' + o.fitted.weighted + ' / ' + MAX_WEIGHTED + '（X の数え方。日本語1文字=2、URL=23）');
  if (o.fitted.dropped.length) {
    push('  ※ 長さの都合で次を省略しています: ' + o.fitted.dropped.join(' / '));
  }
  if (o.fitted.over) {
    push('  ※ **上限を超えています。このままでは投稿できません。**');
    push('     文面を短くするか、この週は見送ってください。');
  }
  push();
  push('  ----------------------------------------------');
  for (const line of o.fitted.text.split('\n')) push('  ' + line);
  push('  ----------------------------------------------');
  push();
  push('■ 画像の内容');
  for (const r of o.agg.rows) {
    push('  ' + r.label + '  ' + r.share + '%  (' + r.count + 'デッキ)');
  }
  push();

  return L.join('\r\n') + '\r\n';
}

// -------------------------------------------------------------------
// main（**終了コードは常に 0**）
// -------------------------------------------------------------------
async function main() {
  let rc = RC.OK;
  let args = null;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.log(USAGE);
    console.log('');
    err(e && e.message ? e.message : String(e));   // 引数の誤りはスタックを出さない
    log('FRIPREVRC=' + RC.ERR);
    process.exitCode = 0;
    return;
  }
  if (args.flags['--help']) { console.log(USAGE); process.exitCode = 0; return; }

  try {
    rc = await run(args);
  } catch (e) {
    err(e && e.message ? e.message : String(e));
    if (e && e.stack) console.log(e.stack);        // 実行時エラーは原因調査のため残す
    rc = RC.ERR;
  }
  log('FRIPREVRC=' + rc);
  process.exitCode = 0;   // 指示書68 §2-B: exit 0 固定
}

if (require.main === module) {
  main().catch((e) => {
    err('想定外の例外: ' + (e && e.stack ? e.stack : e));
    log('FRIPREVRC=' + RC.ERR);
    process.exitCode = 0;
  });
}

module.exports = { main, run, parseArgs, buildGuide, RC, PLANNED_TIME };
