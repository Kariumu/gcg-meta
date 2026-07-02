#!/usr/bin/env node
/**
 * GCG STATS サイト整合性監視システム (Site Integrity Monitor) - Phase 2
 * 設計書: design-site-integrity-monitor.md 準拠(4.1〜4.4)
 *
 * 使い方:
 *   node tools/integrity/scan.js                     フルスキャン(検出詳細+サマリー+report.html生成)
 *   node tools/integrity/scan.js --summary           サマリーのみ(自動実行フロー相乗り用)
 *   node tools/integrity/scan.js --json              スキャン結果JSONを標準出力にも出す
 *   node tools/integrity/scan.js --root <dir>        検査対象ルートを差し替え(テスト用)。
 *                                                    rules/state/reports も <dir>/tools/integrity/ 配下を使い、
 *                                                    実サイトの台帳・データには一切触れない
 *   node tools/integrity/scan.js ack <issue_id>      台帳の issue を acknowledged(認知済み)にする
 *   node tools/integrity/scan.js start <issue_id>    台帳の issue を in_progress(着手)にする
 *
 * 状態遷移(設計書4.3):
 *   open ──(ack)──> acknowledged ──(start)──> in_progress
 *   open系(open/acknowledged/in_progress/regressed)がスキャンで未検出 → resolved(自動のみ)
 *   resolved が再検出 → regressed(regression_count +1)。再び未検出になれば resolved に戻る
 *   ※ resolved への手動遷移コマンドは意図的に存在しない(「直したつもり」防止)
 *   ※ checker が実行失敗したルールの issue は誤 resolved を防ぐため遷移させない
 *
 * Phase 1 からの checker(検出ロジックは無変更):
 *   file_exists_for_each / internal_links_valid / image_refs_valid
 *   no_orphan_files / cross_data_consistent / required_fields
 *
 * 制約(設計書7章 / Step 0承認事項):
 *   - サイト公開ファイル・データソースへの書き込みは行わない(書き込みは state/ と reports/ のみ)
 *   - 検出した問題の修正は行わない(検出と修正の分離)
 *   - 既存 check-site-integrity.js とは併存(本スクリプトから参照しない)
 *   - いかなる失敗でも終了コード 0(自動実行フロー相乗り時に後続処理を止めない)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===== 引数解釈 =====
const rawArgs = process.argv.slice(2);
const args = [];
let rootOverride = null;
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--root') {
    rootOverride = rawArgs[i + 1];
    i++;
  } else {
    args.push(rawArgs[i]);
  }
}
const SUMMARY_ONLY = args.includes('--summary');
const OUT_JSON = args.includes('--json');
const positional = args.filter((a) => !a.startsWith('--'));
const SUBCOMMAND = positional[0] || null; // ack / start / なし(スキャン)

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..'); // リポジトリルート(サイト公開ルート)
const ROOT = rootOverride ? path.resolve(rootOverride) : DEFAULT_ROOT;
// --root 指定時は rules/state/reports もフィクスチャ側に切り替え、実台帳を保護する
const BASE_DIR = rootOverride ? path.join(ROOT, 'tools', 'integrity') : __dirname;
const RULES_DIR = fs.existsSync(path.join(BASE_DIR, 'rules')) ? path.join(BASE_DIR, 'rules') : path.join(__dirname, 'rules');
const STATE_DIR = path.join(BASE_DIR, 'state');
const REPORTS_DIR = path.join(BASE_DIR, 'reports');
const ISSUES_PATH = path.join(STATE_DIR, 'issues.json');
const ISSUES_BAK_PATH = path.join(STATE_DIR, 'issues.json.bak');
const LAST_SCAN_PATH = path.join(STATE_DIR, 'last-scan.json');

const C = { reset: '\x1b[0m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', magenta: '\x1b[35m', gray: '\x1b[90m' };
const SEV_COLOR = { error: C.red, warning: C.yellow, info: C.cyan };
const OPEN_STATUSES = ['open', 'acknowledged', 'in_progress', 'regressed'];

// ===================================================================
// 最小YAMLパーサ(rules/*.yaml 専用)
// 対応構文: トップレベルのリスト(- key: value)、インデント2のスカラー、
//           params: 配下(インデント4)のスカラー、インライン配列 [a, b]、# コメント行
// ===================================================================
function parseScalar(v) {
  if (v === undefined || v === null) return '';
  v = String(v).trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((s) => parseScalar(s));
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function splitKV(s) {
  const i = s.indexOf(':');
  if (i === -1) return [null, null];
  return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}

function parseRulesYaml(text, fileName) {
  const rules = [];
  let cur = null;
  let curMap = null; // params: 配下を構築中なら参照が入る
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;

    if (indent === 0 && trimmed.startsWith('- ')) {
      cur = { _file: fileName };
      curMap = null;
      rules.push(cur);
      const [k, v] = splitKV(trimmed.slice(2));
      if (k) cur[k] = parseScalar(v);
      continue;
    }
    if (!cur) throw new Error(`${fileName}:${n + 1} リスト項目の外にキーがあります`);

    const [k, v] = splitKV(trimmed);
    if (k === null) throw new Error(`${fileName}:${n + 1} "key: value" 形式ではありません: ${trimmed}`);

    if (indent >= 4 && curMap) {
      curMap[k] = parseScalar(v);
    } else if (v === '') {
      cur[k] = {};
      curMap = cur[k];
    } else {
      cur[k] = parseScalar(v);
      curMap = null;
    }
  }
  return rules;
}

// ===================================================================
// 共通ヘルパー(サイト側はすべて読み取り専用)
// ===================================================================
function loadJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

/** データソース定義 → [キー, 値] ペア配列を取り出す */
function sourceEntries(params, prefix) {
  const rel = params[prefix];
  let data = loadJson(rel);
  const rootKey = params[`${prefix}_root`];
  if (rootKey) {
    data = data[rootKey];
    if (data === undefined) throw new Error(`${rel} にキー "${rootKey}" がありません`);
  }
  if (Array.isArray(data)) return data.map((v, i) => [String(i), v]);
  if (data && typeof data === 'object') return Object.keys(data).map((k) => [k, data[k]]);
  throw new Error(`${rel} はオブジェクト/配列ではありません`);
}

