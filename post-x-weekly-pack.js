#!/usr/bin/env node
/**
 * post-x-weekly-pack.js  ―  X 予約投稿用 週次パック生成（指示書64）
 *
 * 「今日のカード」の翌週 7 日分を先計算し、X の予約投稿（Web 版の手動機能）へ
 * 貼り付けるための素材一式を出力する。あわせて状態ファイルへ status="manual_scheduled"
 * を記録し、夜間バッチ（post-x-daily.js）が同じ日に自動投稿しないようにする。
 *
 *   node post-x-weekly-pack.js --dry-run                  # 選定・文面の確認のみ（出力・状態書込 0 件）
 *   node post-x-weekly-pack.js                            # 翌日から 7 日分のパックを生成
 *   node post-x-weekly-pack.js --start 2026-08-10 --days 7
 *   node post-x-weekly-pack.js --unmark 2026-08-12        # 予約しなかった日を夜間自動へ戻す
 *
 * 実行想定（指示書68 §2-A）: **日曜 21:30 以降**。
 *   その週（月〜日）の大会結果が出そろってから走らせることで、同時に出力する
 *   「月曜まとめ」の集計がその週の確定値になる。日曜以外でも動くが警告を出す。
 *
 * 設計上の鉄則（指示書64 §1/§2/§6）:
 *   - X 投稿・メディアアップロードへ到達する経路を持たない
 *     （postTweet / uploadMediaToX / executeItem を require しても呼ばない）
 *   - 選定・文面・縮退は post-x-daily.js の公開関数（planDaily）をそのまま再利用し、
 *     独自に再実装しない。「毎晩実行した場合」と完全に同一の選定になることが要件
 *   - --dry-run / --state-file は post-x-daily.js と同名。post-x-daily は require 時に
 *     自プロセスの argv を解釈するため、同名にすることで --dry-run 実行中は
 *     post-x-daily 側の書き込み関数（writeStateAtomic）も throw する二重防御になる
 *   - 逆に --date / --only は定義しない（post-x-daily 側が解釈してしまうため）
 *   - 出力順序は「日別ファイル → 状態ファイル 1 回 → チェックリスト（完了マーカー）」
 *
 * 作成: 2026-08-02（指示書64 実装セッション）
 * 更新: 2026-08-07（指示書68 §2-A: 月曜まとめの画像・文面・チェックリスト行を追加）
 */
'use strict';

const fs = require('fs');
const path = require('path');

// post-x-daily.js は require 時に自プロセスの argv を解釈する（指示書64 §0）。
// --date に不正値があるとその時点で process.exit(0) され、こちらのエラー表示へ届かないまま
// 黙って終了してしまう。本ツールは --date / --only を定義していないので require より前に弾く。
for (const a of process.argv.slice(2)) {
  if (a === '--date' || a.startsWith('--date=') || a === '--only' || a.startsWith('--only=')) {
    console.error('[post-x-weekly-pack] *** ERROR *** 未知のオプションです: ' + a.split('=')[0]
      + '（--date / --only は意図的に定義していません。post-x-daily.js 側が解釈してしまうためです）');
    process.exit(1);
  }
}

const daily = require('./post-x-daily.js');
const { makeIsNtcTypeFromSeriesMap } = require('./shared/ntc-rank-consolidator');

const {
  addDays, diffDays, dayOfWeek,
  aggregateUsage, resolveDefaultRange,
  planDaily, readState, writeStateAtomic,
  weightedLength, loadInputs
} = daily;

const ROOT = __dirname;

// ===================================================================
// 調整可能な定数
// ===================================================================
const PACK = {
  PLANNED_TIME: '10:00',        // X 予約投稿の時刻（毎朝 10:00 JST）
  DEFAULT_DAYS: 7,
  MAX_DAYS: 14,
  STATUS: 'manual_scheduled',   // 状態ファイルへ記録する status
  JPEG_QUALITY: 90,             // webp→jpeg 変換品質（post-x-daily prepareMediaFile と同値）
  OUT_BASE: path.join(ROOT, 'tmp', 'x-weekly-pack'),
  CHECKLIST_NAME: '予約チェックリスト.md',
  // --- 指示書68 §2-A: 月曜まとめ ---
  MONDAY_TIME: '12:00',            // 月曜まとめの予約時刻（正午）
  MONDAY_BASE: '00-月曜まとめ',    // 出力ファイル名の接頭辞
  EXPECT_DOW: 0,                   // 実行想定の曜日（0=日曜）
  // 夜間バッチ（20:00 起動）が状態ファイルを書き終えるまでの実行禁止帯（JST）
  FORBID_FROM_MIN: 19 * 60 + 30,   // 19:30
  FORBID_TO_MIN: 21 * 60 + 30      // 21:30
};

const WEEKDAY_JP = ['日', '月', '火', '水', '木', '金', '土'];

