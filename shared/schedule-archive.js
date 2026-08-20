// shared/schedule-archive.js
// 指示書65: スケジュールのアーカイブ保存化(開催済みイベントの保全)
//
// 役割:
//   data/schedule.json は「今後のイベントのみ」を毎晩フル置換で保存するため、
//   開催日を過ぎたイベントの記録(開催日時・店舗・シリーズ)が毎晩失われる。
//   本モジュールは schedule.json 形式のオブジェクトを受け取り、
//   別ファイル data/schedule_archive.json へ「これまでに観測した全イベント」を
//   upsert で蓄積する。schedule.json 自体には一切触れない。
//
// 使い方(スクリプトから):
//   const { updateArchive } = require('./shared/schedule-archive');
//   const stats = updateArchive(archivePath, [prevSchedule, output].filter(Boolean));
//
// 使い方(CLI・初期シード/検証用。ネットワークアクセス・push は一切しない):
//   node shared/schedule-archive.js --archive <path> --seed <file1> <file2> ...
//
// 設計上の約束(呼び出し側の安全のため厳守):
//   * 完全同期。async にしない・Promise を返さない(呼び出し側に await を足させない)。
//   * sources を一切ミューテートしない(schedule.json 側のオブジェクトを汚染しない)。
//   * CLI 部は require.main === module ガード内のみ。require 経路では絶対に到達しない。
//   * process.exit は一切呼ばない(呼び出し元の終了コードを変えない)。

'use strict';

const fs = require('fs');
const path = require('path');

const ARCHIVE_VERSION = 1;

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

function stripBOM(text) {
  return typeof text === 'string' ? text.replace(/^\uFEFF/, '') : text;
}

function nowISO() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * ISO 8601 文字列を toISOString 形式(YYYY-MM-DDTHH:mm:ss.sssZ)へ正規化する。
 * パースできない場合は null。
 */
function toCanonicalISO(value) {
  if (typeof value !== 'string' || value === '') return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/**
 * a が b より古い観測時刻か。両方パースできれば数値比較、できなければ文字列比較。
 * (本モジュールが書く値は必ず正規化済みなので通常は数値比較になる)
 */
function isOlderThan(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta < tb;
  return a < b;
}

/** ファイル名用タイムスタンプ YYYYMMDD-HHmmss(ローカル時刻) */
function fileStamp(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p2(d.getMonth() + 1) +
    p2(d.getDate()) +
    '-' +
    p2(d.getHours()) +
    p2(d.getMinutes()) +
    p2(d.getSeconds())
  );
}

function warn(message) {
  console.log('[schedule-archive] WARN ' + message);
}

// ---------------------------------------------------------------------------
// アーカイブの読み書き
// ---------------------------------------------------------------------------

function createEmptyArchive() {
  return {
    version: ARCHIVE_VERSION,
    created_at: nowISO(),
    last_updated: null,
    series: {},
    events: {},
    stores: {}
  };
}

/**
 * 壊れた既存アーカイブを .corrupt-<YYYYMMDD-HHmmss> へ退避する。
 * 退避に失敗した場合は上書きせず例外を投げる(壊れたデータを捨てないため)。
 */
function quarantineArchive(archivePath) {
  const base = archivePath + '.corrupt-' + fileStamp(new Date());
  let target = base;
  let n = 1;
  while (fs.existsSync(target)) {
    target = base + '-' + n;
    n += 1;
    if (n > 1000) throw new Error('退避先ファイル名を決められませんでした: ' + base);
  }
  fs.renameSync(archivePath, target);
  return target;
}

/**
 * 既存アーカイブを読む。無ければ新規、壊れていれば退避して新規。
 */
function loadArchive(archivePath) {
  if (!fs.existsSync(archivePath)) return createEmptyArchive();

  let parsed = null;
  let broken = null;
  try {
    parsed = JSON.parse(stripBOM(fs.readFileSync(archivePath, 'utf-8')));
  } catch (e) {
    broken = e;
  }
  if (!broken && !isPlainObject(parsed)) {
    broken = new Error('トップレベルがオブジェクトではありません');
  }
  if (!broken) {
    // 部分的な破損(series/events/stores のいずれかがオブジェクトでない)も
    // 黙って捨てずに退避する。静かに {} へリセットすると復旧不能になるため。
    const bad = ['series', 'events', 'stores'].filter(k => !isPlainObject(parsed[k]));
    if (bad.length > 0) {
      broken = new Error(bad.join('/') + ' がオブジェクトではありません');
    }
  }
  if (broken) {
    const moved = quarantineArchive(archivePath);
    warn(
      '既存アーカイブを読めませんでした(' + broken.message + ')。' +
        moved + ' へ退避し、新規作成します'
    );
    return createEmptyArchive();
  }

  // メタ情報の欠落は補う(データを失わないので退避不要)
  if (typeof parsed.version !== 'number') parsed.version = ARCHIVE_VERSION;
  if (typeof parsed.created_at !== 'string') parsed.created_at = nowISO();
  return parsed;
}