/** パラレルID(GD01-001_p1 等)をベースIDに正規化 */
function stripParallel(id) {
  return String(id).replace(/_p\d+$/i, '');
}

function normalizeKeys(keys, mode) {
  if (mode === 'strip_parallel') return keys.map(stripParallel);
  return keys;
}

function listHtmlFiles(dirRel) {
  const out = [];
  const walk = (dirAbs) => {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const p = path.join(dirAbs, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.html')) out.push(p);
    }
  };
  walk(path.join(ROOT, dirRel));
  return out;
}

/** リンク/画像参照の対象外判定(外部URL・アンカー・ビルド時テンプレート断片など) */
function isSkippableRef(href) {
  if (!href) return true;
  if (href.startsWith('#')) return true;
  if (/^(https?:)?\/\//i.test(href)) return true;
  if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) return true;
  // JS内の動的URL組み立て(href="' + GCG.getBasePath() + '..." 等)は静的検査対象外
  if (href.includes("'") || href.includes('+') || href.includes('{')) return true;
  return false;
}

/** 参照文字列 → リポジトリ相対の実ファイルパスに解決。存在すれば null、欠損なら相対パスを返す */
function resolveMissing(fileAbs, ref) {
  let target = ref.split('#')[0].split('?')[0];
  if (!target) return null; // 純粋なアンカー/クエリのみ
  try {
    target = decodeURIComponent(target);
  } catch (_) {
    /* デコード不能でもそのまま検査 */
  }
  let abs = target.startsWith('/')
    ? path.join(ROOT, target)
    : path.resolve(path.dirname(fileAbs), target);
  if (!abs.startsWith(ROOT + path.sep)) return null; // ルート外に出る参照は対象外
  if (target.endsWith('/')) abs = path.join(abs, 'index.html');
  if (fs.existsSync(abs)) {
    // ディレクトリへのリンクは index.html が無ければ GitHub Pages で404
    if (fs.statSync(abs).isDirectory()) {
      const idx = path.join(abs, 'index.html');
      if (!fs.existsSync(idx)) return path.relative(ROOT, idx).split(path.sep).join('/');
    }
    return null;
  }
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

/** scope配下のHTMLから pattern で参照を抽出し、欠損先ごとに集約した findings を返す */
function scanRefs(rule, extractRegexes) {
  const scopes = Array.isArray(rule.params.scope) ? rule.params.scope : [rule.params.scope];
  const missing = new Map(); // 欠損先パス → { referrers:Set, refCount:number }
  let scannedFiles = 0;
  for (const scope of scopes) {
    for (const fileAbs of listHtmlFiles(scope)) {
      scannedFiles++;
      const html = fs.readFileSync(fileAbs, 'utf8');
      const fileRel = path.relative(ROOT, fileAbs).split(path.sep).join('/');
      for (const re of extractRegexes) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(html)) !== null) {
          const ref = m[1];
          if (isSkippableRef(ref)) continue;
          const miss = resolveMissing(fileAbs, ref);
          if (!miss) continue;
          if (!missing.has(miss)) missing.set(miss, { referrers: new Set(), refCount: 0 });
          const rec = missing.get(miss);
          rec.referrers.add(fileRel);
          rec.refCount++;
        }
      }
    }
  }
  const findings = [];
  for (const [target, rec] of missing) {
    const refs = [...rec.referrers];
    const head = refs.slice(0, 3).join(', ');
    const more = refs.length > 3 ? ` 他${refs.length - 3}ファイル` : '';
    findings.push({
      target,
      detail: `参照元: ${head}${more}(参照元${refs.length}ファイル / 計${rec.refCount}箇所)`,
    });
  }
  return { findings, scannedFiles };
}