// ===================================================================
// ログ
// ===================================================================
function log(msg) {
  const jst = new Date(nowMs() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  console.log('[' + jst + ' JST][post-x-weekly-pack] ' + msg);
}
function logError(msg) { log('*** ERROR *** ' + msg); }
function logWarn(msg) { log('*** 警告 *** ' + msg); }

// ===================================================================
// 時刻（JST）
//   X_PACK_TEST_NOW は「テスト専用」の時刻差し替え。設定時は必ず警告を出す。
//   X 投稿経路を持たないスクリプトのため、誤設定の最悪ケースでも
//   「誤った日付に manual_scheduled を書く」までで、二重投稿には至らない。
// ===================================================================
const TEST_NOW = process.env.X_PACK_TEST_NOW || '';
function nowMs() {
  if (TEST_NOW) {
    const t = Date.parse(TEST_NOW);
    if (!isNaN(t)) return t;
  }
  return Date.now();
}
function todayJst() {
  return new Date(nowMs() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function minutesOfDayJst() {
  const d = new Date(nowMs() + 9 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
function nowIsoJst() {
  return new Date(nowMs() + 9 * 3600 * 1000).toISOString().slice(0, 19) + '+09:00';
}
function hhmm(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

// ===================================================================
// CLI 引数（未知のフラグはエラーにする＝--dry-run の打ち間違いで実書き込みに落ちない）
// ===================================================================
const KNOWN_FLAGS = ['--help', '--dry-run'];                       // 値を取らない
const KNOWN_OPTS = ['--start', '--days', '--out', '--state-file', '--unmark']; // 値を取る

function parseArgs(argv) {
  const out = { flags: {}, opts: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error('引数の解釈に失敗しました（値だけが置かれています）: ' + a);
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const inlineVal = eq >= 0 ? a.slice(eq + 1) : null;
    if (KNOWN_FLAGS.includes(name)) { out.flags[name] = true; continue; }
    if (KNOWN_OPTS.includes(name)) {
      let v = inlineVal;
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
  'post-x-weekly-pack.js ― X 予約投稿用 週次パック生成（指示書64）',
  '',
  '  node post-x-weekly-pack.js [--start YYYY-MM-DD] [--days N] [--out <dir>]',
  '                             [--dry-run] [--state-file <path>]',
  '  node post-x-weekly-pack.js --unmark YYYY-MM-DD [--dry-run] [--state-file <path>]',
  '',
  '  --start        パック開始日（既定: 実行日の翌日）。実行日以前は指定できません',
  '  --days         日数（既定 ' + PACK.DEFAULT_DAYS + ' / 上限 ' + PACK.MAX_DAYS + '）',
  '  --out          出力先ディレクトリ（既定: ' + path.join(PACK.OUT_BASE, '<開始日>') + '）',
  '                 既に存在する場合はエラーで中断します（上書きしません）',
  '  --dry-run      選定・文面を表示するだけ。ファイル出力・状態書き込みとも 0 件',
  '  --state-file   状態ファイルの差し替え（検証用）',
  '  --unmark       指定日の manual_scheduled を取り消して夜間自動へ戻す（翌日以降のみ）',
  '',
  '  ※ 実行想定は **日曜 ' + hhmm(PACK.FORBID_TO_MIN) + ' 以降**です（指示書68 §2-A）。',
  '     その週の結果が出そろってから走らせると、月曜まとめの集計が確定値になります',
  '  ※ ' + hhmm(PACK.FORBID_FROM_MIN) + '〜' + hhmm(PACK.FORBID_TO_MIN)
    + ' JST は実行できません（夜間バッチが状態ファイルを書き終えるまで待つため）',
  '  ※ --date / --only は定義していません（post-x-daily.js 側が解釈してしまうため）'
].join('\n');

// ===================================================================
// 事前チェック
// ===================================================================
function assertNotBatchWindow() {
  const m = minutesOfDayJst();
  if (m >= PACK.FORBID_FROM_MIN && m < PACK.FORBID_TO_MIN) {
    throw new Error(
      '実行禁止時間帯です（' + hhmm(PACK.FORBID_FROM_MIN) + '〜' + hhmm(PACK.FORBID_TO_MIN)
      + ' JST / 現在 ' + hhmm(m) + '）。'
      + '夜間バッチが状態ファイルを書き終えていない可能性があるため中断しました。'
      + hhmm(PACK.FORBID_TO_MIN) + ' 以降に再実行してください');
  }
}

// 指示書68 §2-A: 実行想定は日曜 21:30 以降。日曜以外でも動かせるが、
// 月曜まとめの窓（実行日を含む週の月〜日）が未完の週になるため警告する。
function warnIfNotExpectedDow(today) {
  const d = dayOfWeek(today);
  if (d === PACK.EXPECT_DOW) return;
  logWarn('実行想定は日曜 ' + hhmm(PACK.FORBID_TO_MIN) + ' 以降です（今日は'
    + WEEKDAY_JP[d] + '曜）。月曜まとめの集計期間はまだ終わっていない週になります');
}

function assertDateFormat(label, s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(label + ' の形式が不正です（YYYY-MM-DD）: ' + s);
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(label + ' は存在しない日付です: ' + s);
  }
}

// 状態ファイルの生バイト列（競合検知に使う）。存在しなければ null
function readStateRaw() {
  const f = daily._internal.STATE_FILE;
  try { return fs.readFileSync(f); } catch (_) { return null; }
}
function sameRaw(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Buffer.compare(a, b) === 0;
}

// ===================================================================
// パック生成
// ===================================================================
async function generate(args) {
  const dryRun = !!args.flags['--dry-run'];
  const today = todayJst();

  assertNotBatchWindow();
  warnIfNotExpectedDow(today);

  // --- 引数の解決と検証 ---
  const start = args.opts['--start'] || addDays(today, 1);
  assertDateFormat('--start', start);
  if (diffDays(start, today) <= 0) {
    throw new Error('--start は実行日（' + today + '）の翌日以降である必要があります: ' + start
      + '（当日・過去日を対象にすると、その日の夜間自動投稿と 10:00 の予約が二重になり得ます）');
  }

  let days = PACK.DEFAULT_DAYS;
  if (args.opts['--days'] !== undefined) {
    if (!/^\d+$/.test(args.opts['--days'])) throw new Error('--days は整数で指定してください: ' + args.opts['--days']);
    days = parseInt(args.opts['--days'], 10);
    if (days < 1 || days > PACK.MAX_DAYS) {
      throw new Error('--days は 1〜' + PACK.MAX_DAYS + ' の範囲で指定してください: ' + days);
    }
  }

  const outDir = args.opts['--out'] || path.join(PACK.OUT_BASE, start);
  if (fs.existsSync(outDir)) {
    if (dryRun) {
      logWarn('出力先が既に存在します（本実行ではエラーになります）: ' + outDir);
    } else {
      throw new Error('出力先が既に存在します。上書きしないため中断しました: ' + outDir
        + '（作り直す場合は、先に各日を --unmark してからディレクトリを削除してください）');
    }
  }

  log('起動' + (dryRun ? ' *** DRY-RUN ***' : '') + (TEST_NOW ? ' *** X_PACK_TEST_NOW 使用中 ***' : ''));
  if (TEST_NOW) logWarn('X_PACK_TEST_NOW が設定されています（テスト専用）: ' + TEST_NOW);
  log('実行日(JST) ' + today + ' / 開始 ' + start + ' / ' + days + ' 日分');
  log('状態ファイル: ' + daily._internal.STATE_FILE);
  log('出力先: ' + outDir);

  // --- 状態ファイル（読み） ---
  const rawBefore = readStateRaw();
  const st = readState();
  if (!st.ok) {
    // 破損時の退避・再作成は夜間側（post-x-daily）の役割。ここでは中止のみ
    throw new Error('状態ファイルを読めません（' + st.reason + '）: ' + st.message
      + ' / 退避・再作成は行いません。夜間バッチ側の復旧を待ってから再実行してください');
  }
  if (st.isNew) log('状態ファイルは未作成です（初回実行として扱います）');

  // --- ギャップ日検証（実行日 〜 start-1 の daily キーがすべて存在すること） ---
  const missing = [];
  for (let d = today; diffDays(start, d) > 0; d = addDays(d, 1)) {
    if (!st.state.entries['daily:' + d]) missing.push(d);
  }
  if (missing.length > 0) {
    throw new Error(
      '実行日〜開始日前日の「今日のカード」がまだ確定していません（未記録: ' + missing.join(', ') + '）。'
      + 'この状態で先計算すると 60 日ガードの判定がずれ、夜間自動と同じカードを予約してしまう恐れがあります。'
      + '当夜のバッチ完了後（' + hhmm(PACK.FORBID_TO_MIN) + ' 以降）に再実行してください。'
      + 'なお、夜間バッチが動いたのに投稿をスキップした日（プールが空・X 資格情報エラー等）は'
      + '記録が残らないため、再実行しても解消しません。その場合は松岡さん経由で発行元へご連絡ください');
  }

  // --- 入力データ（post-x-daily と同一経路） ---
  const input = loadInputs();
  if (!input.events || !input.events.events) {
    throw new Error('data/events.json を読めませんでした。パック生成を中止します');
  }
  const eventsObj = input.events.events;
  const isNtcTypeFn = makeIsNtcTypeFromSeriesMap(input.seriesMap);
  const range = resolveDefaultRange(input.topStats, eventsObj, input.seriesMap);
  const aggDefault = aggregateUsage(eventsObj, isNtcTypeFn, range.start, range.end);
  log('既定レンジ: ' + range.start + '〜' + range.end + '（出典=' + range.source + '）');
  log('既定レンジ集計: イベント ' + aggDefault.eventCount + ' 件 / 対象デッキ ' + aggDefault.totalDecks
    + ' 件 / 出現カード ' + Object.keys(aggDefault.usage).length + ' 種');

  // --- 逐次シミュレーション（毎晩 1 回ずつ実行した場合と同一の状態遷移を再現） ---
  const ctxBase = {
    state: st.state, aggDefault, range,
    cardsMaster: input.cardsMaster, cardsPreview: input.cardsPreview
  };
  const items = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    const plan = planDaily(Object.assign({}, ctxBase, { today: d }));
    if (plan.skip) {
      logWarn('[' + d + '] スキップ: ' + plan.reason);
      items.push({ date: d, index: i + 1, skip: true, reason: plan.reason });
      continue;
    }
    // 次の日の選定が「前日を投稿済み」として動くよう、状態のメモリ上コピーへ反映する
    st.state.entries[plan.key] = {
      kind: 'daily',
      status: PACK.STATUS,
      card_id: plan.card.card_id,
      planned_time: PACK.PLANNED_TIME,
      generated_at: nowIsoJst()
    };
    const media = (plan.media && plan.media[0]) || { missing: true };
    const textCrlf = plan.text.replace(/\n/g, '\r\n');
    items.push({
      date: d, index: i + 1, skip: false, key: plan.key,
      card: plan.card, text: plan.text, textCrlf,
      weighted: plan.weighted,
      weightedCrlf: weightedLength(textCrlf),
      overLimit: plan.weighted > daily.CONFIG.MAX_WEIGHTED_LENGTH,
      dropped: plan.dropped || [], nameTruncated: !!plan.nameTruncated,
      exhausted: !!plan.exhausted, guardSkipped: plan.guardSkipped, poolSize: plan.poolSize,
      media,
      txtName: fileBase(i + 1, d, plan.card.card_id) + '.txt',
      imgName: media && media.file ? fileBase(i + 1, d, plan.card.card_id) + '.jpg' : null
    });
    log('[' + d + '(' + WEEKDAY_JP[dayOfWeek(d)] + ')] 選定: ' + plan.card.card_id + ' ' + plan.card.name
      + ' / 加重 ' + plan.weighted + ' / 画像 '
      + (media.missing ? 'なし' : media.format + (media.convert ? '→jpeg変換' : ''))
      + (plan.exhausted ? ' / *** プール枯渇フォールバック ***' : ''));
  }

  // --- 月曜まとめ（指示書68 §2-A）---
  // 64 の既存機能を壊さないため、ここで何が起きても週次パック本体は続行する。
  const monday = await buildMondaySummary(today);
  if (monday.ok) {
    log('月曜まとめ: ' + monday.window.from + '〜' + monday.window.to + ' / '
      + monday.agg.eventCount + 'イベント ' + monday.agg.deckTotal + 'デッキ / 加重 '
      + monday.fitted.weighted + ' / 投稿予定 ' + monday.postDate + ' ' + PACK.MONDAY_TIME);
    if (monday.fitted.over) logWarn('月曜まとめの文面が加重上限を超えています（手動対応が必要です）');
  } else {
    logWarn('月曜まとめは出力しません: ' + monday.reason);
  }

  const planned = items.filter((it) => !it.skip);
  for (const it of planned) {
    if (it.overLimit) logWarn('[' + it.date + '] 加重 ' + it.weighted + ' が上限を超えています（手動対応が必要です）');
  }

  if (dryRun) {
    console.log('');
    for (const it of planned) {
      console.log('----- ' + it.date + '(' + WEEKDAY_JP[dayOfWeek(it.date)] + ') '
        + PACK.PLANNED_TIME + ' / ' + it.card.card_id + ' / 加重 ' + it.weighted + ' -----');
      for (const line of it.text.split('\n')) console.log('  | ' + line);
    }
    if (monday.ok) {
      console.log('----- 月曜まとめ ' + monday.postDate + '(月) ' + PACK.MONDAY_TIME
        + ' / 加重 ' + monday.fitted.weighted + ' -----');
      for (const line of monday.fitted.text.split('\n')) console.log('  | ' + line);
      console.log('  [画像] ' + monday.spec.title + ' / ' + monday.spec.sub);
      for (const r of monday.spec.rows) {
        console.log('    ' + r.label + ' ' + r.share + '% (' + r.count + 'デッキ)');
      }
    } else {
      console.log('----- 月曜まとめ: 出力なし（' + monday.reason + '） -----');
    }
    console.log('');
    log('[DRY-RUN] ファイル出力・状態ファイル書き込みはいずれも実行していません（0 件）');
    log('対象 ' + planned.length + ' 日 / スキップ ' + (items.length - planned.length) + ' 日');
    return { items, outDir, dryRun: true };
  }

  if (planned.length === 0) {
    throw new Error('予約対象の日が 1 日もありません（全日スキップ）。パックは生成しません');
  }

  // --- 競合検知（読み取り以降に夜間バッチが書いていないこと） ---
  if (!sameRaw(rawBefore, readStateRaw())) {
    throw new Error('状態ファイルが実行中に他プロセスから更新されました。'
      + '安全のため何も書かずに中断します（' + hhmm(PACK.FORBID_TO_MIN) + ' 以降に再実行してください）');
  }

  // --- 1) 日別ファイル（txt + jpg） ---
  fs.mkdirSync(outDir, { recursive: true });
  for (const it of planned) {
    fs.writeFileSync(path.join(outDir, it.txtName), it.textCrlf, 'utf-8'); // BOM なし・CRLF・末尾改行なし
    if (it.imgName) await writeImage(it.media, path.join(outDir, it.imgName));
  }
  log('日別ファイルを出力しました: ' + planned.length + ' 日分（txt ' + planned.length + ' / jpg '
    + planned.filter((it) => it.imgName).length + '）');

  // 月曜まとめ（指示書68 §2-A）。ここも「日別ファイル」の工程に含める＝
  // チェックリストが完了マーカーである性質（最後に書く）を崩さない。
  if (monday.ok) {
    // 書き出しの失敗（フォント解決・ディスク・ファイルロック等）で 64 の本体を止めない。
    // ここで落ちると状態ファイルもチェックリストも書かれず、パックが未完成になる。
    try {
      const banner = require('./x-weekly-banner.js');
      await banner.renderBanner(monday.spec, path.join(outDir, monday.pngName));
      fs.writeFileSync(path.join(outDir, monday.txtName),
        monday.fitted.text.replace(/\n/g, '\r\n'), 'utf-8');   // BOM なし・CRLF
      log('月曜まとめを出力しました: ' + monday.pngName + ' / ' + monday.txtName);
    } catch (e) {
      logWarn('月曜まとめの書き出しに失敗しました（週次パック本体は続行します）: '
        + (e && e.message ? e.message : String(e)));
      // 中途半端なファイルを残さない。チェックリストにも「出力なし」と書く
      for (const n of [monday.pngName, monday.txtName]) {
        try { fs.unlinkSync(path.join(outDir, n)); } catch (_) { /* 無ければ何もしない */ }
      }
      monday.ok = false;
      monday.reason = '書き出しに失敗しました: ' + (e && e.message ? e.message : String(e));
    }
  }

  // --- 2) 状態ファイルへ最後に 1 回だけ原子書き ---
  if (!sameRaw(rawBefore, readStateRaw())) {
    throw new Error('状態ファイルが実行中に他プロセスから更新されました。'
      + '状態は書き換えていません。出力先ディレクトリ（' + outDir + '）を削除してから再実行してください');
  }
  writeStateAtomic(st.state);
  log('状態ファイルへ ' + planned.length + ' 日分の status=' + PACK.STATUS + ' を記録しました');

  // --- 3) チェックリスト（＝完了マーカー。最後に書く） ---
  const checklistPath = path.join(outDir, PACK.CHECKLIST_NAME);
  fs.writeFileSync(checklistPath, buildChecklist({
    items, planned, start, days, outDir, range, today,
    hasMonday: planned.some((it) => dayOfWeek(it.date) === 1),
    monday
  }), 'utf-8');

  // --- 4) サマリ ---
  console.log('');
  log('=== 完了 ===');
  log('出力先: ' + outDir);
  log('予約対象 ' + planned.length + ' 日 / スキップ ' + (items.length - planned.length) + ' 日');
  log('次にやること: ' + PACK.CHECKLIST_NAME + ' を開き、X の Web 版から 1 件ずつ '
    + PACK.PLANNED_TIME + ' の予約投稿を登録してください');
  return { items, outDir, dryRun: false };
}

/**
 * 月曜まとめ（指示書68 §2-A）の集計・文面・画像 spec を作る。
 *   窓 = 実行日を含む週の月〜日（日曜実行なら「その週の月〜当日」）
 *   投稿日 = 窓の終わり（日曜）の翌日 = 月曜
 * 失敗しても throw しない。呼び出し側は { ok:false, reason } を見て続行する。
 */
async function buildMondaySummary(today) {
  const r = { ok: false, reason: null };
  try {
    const banner = require('./x-weekly-banner.js');
    const win = banner.windowMonday(today);
    r.window = win;
    r.postDate = banner.addDays(win.to, 1);

    const idx = banner.loadIndex(ROOT);
    const series = banner.loadSeries(ROOT);
    const agg = banner.aggregateWindow(idx, series.ntc, win.from, win.to);
    r.agg = agg;

    if (agg.eventCount === 0 || agg.deckTotal === 0) {
      r.reason = 'この週（' + win.from + '〜' + win.to + '）には対象イベントが 1 件もありません';
      return r;
    }

    r.fitted = banner.fitText(banner.buildMondayText(agg), weightedLength,
      daily.CONFIG.MAX_WEIGHTED_LENGTH);
    r.spec = banner.buildSpec(agg, series, 'monday');
    r.pngName = PACK.MONDAY_BASE + '-' + r.postDate + '.png';
    r.txtName = PACK.MONDAY_BASE + '-' + r.postDate + '.txt';
    r.ok = true;
  } catch (e) {
    r.reason = '生成に失敗しました（週次パック本体は続行します）: '
      + (e && e.message ? e.message : String(e));
  }
  return r;
}

function fileBase(index, date, cardId) {
  return String(index).padStart(2, '0') + '-' + date.slice(5).replace('-', '') + '-' + cardId;
}

// jpg はコピー、webp は sharp で jpeg 変換（post-x-daily prepareMediaFile と同値）
async function writeImage(media, destPath) {
  if (media.format === 'jpg') { fs.copyFileSync(media.file, destPath); return; }
  const sharp = require('sharp');
  await sharp(media.file).jpeg({ quality: PACK.JPEG_QUALITY }).toFile(destPath);
}

// ===================================================================
// チェックリスト（UTF-8 BOM なし・CRLF）
// ===================================================================
function buildChecklist(o) {
  const L = [];
  const push = (s) => L.push(s === undefined ? '' : s);

  push('# X 予約投稿 チェックリスト（' + o.start + ' から ' + o.days + '日分）');
  push();
  push('- 生成日時: ' + nowIsoJst() + '（実行日 ' + o.today + '）');
  push('- 出力先: `' + o.outDir + '`');
  push('- 集計期間（この週の文面の根拠）: ' + o.range.start + '〜' + o.range.end);
  push('- 予約時刻: **毎朝 ' + PACK.PLANNED_TIME + '（午前10時）**');
  push();
  pushMondaySummarySection(push, o);
  push('## はじめに（必ず読んでください）');
  push();
  push('- **この週は X の予約投稿が前提です。登録しなかった日は、その日の投稿はありません。**');
  push('  （夜間の自動投稿は、この日付ぶんはスキップされるように記録済みです）');
  push('  - これは「二重に投稿するくらいなら 1 日休む」という取り決めです。');
  push('    **登録し忘れに気づいても、その日に手で投稿しないでください。**');
  push('    予約だけが残っていた場合、同じ内容が 2 回出てしまいます。翌日ぶんから登録を再開すれば十分です。');
  push('- 予約は **X の Web 版（ブラウザ）** から行います。**スマホアプリでは予約できません。**');
  push('- **最初の 1 件だけを登録し、予約一覧（未送信のポスト）に「画像付き・午前10:00」で');
  push('  表示されることを確認してから**、残りを登録してください。');
  push('  - 合否の基準: 予約一覧に **画像付き・日付・午前10:00** で並んでいれば OK です。');
  push('    翌朝に実際へ投稿されるまで待つ必要はありません。');
  push('  - **導入して最初の週だけ**は、翌朝 10:00 すぎに @gcg_stats を開いて');
  push('    実際に投稿されたことも確認してください。');
  push('- **投稿文のコピー元は「日別の .txt ファイル」です。**');
  push('  このチェックリストに載せている文面は目視確認用です。ここからのコピーは避けてください');
  push('  （記号や改行が崩れることがあります）。');
  push('- 各日に書いてある「文字数 ○○ / ' + daily.CONFIG.MAX_WEIGHTED_LENGTH + '」は X の数え方による見積りです');
  push('  （日本語 1 文字＝2、URL は長さに関わらず 23 として計算します。見た目の文字数とは違います）。');
  push('  **上限内なので、そのまま貼り付けて投稿できます。文面を短く書き直す必要はありません。**');
  if (o.hasMonday) {
    push('- **月曜だけは、朝 10:00 の予約とは別に、夜 20:00 に「週間ムーバー」が自動投稿されます。**');
    push('  中身の違う別の投稿なので、二重投稿ではありません（これまでどおりの動きです）。');
    if (o.monday && o.monday.ok) {
      push('  さらに ' + PACK.MONDAY_TIME + ' の「週間環境まとめ」を加えて、'
        + '**月曜は 3 件**（朝のカード／昼のまとめ／夜のムーバー）になります。');
      push('  いずれも中身の違う別の投稿です。X の1日あたりの上限には収まっています。');
    }
  }
  push();
  push('## 登録のしかた（1 日ぶんの手順）');
  push();
  push('1. ブラウザで <https://x.com/> を開き、@gcg_stats でログインする');
  push('2. 「ポストする」（投稿の作成）を開く');
  push('3. その日の `.txt` をメモ帳などで開き、**全選択してコピー**し、本文へ貼り付ける');
  push('4. 画像アイコンから、その日の `.jpg` を添付する');
  push('5. **カレンダーのアイコン**（予約設定）を押す');
  push('6. 日付をその日に、時刻を **午前 10:00（＝朝の 10 時）** に設定する');
  push('   - 「午前／午後」を選ぶ欄がある場合は、必ず **午前** を選びます。');
  push('     **午後 10:00 にすると夜 22 時の投稿**になり、夜の自動投稿と紛らわしい時間に出てしまいます。');
  push('   - 24 時間表記の欄なら **10:00** です（22:00 ではありません）。');
  push('7. 「確認」→「予約設定」で確定する');
  push();
  push('### 予約一覧（未送信のポスト）の開き方');
  push();
  push('投稿の作成画面（「ポストする」を開いた画面）の下のほうにある');
  push('**「未送信のポスト」**（下書き・予約投稿の一覧）を押すと、**「予約済み」** のタブに');
  push('登録した予約が並びます。ここで日付・時刻・画像を確認します。');
  push('※ 表示名は X の更新で変わることがあります。見つからない場合は、投稿作成画面の');
  push('　 カレンダーアイコンの周辺を探してください。');
  push();
  push('## 日別');
  push();

  for (const it of o.items) {
    const dow = WEEKDAY_JP[dayOfWeek(it.date)];
    if (it.skip) {
      push('### ' + it.index + '. ' + it.date + '（' + dow + '）― 予約対象外（この日は登録しません）');
      push();
      push('- この日は、すでに別の記録があるか、選べるカードがなかったため、パックの対象外です。');
      push('- **この日は X に予約を登録しないでください。** これまでどおり夜の自動投稿にお任せになります。');
      push('- 技術的な理由（発行元への問い合わせ用）: ' + it.reason);
      push();
      continue;
    }
    push('### ' + it.index + '. ' + it.date + '（' + dow + '） 午前' + PACK.PLANNED_TIME);
    push();
    push('- [ ] 登録した');
    push('- カード: ' + it.card.name + '（' + it.card.card_id + '）');
    push('- 投稿文ファイル: `' + it.txtName + '`  ← **コピー元はこちら**');
    if (it.imgName) {
      push('- 画像ファイル: `' + it.imgName + '`'
        + (it.media.format === 'webp' ? '（webp から jpeg へ変換済み）' : '（元から jpg）'));
    } else {
      push('- 画像ファイル: **なし（画像なしで予約してください）**');
    }
    push('- 文字数: ' + it.weighted + ' / ' + daily.CONFIG.MAX_WEIGHTED_LENGTH
      + '（X の数え方。上限内なのでそのまま投稿できます）');
    if (it.overLimit) {
      push('- **⚠ この日は上限を超えています。そのままでは投稿できません。**');
      push('  **この日は手動対応**（文面を短くする、またはこの日は登録しない）としてください。');
    } else if (it.weightedCrlf > daily.CONFIG.MAX_WEIGHTED_LENGTH) {
      push('- ⚠ 参考: 改行コードの数え方によっては X の文字数カウンタが '
        + it.weightedCrlf + ' と表示される場合があります。');
      push('  「投稿できない」と表示されたときは、末尾のハッシュタグを 1 行削って登録してください。');
    }
    if (it.dropped.length) push('- 補足: 文面が長いため ' + it.dropped.join(' / ') + ' を省略しています');
    if (it.nameTruncated) push('- 補足: カード名を切り詰めています');
    if (it.exhausted) push('- 補足: プール枯渇のため、最も投稿から間が空いたカードを選んでいます');
    push();
    push('```');
    for (const line of it.text.split('\n')) push(line);
    push('```');
    push();
  }

  push('## 全件登録したあとの確認');
  push();
  push('- [ ] X の予約一覧（未送信のポスト）を開き、次の 4 点を突き合わせた');
  push('  - [ ] **件数**が ' + o.planned.length + ' 件ある'
    + (o.planned.length < o.days
      ? '（' + o.days + '日のうち ' + (o.days - o.planned.length)
        + ' 日は「予約対象外」なので、この件数で正しいです）' : ''));
  push('  - [ ] **日付**が次の ' + o.planned.length + ' 日ぶんそろっている: '
    + o.planned.map((it) => it.date).join(' / '));
  push('  - [ ] 時刻がすべて **午前 10:00（朝 10 時）**である');
  push('        （**午後 10:00 ＝ 夜 22 時**になっていないか、1 件ずつ見る）');
  push('  - [ ] **画像**が付いている（「画像なし」と書いた日を除く）');
  push();
  push('## 登録しなかった日・予約を取り消した日');
  push();
  push('- その日が来る前に、次のコマンドで夜間自動投稿へ戻してください（PowerShell）。');
  push('  戻さないと、**そのカードは「最近投稿した」扱いのまま 60 日間、次の候補から外れ続けます**');
  push('  （実際には一度も投稿していないのに、です）。壊れはしませんが、投稿ネタが減るのでもったいない状態になります。');
  push();
  push('```powershell');
  push('cd E:\\GCGSTATS');
  push('# ① 先に X 側の予約を取り消す（ブラウザで）');
  push('# ② そのあとで、下の日付を戻したい日に置き換えて実行する');
  push('node post-x-weekly-pack.js --unmark ' + (o.planned[0] ? o.planned[0].date : o.start));
  push('```');
  push();
  push('- このパックの対象日: ' + o.planned.map((it) => it.date).join(' / '));
  push('- **' + hhmm(PACK.FORBID_FROM_MIN) + '〜' + hhmm(PACK.FORBID_TO_MIN)
    + ' の間は実行できません**（夜のバッチと重なるため）。'
    + hhmm(PACK.FORBID_TO_MIN) + ' 以降に実行してください。');
  push();
  push('- **順序が大事です。先に X の予約を取り消し、そのあとで `--unmark` してください。**');
  push('  （逆にすると、夜間自動と 10:00 の予約が二重に投稿される恐れがあります）');
  push('- `--unmark` できるのは **翌日以降の日付だけ**です。当日・過去日は受け付けません');
  push('  （当日 10:00 の予約が既に発火していた場合、その夜の自動投稿と二重になるため）。');
  push('  過ぎてしまった日の扱いは、松岡さん経由で発行元へご確認ください。');
  push();
  push('---');
  push();
  push('※ このファイルはパック生成の**最後**に書き出されます。');
  push('**このファイルが無いパックは生成が途中で終わっています。使わずに作り直してください**');
  push('（各日を `--unmark` してから出力先ディレクトリを削除し、再実行）。');
  push('その際 `--unmark` で「状態ファイルに存在しません」と出た日は、**まだ記録されていないので');
  push('何もしなくて大丈夫です**。全日そう出た場合は、そのまま出力先フォルダを削除して再実行してください。');
  push();

  return L.join('\r\n');
}

// 指示書68 §2-A: チェックリストの先頭に置く「月曜まとめ」の節。
// 画像の添付を明記する（この投稿は画像が主役のため）。
function pushMondaySummarySection(push, o) {
  const m = o.monday;
  push('## ★ 最初にこれ: 週間環境まとめ（画像つき）を月曜 ' + PACK.MONDAY_TIME + ' で予約');
  push();
  if (!m || !m.ok) {
    push('- **今回は出力していません。** 理由: ' + ((m && m.reason) || '不明'));
    push('- この週は週間環境まとめの投稿はありません。それで問題ありません。');
    push('  下の「日別」（毎朝 ' + PACK.PLANNED_TIME + 'のカード）はいつもどおり登録してください。');
    push();
    return;
  }
  push('- [ ] 登録した');
  push('- 投稿日時: **' + m.postDate + '（月） ' + PACK.MONDAY_TIME + '（正午）**');
  push('  - 「午前／午後」を選ぶ欄がある場合は **午後 12:00**（＝お昼の12時）です。');
  push('    24 時間表記の欄なら **12:00** です。');
  push('- 投稿文ファイル: `' + m.txtName + '`  ← **コピー元はこちら**');
  push('- 画像ファイル: `' + m.pngName + '`  ← **必ず添付してください（この投稿は画像が主役です）**');
  push('- 集計期間: ' + m.window.from + '〜' + m.window.to + '（実行日を含む週の月〜日）');
  push('- 集計結果: ' + m.agg.eventCount + 'イベント / 上位入賞 ' + m.agg.deckTotal + 'デッキ');
  push('- 文字数: ' + m.fitted.weighted + ' / ' + daily.CONFIG.MAX_WEIGHTED_LENGTH
    + '（X の数え方。' + (m.fitted.over ? '**上限を超えています**' : '上限内なのでそのまま投稿できます') + '）');
  if (m.fitted.dropped.length) {
    push('- 補足: 長さの都合で ' + m.fitted.dropped.join(' / ') + ' を省略しています');
  }
  if (m.fitted.over) {
    push('- **⚠ 上限を超えています。そのままでは投稿できません。**');
    push('  文面を短くするか、この週は見送ってください。');
  }
  push();
  push('- 画像の内容（目視確認用）:');
  for (const r of m.agg.rows) {
    push('  - ' + r.label + '  ' + r.share + '%  (' + r.count + 'デッキ)');
  }
  push();
  push('```');
  for (const line of m.fitted.text.split('\n')) push(line);
  push('```');
  push();
}

// ===================================================================
// --unmark（予約しなかった日を夜間自動へ戻す）
// ===================================================================
function unmark(args) {
  const dryRun = !!args.flags['--dry-run'];
  const date = args.opts['--unmark'];
  const today = todayJst();

  assertNotBatchWindow();
  assertDateFormat('--unmark', date);

  for (const k of ['--start', '--days', '--out']) {
    if (args.opts[k] !== undefined) throw new Error('--unmark と ' + k + ' は同時に指定できません');
  }

  log('起動（--unmark）' + (dryRun ? ' *** DRY-RUN ***' : ''));
  if (TEST_NOW) logWarn('X_PACK_TEST_NOW が設定されています（テスト専用）: ' + TEST_NOW);
  log('実行日(JST) ' + today + ' / 対象 ' + date);
  log('状態ファイル: ' + daily._internal.STATE_FILE);

  const d = diffDays(date, today);
  if (d === 0) {
    throw new Error('当日（' + date + '）は取り消せません。'
      + '午前 ' + PACK.PLANNED_TIME + ' の予約が既に投稿されている場合、'
      + 'その夜の自動投稿と同日二重投稿になるためです');
  }
  if (d < 0) {
    throw new Error('過去日（' + date + '）は取り消せません（翌日以降のみ）。'
      + '扱いは松岡さん経由で発行元へご確認ください');
  }

  const st = readState();
  if (!st.ok) {
    throw new Error('状態ファイルを読めません（' + st.reason + '）: ' + st.message
      + ' / 退避・再作成は行いません');
  }
  const key = 'daily:' + date;
  const e = st.state.entries[key];
  if (!e) throw new Error(key + ' は状態ファイルに存在しません（既に取り消し済み、またはパック対象外の日です）');
  if (e.status !== PACK.STATUS) {
    throw new Error(key + ' の status は "' + (e.status || '?') + '" です。'
      + '取り消せるのは "' + PACK.STATUS + '"（このツールが予約用に記録した日）だけです');
  }

  log('対象: ' + key + ' / card_id=' + (e.card_id || '?') + ' / status=' + e.status);
  if (dryRun) {
    log('[DRY-RUN] 状態ファイルは書き換えていません（0 件）');
    return;
  }
  delete st.state.entries[key];
  writeStateAtomic(st.state);
  log(key + ' を削除しました。' + date + ' は夜間の自動投稿に戻ります');
  logWarn('X 側の予約が残っていると二重投稿になります。先に X の予約を取り消したか確認してください');
}

// ===================================================================
// main
// ===================================================================
async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(USAGE);
    console.error('');
    console.error('[post-x-weekly-pack] *** ERROR *** ' + e.message);
    process.exitCode = 1;
    return;
  }
  if (args.flags['--help']) { console.log(USAGE); return; }

  try {
    if (args.opts['--unmark'] !== undefined) unmark(args);
    else await generate(args);
  } catch (e) {
    logError(e.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((e) => {
    logError('想定外の例外: ' + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  });
}

module.exports = {
  main, generate, unmark, parseArgs, buildChecklist, buildMondaySummary, PACK,
  _internal: { todayJst, fileBase, warnIfNotExpectedDow }
};