/**
 * 原子書き込み。一時ファイルは archivePath と同一ディレクトリに作る
 * (別ボリュームだと Windows の rename が EXDEV で失敗するため)。
 */
function writeArchiveAtomic(archivePath, archive) {
  const dir = path.dirname(archivePath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = archivePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(archive), 'utf-8');
  fs.renameSync(tmpPath, archivePath);
}

// ---------------------------------------------------------------------------
// upsert 本体
// ---------------------------------------------------------------------------

/**
 * 1エントリを upsert する。
 * 戻り値: 'added' | 'updated' | 'stale'
 *
 * 既存エントリは「既存の上に source のフィールドを重ねる」方式で更新する。
 * source が持たないフィールド(例: apply_end_datetime が落ちた観測)は
 * 過去の観測値を保持する ― 本ファイルの目的が保全であるため。
 */
function upsertEntry(bucket, key, fields, observedAt, extra) {
  const existing = bucket[key];

  if (!existing) {
    const entry = Object.assign({}, fields, extra || {});
    entry.first_seen = observedAt;
    entry.last_seen = observedAt;
    bucket[key] = entry;
    return 'added';
  }

  // 既存の last_seen より古い観測は、フィールドを上書きしない。
  // ただし first_seen より古ければ「初観測時刻」は前倒しする。
  if (isOlderThan(observedAt, existing.last_seen)) {
    if (isOlderThan(observedAt, existing.first_seen)) existing.first_seen = observedAt;
    return 'stale';
  }

  const merged = Object.assign({}, existing, fields, extra || {});
  merged.first_seen = isOlderThan(observedAt, existing.first_seen)
    ? observedAt
    : existing.first_seen;
  merged.last_seen = observedAt;
  bucket[key] = merged;
  return 'updated';
}

/**
 * アーカイブへ複数 source を upsert して書き戻す。
 *
 * @param {string} archivePath data/schedule_archive.json のパス
 * @param {Array<object>} sources schedule.json 形式のオブジェクトの配列(古い順推奨)
 * @returns {{events_total:number, events_added:number, events_updated:number,
 *            stores_total:number, series_total:number,
 *            per_source:Array<{label:string, added:number, updated:number,
 *                              stale:number, skipped:boolean, reason:(string|null),
 *                              observed_at:(string|null),
 *                              stores_added:number, stores_updated:number,
 *                              series_added:number, series_updated:number}>}}
 */
function updateArchive(archivePath, sources) {
  if (typeof archivePath !== 'string' || archivePath === '') {
    throw new TypeError('archivePath は非空の文字列である必要があります');
  }
  if (!Array.isArray(sources)) {
    throw new TypeError('sources は配列である必要があります');
  }

  const archive = loadArchive(archivePath);

  let eventsAdded = 0;
  let eventsUpdated = 0;
  const perSource = [];

  for (const source of sources) {
    const stat = {
      label: '(不明)',
      added: 0,
      updated: 0,
      stale: 0,
      skipped: false,
      reason: null,
      observed_at: null,
      stores_added: 0,
      stores_updated: 0,
      series_added: 0,
      series_updated: 0
    };

    if (!isPlainObject(source)) {
      stat.skipped = true;
      stat.reason = 'source がオブジェクトではありません';
      warn('source をスキップしました: ' + stat.reason);
      perSource.push(stat);
      continue;
    }

    stat.label =
      typeof source.last_updated === 'string' && source.last_updated !== ''
        ? source.last_updated
        : '(last_updated 欠落)';

    if (!isPlainObject(source.events) && !Array.isArray(source.series) && !isPlainObject(source.stores)) {
      stat.skipped = true;
      stat.reason = 'schedule.json 形式(series/events/stores)ではありません';
      warn('source をスキップしました[' + stat.label + ']: ' + stat.reason);
      perSource.push(stat);
      continue;
    }

    const observedAt = toCanonicalISO(source.last_updated) || nowISO();
    stat.observed_at = observedAt;

    // --- series ---
    if (Array.isArray(source.series)) {
      for (const s of source.series) {
        if (!isPlainObject(s)) continue;
        const sid = s.event_series_id;
        if (sid === undefined || sid === null || sid === '') continue;
        const r = upsertEntry(
          archive.series,
          String(sid),
          { event_series_title: s.event_series_title },
          observedAt,
          null
        );
        if (r === 'added') stat.series_added += 1;
        else if (r === 'updated') stat.series_updated += 1;
      }
    }

    // --- events ---
    if (isPlainObject(source.events)) {
      for (const sid of Object.keys(source.events)) {
        const list = source.events[sid];
        if (!Array.isArray(list)) continue;
        for (const ev of list) {
          if (!isPlainObject(ev)) continue;
          const eid = ev.id;
          if (eid === undefined || eid === null || eid === '') continue;
          const r = upsertEntry(archive.events, String(eid), ev, observedAt, {
            series_id: sid
          });
          if (r === 'added') {
            stat.added += 1;
            eventsAdded += 1;
          } else if (r === 'updated') {
            stat.updated += 1;
            eventsUpdated += 1;
          } else {
            stat.stale += 1;
          }
        }
      }
    }

    // --- stores ---
    if (isPlainObject(source.stores)) {
      for (const oid of Object.keys(source.stores)) {
        const st = source.stores[oid];
        if (!isPlainObject(st)) continue;
        const r = upsertEntry(archive.stores, String(oid), st, observedAt, null);
        if (r === 'added') stat.stores_added += 1;
        else if (r === 'updated') stat.stores_updated += 1;
      }
    }

    perSource.push(stat);
  }

  archive.version = ARCHIVE_VERSION;
  archive.last_updated = nowISO();

  writeArchiveAtomic(archivePath, archive);

  return {
    events_total: Object.keys(archive.events).length,
    events_added: eventsAdded,
    events_updated: eventsUpdated,
    stores_total: Object.keys(archive.stores).length,
    series_total: Object.keys(archive.series).length,
    per_source: perSource
  };
}