// ===================================================================
// checker 実装(Phase 1 から無変更)
// 各checkerは findings 配列を返す: { target, detail, severity? }
// severity 未指定の finding はルールの severity を継承する
// ===================================================================
const CHECKERS = {
  /** データソースの各要素に対応するファイルが存在するか */
  file_exists_for_each(rule) {
    const findings = [];
    const entries = sourceEntries(rule.params, 'source');
    for (const [key] of entries) {
      const targetRel = rule.params.target_pattern.replace('{key}', key);
      if (!fs.existsSync(path.join(ROOT, targetRel))) {
        findings.push({ target: targetRel, detail: `${rule.params.source} のキー "${key}" に対応するページが存在しない` });
      }
    }
    return { findings, checked: entries.length };
  },

  /** 逆方向: データソースに存在しないファイル(孤児ページ)がないか */
  no_orphan_files(rule) {
    const findings = [];
    const known = new Set(sourceEntries(rule.params, 'source').map(([k]) => k));
    const scanDirAbs = path.join(ROOT, rule.params.scan_dir);
    const dirs = fs
      .readdirSync(scanDirAbs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const d of dirs) {
      if (!known.has(d)) {
        findings.push({
          target: `${rule.params.scan_dir}/${d}/index.html`,
          detail: `"${d}" は ${rule.params.source} に存在しない(孤児ページ)`,
        });
      }
    }
    return { findings, checked: dirs.length };
  },

  /** 2つのデータソース間でキーが一致するか(方向別severity) */
  cross_data_consistent(rule) {
    const findings = [];
    const p = rule.params;
    const leftKeys = new Set(normalizeKeys(sourceEntries(p, 'left').map(([k]) => k), p.left_normalize));
    const rightKeys = new Set(normalizeKeys(sourceEntries(p, 'right').map(([k]) => k), p.right_normalize));
    for (const k of rightKeys) {
      if (!leftKeys.has(k)) {
        findings.push({
          target: `${p.right}#${k}`,
          detail: `"${k}" は ${p.right} のみに存在し ${p.left} に無い`,
          severity: p.right_only_severity || rule.severity,
        });
      }
    }
    for (const k of leftKeys) {
      if (!rightKeys.has(k)) {
        findings.push({
          target: `${p.left}#${k}`,
          detail: `"${k}" は ${p.left} のみに存在し ${p.right} に無い(テキスト未収録)`,
          severity: p.left_only_severity || rule.severity,
        });
      }
    }
    return { findings, checked: leftKeys.size + rightKeys.size };
  },

  /** データソースの各要素に必須フィールドが揃っているか */
  required_fields(rule) {
    const findings = [];
    const entries = sourceEntries(rule.params, 'source');
    const fields = rule.params.fields || [];
    for (const [key, value] of entries) {
      for (const f of fields) {
        const v = value ? value[f] : undefined;
        if (v === undefined || v === null || v === '') {
          findings.push({
            target: `${rule.params.source}#${key}.${f}`,
            detail: `イベント "${key}" に必須フィールド "${f}" が無い`,
          });
        }
      }
    }
    return { findings, checked: entries.length };
  },

  /** HTML内の内部リンク(href)先が実在するか */
  internal_links_valid(rule) {
    return scanRefs(rule, [/<a\b[^>]*?\bhref\s*=\s*"([^"]*)"/gi, /<a\b[^>]*?\bhref\s*=\s*'([^']*)'/gi]);
  },

  /** imgタグ参照先の画像ファイルが実在するか */
  image_refs_valid(rule) {
    return scanRefs(rule, [/<img\b[^>]*?\bsrc\s*=\s*"([^"]*)"/gi, /<img\b[^>]*?\bsrc\s*=\s*'([^']*)'/gi]);
  },
};

