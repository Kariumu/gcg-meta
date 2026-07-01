#!/usr/bin/env node
/**
 * GCG STATS サイト整合性監視システム (Site Integrity Monitor) - Phase 1
 * 設計書: design-site-integrity-monitor.md 準拠
 *
 * 使い方:
 *   node tools/integrity/scan.js             フルスキャン(検出詳細+サマリー)
 *   node tools/integrity/scan.js --summary   サマリーのみ(自動実行フロー相乗り用)
 *   node tools/integrity/scan.js --json      結果を state/last-scan.json に加えて標準出力にも出す
 *
 * 動作:
 *   1. rules/*.yaml を全読込
 *   2. 各ルールを対応する checker で実行(サイト全体に対して完全読み取り専用)
 *   3. 検出結果を state/issues.json(問題台帳)と突合し、upsert
 *      - issue_id = ルールID + 対象パスの SHA1 先頭6桁 → 再実行しても同一問題は同一ID
 *      - 新規: status=open で登録 / 既検出: last_seen のみ更新
 *      - 未検出になった issue の resolved 遷移は Phase 2 で実装(本 Phase では触らない)
 *   4. severity 別サマリーをコンソール出力
 *
 * Phase 1 の checker:
 *   file_exists_for_each   データソースの各要素に対応するファイルが存在するか
 *   internal_links_valid   HTML内の内部リンク(href)先が実在するか
 *   image_refs_valid       imgタグ参照先の画像ファイルが実在するか
 *   --- 承認済みルール(CARD-002/003, EVT-002)に必要な補助checker ---
 *   no_orphan_files        データソースに存在しないファイル(孤児ページ)がないか
 *   cross_data_consistent  2つのデータソース間でキーが一致するか(方向別severity対応)
 *   required_fields        データソースの各要素に必須フィールドが揃っているか
 *
 * 制約(設計書7章 / Step 0承認事項):
 *   - 完全読み取り専用。書き込みは tools/integrity/state/ 配下のみ
 *   - 検出した問題の修正は行わない(検出と修正の分離)
 *   - 既存 check-site-integrity.js とは併存(本スクリプトから参照しない)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..'); // リポジトリルート(サイト公開ルート)
const RULES_DIR = path.join(__dirname, 'rules');
const STATE_DIR = path.join(__dirname, 'state');
const ISSUES_PATH = path.join(STATE_DIR, 'issues.json');
const LAST_SCAN_PATH = path.join(STATE_DIR, 'last-scan.json');

const args = process.argv.slice(2);
const SUMMARY_ONLY = args.includes('--summary');
const OUT_JSON = args.includes('--json');

const C = { reset: '\x1b[0m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', gray: '\x1b[90m' };
const SEV_COLOR = { error: C.red, warning: C.yellow, info: C.cyan };

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
// 共通ヘルパー(すべて読み取り専用)
// ===================================================================
function loadJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

/** データソース定義 → キー配列 or [キー, 値] ペア配列を取り出す */
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
  if (!abs.startsWith(ROOT)) return null; // ルート外に出る参照は対象外
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
// checker 実装
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
// 問題台帳(issues.json)との突合
// ===================================================================
function issueId(ruleId, target) {
  const h = crypto.createHash('sha1').update(String(target)).digest('hex').slice(0, 6);
  return `${ruleId}-${h}`;
}

function loadIssues() {
  try {
    return JSON.parse(fs.readFileSync(ISSUES_PATH, 'utf8'));
  } catch (_) {
    return [];
  }
}

// ===================================================================
// メイン
// ===================================================================
function main() {
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // 1. ルール読込
  const ruleFiles = fs.readdirSync(RULES_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  const rules = [];
  for (const f of ruleFiles) {
    rules.push(...parseRulesYaml(fs.readFileSync(path.join(RULES_DIR, f), 'utf8'), f));
  }

  // 2. 各ルール実行
  const allFindings = []; // { rule, target, detail, severity }
  const ruleStats = [];
  for (const rule of rules) {
    const checker = CHECKERS[rule.checker];
    if (!checker) {
      console.error(`${C.red}[SKIP]${C.reset} ${rule.id}: 未実装のchecker "${rule.checker}"(Phase 1対象外)`);
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

  // 3. 台帳と突合(upsert)
  const ledger = loadIssues();
  const byId = new Map(ledger.map((i) => [i.issue_id, i]));
  let newCount = 0;
  let continuingCount = 0;
  const detectedIds = new Set();
  for (const f of allFindings) {
    const id = issueId(f.rule_id, f.target);
    detectedIds.add(id);
    const existing = byId.get(id);
    if (existing) {
      existing.last_seen = today;
      existing.detail = f.detail;
      existing.severity = f.severity;
      continuingCount++;
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
  const undetectedCount = ledger.filter((i) => !detectedIds.has(i.issue_id)).length;

  const updated = [...byId.values()].sort(
    (a, b) => a.rule_id.localeCompare(b.rule_id) || a.target.localeCompare(b.target)
  );

  // 4. 保存(書き込みは state/ 配下のみ)
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(ISSUES_PATH, JSON.stringify(updated, null, 2) + '\n');
  const lastScan = {
    scanned_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    rules: ruleStats,
    detected: allFindings.length,
    new: newCount,
    continuing: continuingCount,
    undetected_in_ledger: undetectedCount,
  };
  fs.writeFileSync(LAST_SCAN_PATH, JSON.stringify(lastScan, null, 2) + '\n');

  // 5. コンソール出力
  if (!SUMMARY_ONLY) {
    for (const rule of rules) {
      const fs_ = allFindings.filter((f) => f.rule_id === rule.id);
      const stat = ruleStats.find((s) => s.rule_id === rule.id) || {};
      console.log(`\n${C.cyan}===== ${rule.id}: ${rule.name} =====${C.reset}`);
      if (stat.skipped) {
        console.log(`${C.gray}  (checker "${rule.checker}" は Phase 1 未実装のためスキップ)${C.reset}`);
        continue;
      }
      if (stat.failed) {
        console.log(`${C.red}  checker実行エラー: ${stat.failed}${C.reset}`);
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

  console.log(`\n${C.cyan}===== サマリー(severity別)=====${C.reset}`);
  console.log(`  ${C.red}error  : ${sevCount.error}${C.reset}`);
  console.log(`  ${C.yellow}warning: ${sevCount.warning}${C.reset}`);
  console.log(`  ${C.cyan}info   : ${sevCount.info || 0}${C.reset}`);
  console.log(`  検出合計: ${allFindings.length}(新規 ${newCount} / 継続 ${continuingCount})`);
  if (undetectedCount > 0) {
    console.log(`${C.gray}  台帳にあるが今回未検出: ${undetectedCount} 件(resolved 遷移は Phase 2 で実装)${C.reset}`);
  }
  console.log(`${C.gray}  ルール ${rules.length} 件 / 所要 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒${C.reset}`);
  console.log(`${C.gray}  台帳: tools/integrity/state/issues.json${C.reset}`);

  if (OUT_JSON) console.log(JSON.stringify(lastScan, null, 2));

  // 自動実行フロー相乗り時に後続処理を止めないため、常に終了コード 0
  process.exitCode = 0;
}

main();