module.exports = { updateArchive, ARCHIVE_VERSION };

// ---------------------------------------------------------------------------
// CLI(初期シードと検証用の薄いラッパ)
//   ネットワークアクセス・push・process.exit は一切行わない。
// ---------------------------------------------------------------------------

if (require.main === module) {
  const USAGE =
    'Usage: node shared/schedule-archive.js --archive <path> --seed <file1> [<file2> ...]';

  const argv = process.argv.slice(2);
  let archivePath = null;
  const seedFiles = [];
  let mode = null;
  let argError = null;

  for (const a of argv) {
    if (a === '--archive') {
      mode = 'archive';
    } else if (a === '--seed') {
      mode = 'seed';
    } else if (a.startsWith('--')) {
      argError = '未知のオプション: ' + a;
      break;
    } else if (mode === 'archive') {
      if (archivePath === null) archivePath = a;
      else {
        argError = '--archive は1つだけ指定してください';
        break;
      }
    } else if (mode === 'seed') {
      seedFiles.push(a);
    } else {
      argError = '位置引数の前に --archive / --seed を指定してください: ' + a;
      break;
    }
  }

  if (!argError && !archivePath) argError = '--archive が指定されていません';
  if (!argError && seedFiles.length === 0) argError = '--seed が1つも指定されていません';

  if (argError) {
    console.log('[schedule-archive] 引数エラー: ' + argError);
    console.log(USAGE);
  } else {
    const loaded = [];
    const labels = [];
    for (const f of seedFiles) {
      try {
        const obj = JSON.parse(stripBOM(fs.readFileSync(f, 'utf-8')));
        loaded.push(obj);
        labels.push(f);
      } catch (e) {
        warn('source を読めませんでした(スキップ): ' + f + ' — ' + e.message);
      }
    }

    if (loaded.length === 0) {
      console.log('[schedule-archive] 読み込めた source が 0 件のため、何もしませんでした');
    } else {
      try {
        const stats = updateArchive(archivePath, loaded);
        console.log('[schedule-archive] archive: ' + archivePath);
        stats.per_source.forEach((s, i) => {
          console.log(
            '  source[' + i + '] ' +
              (labels[i] || '(不明)') +
              ' last_updated=' + s.label +
              (s.skipped
                ? ' → SKIP (' + s.reason + ')'
                : ' → events +' + s.added + ' new / ~' + s.updated + ' updated / ' +
                  s.stale + ' stale, stores +' + s.stores_added + ' / ~' + s.stores_updated +
                  ', series +' + s.series_added + ' / ~' + s.series_updated)
          );
        });
        console.log(
          '[schedule-archive] events=' + stats.events_total +
            ' (+' + stats.events_added + ' new, ~' + stats.events_updated + ' updated)' +
            ' stores=' + stats.stores_total +
            ' series=' + stats.series_total
        );
      } catch (e) {
        console.log('[schedule-archive] 失敗: ' + e.message);
      }
    }
  }
}