// ===================================================================
// 問題台帳(issues.json)
// ===================================================================
function issueId(ruleId, target) {
  const h = crypto.createHash('sha1').update(String(target)).digest('hex').slice(0, 6);
  return `${ruleId}-${h}`;
}

/**
 * 台帳の読み込み。ファイル不在は空台帳(初回)として扱うが、
 * 存在するのに JSON として壊れている場合は例外を投げる(黙って空扱いにして
 * 全issueを「新規」で上書きしてしまう事故を防ぐ)。
 */
function loadIssuesStrict() {
  if (!fs.existsSync(ISSUES_PATH)) return [];
  const text = fs.readFileSync(ISSUES_PATH, 'utf8');
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('配列ではありません');
    return data;
  } catch (e) {
    throw new Error(
      `台帳 ${ISSUES_PATH} が破損しています(${e.message})。` +
        `台帳への書き込みを中止しました。issues.json.bak からの復旧を検討してください。`
    );
  }
}

/** 台帳の保存。上書き前に既存台帳を issues.json.bak へ退避する */
function saveIssues(issues) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (fs.existsSync(ISSUES_PATH)) {
    fs.copyFileSync(ISSUES_PATH, ISSUES_BAK_PATH);
  }
  fs.writeFileSync(ISSUES_PATH, JSON.stringify(issues, null, 2) + '\n');
}

// ===================================================================
// report.html 生成(設計書4.4)
// ===================================================================
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function daysBetween(fromYmd, toYmd) {
  const ms = new Date(toYmd + 'T00:00:00Z') - new Date(fromYmd + 'T00:00:00Z');
  return Math.max(0, Math.round(ms / 86400000));
}

const STATUS_LABEL = {
  open: 'open(未対応)',
  acknowledged: 'acknowledged(認知済み)',
  in_progress: 'in_progress(対応中)',
  regressed: 'regressed(再発)',
  resolved: 'resolved(解決済み)',
};

function issueRowsHtml(list, today) {
  const rows = list
    .map((i) => {
      const days = OPEN_STATUSES.includes(i.status) ? daysBetween(i.first_detected, today) : '-';
      return (
        `<tr class="sev-${esc(i.severity)} st-${esc(i.status)}">` +
        `<td class="mono">${esc(i.issue_id)}</td>` +
        `<td><span class="badge sev-${esc(i.severity)}">${esc(i.severity)}</span></td>` +
        `<td><span class="badge st-${esc(i.status)}">${esc(i.status)}</span>${i.regression_count ? `<span class="badge regcount">再発×${i.regression_count}</span>` : ''}</td>` +
        `<td class="mono">${esc(i.target)}</td>` +
        `<td>${esc(i.detail)}</td>` +
        `<td class="num">${esc(i.first_detected)}</td>` +
        `<td class="num">${days}</td>` +
        `</tr>`
      );
    })
    .join('\n');
  return (
    '<table><thead><tr><th>issue_id</th><th>severity</th><th>status</th><th>対象</th><th>詳細</th><th>初検出</th><th>放置日数</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`
  );
}

function generateReportHtml(issues, scanInfo, today) {
  const active = issues.filter((i) => OPEN_STATUSES.includes(i.status));
  const resolved = issues.filter((i) => i.status === 'resolved');
  const regressed = active.filter((i) => i.status === 'regressed');

  const sevCount = { error: 0, warning: 0, info: 0 };
  for (const i of active) sevCount[i.severity] = (sevCount[i.severity] || 0) + 1;
  const stCount = {};
  for (const i of issues) stCount[i.status] = (stCount[i.status] || 0) + 1;

  const worst = [...active].sort((a, b) => a.first_detected.localeCompare(b.first_detected)).slice(0, 20);

  const ruleIds = [...new Set(issues.map((i) => i.rule_id))].sort();
  const ruleSections = ruleIds
    .map((rid) => {
      const list = active.filter((i) => i.rule_id === rid);
      if (list.length === 0) return '';
      return (
        `<details ${list.some((i) => i.status === 'regressed') ? 'open' : ''}>` +
        `<summary>${esc(rid)} — ${list.length} 件</summary>` +
        issueRowsHtml(list, today) +
        '</details>'
      );
    })
    .join('\n');

  const sevRow = (label, n, cls) => `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${esc(label)}</div></div>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>サイト整合性レポート ${esc(today)} | GCG STATS Site Integrity Monitor</title>
<style>
  :root { --err:#c62828; --warn:#b26a00; --info:#1565c0; --reg:#7b1fa2; --ok:#2e7d32; --muted:#666; }
  body { font-family: "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif; margin: 0; background:#f5f6f8; color:#222; }
  header { background:#1a1d24; color:#fff; padding:16px 24px; }
  header h1 { margin:0; font-size:18px; }
  header .sub { color:#9aa3b2; font-size:12px; margin-top:4px; }
  main { max-width:1200px; margin:0 auto; padding:16px 24px 48px; }
  h2 { font-size:15px; border-left:4px solid #1a1d24; padding-left:8px; margin:28px 0 10px; }
  .stats { display:flex; gap:12px; flex-wrap:wrap; }
  .stat { background:#fff; border-radius:8px; padding:10px 18px; min-width:110px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .stat .n { font-size:24px; font-weight:700; }
  .stat .l { font-size:11px; color:var(--muted); }
  .stat.err .n { color:var(--err); } .stat.warn .n { color:var(--warn); } .stat.info .n { color:var(--info); }
  .stat.reg .n { color:var(--reg); } .stat.ok .n { color:var(--ok); }
  table { border-collapse:collapse; width:100%; background:#fff; font-size:12px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  th, td { border-bottom:1px solid #e4e6ea; padding:6px 8px; text-align:left; vertical-align:top; }
  th { background:#eceff3; font-size:11px; white-space:nowrap; }
  td.num { text-align:right; white-space:nowrap; }
  .mono { font-family: Consolas, Menlo, monospace; font-size:11px; word-break:break-all; }
  .badge { display:inline-block; padding:1px 7px; border-radius:9px; font-size:10px; color:#fff; margin-right:4px; white-space:nowrap; }
  .badge.sev-error { background:var(--err); } .badge.sev-warning { background:var(--warn); } .badge.sev-info { background:var(--info); }
  .badge.st-open { background:#546e7a; } .badge.st-acknowledged { background:#0277bd; }
  .badge.st-in_progress { background:#00695c; } .badge.st-regressed { background:var(--reg); }
  .badge.st-resolved { background:var(--ok); } .badge.regcount { background:var(--reg); }
  details { margin:8px 0; background:#fff; border-radius:8px; padding:8px 12px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  summary { cursor:pointer; font-weight:600; font-size:13px; padding:4px 0; }
  .empty { color:var(--ok); background:#fff; border-radius:8px; padding:12px; font-size:13px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .note { color:var(--muted); font-size:11px; margin-top:6px; }
  section.regressed h2 { border-left-color:var(--reg); color:var(--reg); }
</style>
</head>
<body>
<header>
  <h1>GCG STATS サイト整合性レポート ${esc(today)}</h1>
  <div class="sub">Site Integrity Monitor / 生成: ${esc(scanInfo.scanned_at)} / 所要 ${(scanInfo.duration_ms / 1000).toFixed(1)}s / ルール ${scanInfo.rules.length} 件</div>
</header>
<main>
  <h2>サマリー(未解決 issue の severity 別)</h2>
  <div class="stats">
    ${sevRow('error', sevCount.error, 'err')}
    ${sevRow('warning', sevCount.warning, 'warn')}
    ${sevRow('info', sevCount.info || 0, 'info')}
    ${sevRow('未解決合計', active.length, '')}
  </div>

  <h2>status 別件数</h2>
  <div class="stats">
    ${OPEN_STATUSES.concat('resolved').map((s) => sevRow(STATUS_LABEL[s], stCount[s] || 0, s === 'regressed' ? 'reg' : s === 'resolved' ? 'ok' : '')).join('\n    ')}
  </div>

  <h2>今回スキャンの変動</h2>
  <div class="stats">
    ${sevRow('新規', scanInfo.new, 'err')}
    ${sevRow('継続', scanInfo.continuing, '')}
    ${sevRow('再発', scanInfo.regressed, 'reg')}
    ${sevRow('解決', scanInfo.resolved, 'ok')}
  </div>

  <section class="regressed">
  <h2>⚠ regressed(再発)— 最優先対応</h2>
  ${regressed.length ? issueRowsHtml(regressed, today) : '<div class="empty">再発 issue はありません</div>'}
  <div class="note">一度 resolved になった issue の再発は、修正フローに構造的欠陥がある兆候として扱う(設計書4.3)</div>
  </section>

  <h2>放置日数ワースト20(未解決)</h2>
  ${worst.length ? issueRowsHtml(worst, today) : '<div class="empty">未解決 issue はありません</div>'}

  <h2>ルール別一覧(未解決)</h2>
  ${ruleSections || '<div class="empty">未解決 issue はありません</div>'}

  <h2>resolved(解決済み)</h2>
  <details><summary>解決済み ${resolved.length} 件</summary>
  ${resolved.length ? issueRowsHtml(resolved, today) : '<div class="empty">なし</div>'}
  </details>
  <div class="note">resolved への遷移はスキャンの自動判定のみ。手動 resolved は存在しない(設計書4.3)</div>
</main>
</body>
</html>
`;
}

// ===================================================================
// サブコマンド: ack / start(手動の状態遷移)
// ===================================================================
function runStatusCommand(cmd, id) {
  const TO = { ack: 'acknowledged', start: 'in_progress' };
  const newStatus = TO[cmd];
  if (!id) {
    console.error(`${C.red}使い方: node scan.js ${cmd} <issue_id>${C.reset}`);
    return;
  }
  const issues = loadIssuesStrict();
  const issue = issues.find((i) => i.issue_id === id);
  if (!issue) {
    console.error(`${C.red}issue_id "${id}" は台帳に存在しません${C.reset}`);
    return;
  }
  if (issue.status === 'resolved') {
    console.error(`${C.red}"${id}" は resolved 済みです。再発すればスキャンが regressed に遷移させます(手動変更不可)${C.reset}`);
    return;
  }
  if (issue.status === newStatus) {
    console.log(`${C.yellow}"${id}" は既に ${newStatus} です(変更なし)${C.reset}`);
    return;
  }
  const before = issue.status;
  issue.status = newStatus;
  saveIssues(issues);
  console.log(`${C.green}[OK]${C.reset} ${id}: ${before} → ${newStatus}`);
  console.log(`${C.gray}     ${issue.rule_id} / ${issue.target}${C.reset}`);
}

// ===================================================================
// スキャン本体
// ===================================================================
function runScan() {
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // 台帳を先に読み込む(破損していればここで停止し、何も書き換えない)
  const ledger = loadIssuesStrict();

  // 1. ルール読込
  const ruleFiles = fs.readdirSync(RULES_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  const rules = [];
  for (const f of ruleFiles) {
    rules.push(...parseRulesYaml(fs.readFileSync(path.join(RULES_DIR, f), 'utf8'), f));
  }

  // 2. 各ルール実行
  const allFindings = [];
  const ruleStats = [];
  const ranRuleIds = new Set(); // 正常完了したルール(誤 resolved 防止のため、失敗ルールの issue は遷移させない)
  for (const rule of rules) {
    const checker = CHECKERS[rule.checker];
    if (!checker) {
      console.error(`${C.red}[SKIP]${C.reset} ${rule.id}: 未実装のchecker "${rule.checker}"`);
      ruleStats.push({ rule_id: rule.id, checker: rule.checker, skipped: true, findings: 0 });
      continue;
    }
    let result;
    try {
      result = checker(rule);
    } catch (e) {
      console.error(`${C.red}[FAIL]${C.reset} ${rule.id}: checker実行エラー: ${e.message}`);
      ruleStats.push({ rule_id: rule.id, checker: rule.checker, failed: e.message, findings: 0 });
      continue;
    }
    ranRuleIds.add(rule.id);
    for (const f of result.findings) {
      allFindings.push({
        rule_id: rule.id,
        rule_name: rule.name,
        target: f.target,
        detail: f.detail,
        severity: f.severity || rule.severity || 'warning',
      });
    }
    ruleStats.push({ rule_id: rule.id, checker: rule.checker, findings: result.findings.length });
  }

  // 3. 台帳と突合(状態遷移: 設計書4.3)
  const byId = new Map(ledger.map((i) => [i.issue_id, i]));
  let newCount = 0;
  let continuingCount = 0;
  let regressedCount = 0;
  let resolvedCount = 0;
  const detectedIds = new Set();

  for (const f of allFindings) {
    const id = issueId(f.rule_id, f.target);
    detectedIds.add(id);
    const existing = byId.get(id);
    if (existing) {
      if (existing.status === 'resolved') {
        // resolved が再検出された → regressed(設計書4.3)
        existing.status = 'regressed';
        existing.regression_count = (existing.regression_count || 0) + 1;
        existing.resolved_at = null;
        regressedCount++;
      } else {
        // open / acknowledged / in_progress / regressed は状態維持
        continuingCount++;
      }
      existing.last_seen = today;
      existing.detail = f.detail;
      existing.severity = f.severity;
    } else {
      byId.set(id, {
        issue_id: id,
        rule_id: f.rule_id,
        target: f.target,
        detail: f.detail,
        severity: f.severity,
        status: 'open',
        first_detected: today,
        last_seen: today,
        resolved_at: null,
        regression_count: 0,
      });
      newCount++;
    }
  }

  // 未検出になった open系 issue → resolved(自動遷移のみ。失敗ルールの issue は除外)
  for (const issue of byId.values()) {
    if (detectedIds.has(issue.issue_id)) continue;
    if (!ranRuleIds.has(issue.rule_id)) continue; // ルールが実行できていない → 判定不能なので遷移させない
    if (OPEN_STATUSES.includes(issue.status)) {
      issue.status = 'resolved';
      issue.resolved_at = today;
      resolvedCount++;
    }
  }

  const updated = [...byId.values()].sort(
    (a, b) => a.rule_id.localeCompare(b.rule_id) || a.target.localeCompare(b.target)
  );

  // 4. 保存(書き込みは state/ と reports/ のみ。台帳は .bak 退避後に上書き)
  saveIssues(updated);
  const lastScan = {
    scanned_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    rules: ruleStats,
    detected: allFindings.length,
    new: newCount,
    continuing: continuingCount,
    regressed: regressedCount,
    resolved: resolvedCount,
  };
  fs.writeFileSync(LAST_SCAN_PATH, JSON.stringify(lastScan, null, 2) + '\n');

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `report-${today}.html`);
  fs.writeFileSync(reportPath, generateReportHtml(updated, lastScan, today));

  // 5. コンソール出力
  if (!SUMMARY_ONLY) {
    for (const rule of rules) {
      const fs_ = allFindings.filter((f) => f.rule_id === rule.id);
      const stat = ruleStats.find((s) => s.rule_id === rule.id) || {};
      console.log(`\n${C.cyan}===== ${rule.id}: ${rule.name} =====${C.reset}`);
      if (stat.skipped) {
        console.log(`${C.gray}  (checker "${rule.checker}" は未実装のためスキップ)${C.reset}`);
        continue;
      }
      if (stat.failed) {
        console.log(`${C.red}  checker実行エラー: ${stat.failed}(この ルールの issue は状態遷移を保留)${C.reset}`);
        continue;
      }
      if (fs_.length === 0) {
        console.log(`${C.green}  問題なし${C.reset}`);
        continue;
      }
      const SHOW = 5;
      for (const f of fs_.slice(0, SHOW)) {
        const col = SEV_COLOR[f.severity] || C.yellow;
        console.log(`  ${col}[${f.severity.toUpperCase()}]${C.reset} ${f.target}`);
        console.log(`${C.gray}          ${f.detail}${C.reset}`);
      }
      if (fs_.length > SHOW) {
        console.log(`${C.gray}  ... 他 ${fs_.length - SHOW} 件(全件は state/issues.json を参照)${C.reset}`);
      }
    }
  }

  const sevCount = { error: 0, warning: 0, info: 0 };
  for (const f of allFindings) sevCount[f.severity] = (sevCount[f.severity] || 0) + 1;
  const regressedActive = updated.filter((i) => i.status === 'regressed');

  console.log(`\n${C.cyan}===== サマリー(severity別)=====${C.reset}`);
  console.log(`  ${C.red}error  : ${sevCount.error}${C.reset}`);
  console.log(`  ${C.yellow}warning: ${sevCount.warning}${C.reset}`);
  console.log(`  ${C.cyan}info   : ${sevCount.info || 0}${C.reset}`);
  console.log(`  検出合計: ${allFindings.length}(新規 ${newCount} / 継続 ${continuingCount} / 再発 ${regressedCount} / 解決 ${resolvedCount})`);
  if (regressedActive.length > 0) {
    console.log(`${C.magenta}  ⚠ regressed(再発)が ${regressedActive.length} 件あります — 最優先で確認してください${C.reset}`);
  }
  console.log(`${C.gray}  ルール ${rules.length} 件 / 所要 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒${C.reset}`);
  console.log(`${C.gray}  台帳: ${path.relative(process.cwd(), ISSUES_PATH)}${C.reset}`);
  console.log(`${C.gray}  レポート: ${path.relative(process.cwd(), reportPath)}${C.reset}`);

  if (OUT_JSON) console.log(JSON.stringify(lastScan, null, 2));
}

// ===================================================================
// エントリポイント
// いかなる失敗でも終了コード 0(自動実行フロー相乗り時に後続を止めない)。
// 失敗時はエラー表示のみ行い、台帳・レポートは書き換えない。
// ===================================================================
function main() {
  if (SUBCOMMAND === 'ack' || SUBCOMMAND === 'start') {
    runStatusCommand(SUBCOMMAND, positional[1]);
    return;
  }
  if (SUBCOMMAND) {
    console.error(`${C.red}不明なサブコマンド "${SUBCOMMAND}"(利用可能: ack / start)${C.reset}`);
    return;
  }
  runScan();
}

try {
  main();
} catch (e) {
  console.error(`${C.red}[FATAL]${C.reset} スキャンを中断しました: ${e.message}`);
  console.error(`${C.gray}台帳・レポートへの書き込みは行っていません${C.reset}`);
}
process.exitCode = 0;
