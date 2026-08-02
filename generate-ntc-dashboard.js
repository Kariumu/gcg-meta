#!/usr/bin/env node
/**
 * generate-ntc-dashboard.js — data/ntc_dashboard.json から ntc-official.html を静的生成
 * 指示書63 Step 1-N §3。
 *
 * 決定論: 同一入力 → バイト同一出力。生成日時・実行環境に依存する値は一切埋め込まない
 *         (この生成器は Date / Math.random を使わない。テストで機械検査する)。
 *
 * 使い方:
 *   node generate-ntc-dashboard.js
 *   NTC_DASHBOARD_ROOT=/path/to/site node generate-ntc-dashboard.js   # 隔離検証用
 *
 * 終了コードは常に 0(指示書63 §2/§4 と揃える)。件数ガード不一致時は生成せずログのみ。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.NTC_DASHBOARD_ROOT || __dirname;
const DATA_PATH = path.join(ROOT, 'data', 'ntc_dashboard.json');
const SCHEDULE_PATH = path.join(ROOT, 'data', 'schedule.json');
const OUT_PATH = path.join(ROOT, 'ntc-official.html');

const SOURCE_BASE = 'https://d.bandai-tcg-plus.com/gcgja/tournament/sanctioned/';

const LOG = (...a) => console.log('[ntc-dashboard:gen]', ...a);
const ERR = (...a) => console.error('[ntc-dashboard:gen]', ...a);

/**
 * 色コード対応表。
 *  - 数値→英語キー: Step 0 の72デッキ実測で唯一解となった対応(公式定義は未確認)
 *  - 英語キー→hex/jp/cssClass: js/common.js の DECK_COLORS の写し
 *    (common.js はブラウザ専用で require できないため。検収は hex 一致で機械照合する)
 */
const COLOR_BY_NUM = { 1: 'Blue', 2: 'Green', 3: 'Red', 4: 'Purple', 5: 'White' };
const DECK_COLORS = {
  Blue: { hex: '#4488ff', jp: '青', cssClass: 'c-blue' },
  Red: { hex: '#ff4444', jp: '赤', cssClass: 'c-red' },
  Green: { hex: '#44cc64', jp: '緑', cssClass: 'c-green' },
  White: { hex: '#cccccc', jp: '白', cssClass: 'c-white' },
  Purple: { hex: '#b444ff', jp: '紫', cssClass: 'c-purple' },
  Unknown: { hex: '#888888', jp: '不明', cssClass: '' }
};

/** ISO 3166-2:JP → 都道府県名(schedule.json の stores.pref_code 表示用) */
const PREF_BY_CODE = {
  'JP-01': '北海道', 'JP-02': '青森県', 'JP-03': '岩手県', 'JP-04': '宮城県', 'JP-05': '秋田県',
  'JP-06': '山形県', 'JP-07': '福島県', 'JP-08': '茨城県', 'JP-09': '栃木県', 'JP-10': '群馬県',
  'JP-11': '埼玉県', 'JP-12': '千葉県', 'JP-13': '東京都', 'JP-14': '神奈川県', 'JP-15': '新潟県',
  'JP-16': '富山県', 'JP-17': '石川県', 'JP-18': '福井県', 'JP-19': '山梨県', 'JP-20': '長野県',
  'JP-21': '岐阜県', 'JP-22': '静岡県', 'JP-23': '愛知県', 'JP-24': '三重県', 'JP-25': '滋賀県',
  'JP-26': '京都府', 'JP-27': '大阪府', 'JP-28': '兵庫県', 'JP-29': '奈良県', 'JP-30': '和歌山県',
  'JP-31': '鳥取県', 'JP-32': '島根県', 'JP-33': '岡山県', 'JP-34': '広島県', 'JP-35': '山口県',
  'JP-36': '徳島県', 'JP-37': '香川県', 'JP-38': '愛媛県', 'JP-39': '高知県', 'JP-40': '福岡県',
  'JP-41': '佐賀県', 'JP-42': '長崎県', 'JP-43': '熊本県', 'JP-44': '大分県', 'JP-45': '宮崎県',
  'JP-46': '鹿児島県', 'JP-47': '沖縄県'
};

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "2026/8/2" → "2026-08-02"(解釈できなければ元の文字列) */
function normalizeDate(s) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return String(s || '');
  return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}

/** 色数値配列 → 表示用HTML(スウォッチ+日本語名)。空配列は「色情報なし」 */
function colorsHtml(colors) {
  const arr = Array.isArray(colors) ? colors : [];
  if (arr.length === 0) {
    const u = DECK_COLORS.Unknown;
    return '<span class="ntc-colors"><span class="ntc-swatch" style="background:' + u.hex +
      '"></span><span class="ntc-colors-label">色情報なし</span></span>';
  }
  const sw = arr.map((n) => {
    const key = COLOR_BY_NUM[n];
    const c = DECK_COLORS[key] || DECK_COLORS.Unknown;
    return '<span class="ntc-swatch" style="background:' + c.hex + '" title="' + escapeHtml(c.jp) + '"></span>';
  }).join('');
  const label = arr.map((n) => {
    const key = COLOR_BY_NUM[n];
    return (DECK_COLORS[key] || DECK_COLORS.Unknown).jp;
  }).join('/');
  return '<span class="ntc-colors">' + sw + '<span class="ntc-colors-label">' + escapeHtml(label) + '</span></span>';
}

/** 色配列の比較キー(決定論的な並び用) */
function colorsKey(colors) {
  const a = Array.isArray(colors) ? colors : [];
  return a.length === 0 ? 'zzz' : a.join('-');
}

function fmtRate(r) {
  return (typeof r === 'number' && isFinite(r)) ? r.toFixed(2) : '-';
}

/** 3桁区切り(toLocaleString は環境のICUに依存しうるため自前実装で決定論を担保) */
function fmtInt(n) {
  const s = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
}

/** schedule.json の stores から 店舗名 → 情報 の辞書を作る(読めなければ空) */
function loadStoreIndex() {
  try {
    if (!fs.existsSync(SCHEDULE_PATH)) return {};
    const j = JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf-8'));
    const stores = (j && j.stores) || {};
    const idx = Object.create(null);
    for (const k of Object.keys(stores)) {
      const s = stores[k];
      if (!s || typeof s.name !== 'string' || !s.name) continue;
      if (idx[s.name]) continue;               // 同名は最初の1件のみ(決定論のためキー昇順走査)
      idx[s.name] = { pref_code: s.pref_code || '', city: s.city || '' };
    }
    return idx;
  } catch (e) {
    ERR('schedule.json を読めませんでした(店舗情報なしで続行): ' + e.message);
    return {};
  }
}

/**
 * ページに出すシリーズかどうか。
 * 結果がまだ1件も公開されていないシリーズ(集計値も店舗行も0件)は表示しない。
 * (松岡さん指示 2026-08-03: 結果が出ていない9月シリーズを見せない)
 * データとしては保持するので、結果が出た日から自動的に表示される。
 */
function isVisibleSeries(S) {
  if (!S) return false;
  const L = S.aggregates_latest || {};
  const usages = (L.usages || []).length;
  const wins = (L.win_counts || []).length;
  const shops = Object.keys(S.shops || {}).length;
  return (usages + wins + shops) > 0;
}

/* --------------------------------------------------------------- 本体生成 */

function buildSeriesSection(id, S, storeIdx, counters) {
  const latest = S.aggregates_latest || { usages: [], win_counts: [], denominator_n: null, date: '' };
  const usages = (latest.usages || []).slice().sort((a, b) => {
    const d = (b.rate || 0) - (a.rate || 0);
    return d !== 0 ? d : (colorsKey(a.colors) < colorsKey(b.colors) ? -1 : 1);
  });
  const wins = (latest.win_counts || []).slice().sort((a, b) => {
    const ra = (typeof a.rank === 'number' ? a.rank : 9999);
    const rb = (typeof b.rank === 'number' ? b.rank : 9999);
    if (ra !== rb) return ra - rb;
    return colorsKey(a.colors) < colorsKey(b.colors) ? -1 : 1;
  });
  const shopKeys = Object.keys(S.shops || {}).sort((ka, kb) => {
    const a = S.shops[ka], b = S.shops[kb];
    const da = normalizeDate(a.date), db = normalizeDate(b.date);
    if (da !== db) return da < db ? 1 : -1;                       // date 降順
    const pa = String(a.place || ''), pb = String(b.place || '');
    if (pa !== pb) return pa < pb ? -1 : 1;                       // place 昇順
    return ka < kb ? -1 : 1;                                      // 同値はキーで安定化
  });

  counters.series += 1;
  counters.usages += usages.length;
  counters.wins += wins.length;
  counters.shops += shopKeys.length;

  const maxRate = usages.reduce((m, u) => Math.max(m, u.rate || 0), 0) || 100;
  const nText = (latest.denominator_n === null || latest.denominator_n === undefined)
    ? '集計中(分母を確定できませんでした)'
    : fmtInt(latest.denominator_n) + ' デッキ';

  const usageRows = usages.map((u) => {
    const w = Math.max(1, Math.round((u.rate || 0) / maxRate * 100));
    return '' +
      '        <tr data-ntc="usage-row">\n' +
      '          <td class="ntc-col-colors">' + colorsHtml(u.colors) + '</td>\n' +
      '          <td class="ntc-col-num">' + fmtRate(u.rate) + '%</td>\n' +
      '          <td class="ntc-col-num">' + (typeof u.count === 'number' ? u.count : '-') + '</td>\n' +
      '          <td class="ntc-col-bar"><span class="ntc-bar" style="width:' + w + '%"></span></td>\n' +
      '        </tr>\n';
  }).join('');

  const winRows = wins.map((w) => '' +
    '        <tr data-ntc="win-row">\n' +
    '          <td class="ntc-col-num ntc-col-rank">' + (typeof w.rank === 'number' ? w.rank : '-') + '</td>\n' +
    '          <td class="ntc-col-colors">' + colorsHtml(w.colors) + '</td>\n' +
    '          <td class="ntc-col-num">' + (typeof w.count === 'number' ? w.count : '-') + '</td>\n' +
    '        </tr>\n').join('');

  const shopRows = shopKeys.map((k) => {
    const s = S.shops[k];
    const info = storeIdx[s.place];
    const pref = info ? (PREF_BY_CODE[info.pref_code] || '') : '';
    return '' +
      '        <tr data-ntc="shop-row">\n' +
      '          <td class="ntc-col-date">' + escapeHtml(normalizeDate(s.date)) + '</td>\n' +
      '          <td class="ntc-col-place">' + escapeHtml(s.place) +
      (pref ? ' <span class="ntc-pref">' + escapeHtml(pref) + '</span>' : '') + '</td>\n' +
      '          <td class="ntc-col-num ntc-col-cap">' + (typeof s.capacity === 'number' ? s.capacity : '-') + '</td>\n' +
      '          <td class="ntc-col-colors">' + colorsHtml(s.winning_colors) + '</td>\n' +
      '        </tr>\n';
  }).join('');

  const period = escapeHtml(normalizeDate(S.start)) + ' 〜 ' + escapeHtml(normalizeDate(S.end));
  const srcUrl = SOURCE_BASE + encodeURIComponent(id);

  return '' +
    '    <section class="ntc-series" data-ntc="series">\n' +
    '      <div class="ntc-series-head">\n' +
    '        <h2 class="ntc-series-title">' + escapeHtml(S.title || id) + '</h2>\n' +
    '        <div class="ntc-series-meta">\n' +
    '          <span>開催期間: ' + period + '</span>\n' +
    '          <span>集計対象: ' + escapeHtml(nText) + '</span>\n' +
    '          <span>集計日: ' + escapeHtml(latest.date || '-') + '</span>\n' +
    '        </div>\n' +
    '      </div>\n' +
    '\n' +
    '      <h3 class="ntc-h3">色ペア別 使用率</h3>\n' +
    (usages.length ? '' +
      '      <table class="ntc-table">\n' +
      '        <thead><tr><th>デッキ色</th><th class="ntc-col-num">使用率</th><th class="ntc-col-num">デッキ数</th><th></th></tr></thead>\n' +
      '        <tbody>\n' + usageRows +
      '        </tbody>\n' +
      '      </table>\n'
      : '      <p class="ntc-empty">まだ集計値が公開されていません。</p>\n') +
    '\n' +
    '      <h3 class="ntc-h3">色ペア別 優勝数</h3>\n' +
    (wins.length ? '' +
      '      <table class="ntc-table">\n' +
      '        <thead><tr><th class="ntc-col-num ntc-col-rank">順位</th><th>デッキ色</th><th class="ntc-col-num">優勝数</th></tr></thead>\n' +
      '        <tbody>\n' + winRows +
      '        </tbody>\n' +
      '      </table>\n'
      : '      <p class="ntc-empty">まだ優勝データが公開されていません。</p>\n') +
    '\n' +
    '      <h3 class="ntc-h3">店舗別 優勝デッキ色</h3>\n' +
    (shopKeys.length ? '' +
      '      <table class="ntc-table">\n' +
      '        <thead><tr><th>開催日</th><th>店舗</th><th class="ntc-col-num ntc-col-cap">定員</th><th>優勝デッキ色</th></tr></thead>\n' +
      '        <tbody>\n' + shopRows +
      '        </tbody>\n' +
      '      </table>\n'
      : '      <p class="ntc-empty">まだ店舗別の結果が公開されていません。</p>\n') +
    '      <p class="ntc-note">出典: <a href="' + escapeHtml(srcUrl) + '" target="_blank" rel="noopener">BANDAI TCG+ 大会データ</a></p>\n' +
    '    </section>\n';
}

function buildHtml(data, storeIdx) {
  const counters = { series: 0, usages: 0, wins: 0, shops: 0 };
  const ids = Object.keys(data.series || {}).filter((id) => isVisibleSeries(data.series[id])).sort((a, b) => {
    const sa = normalizeDate((data.series[a] || {}).start);
    const sb = normalizeDate((data.series[b] || {}).start);
    if (sa !== sb) return sa < sb ? 1 : -1;   // 開催開始 降順
    return a < b ? -1 : 1;                    // 同日はULID昇順
  });
  const sections = ids.map((id) => buildSeriesSection(id, data.series[id], storeIdx, counters)).join('\n');

  const html = '' +
'<!DOCTYPE html>\n' +
'<html lang="ja">\n' +
'<head>\n' +
'  <!-- Google Analytics -->\n' +
'  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3MY17P4E7F"></script>\n' +
'  <script>\n' +
'    window.dataLayer = window.dataLayer || [];\n' +
'    function gtag(){dataLayer.push(arguments);}\n' +
"    gtag('js', new Date());\n" +
"    gtag('config', 'G-3MY17P4E7F');\n" +
'  </script>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'  <title>ニュータイプチャレンジ 公式集計 - GCG STATS</title>\n' +
'  <link rel="icon" type="image/svg+xml" href="/favicon.svg">\n' +
'  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">\n' +
'  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">\n' +
'  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">\n' +
'  <link rel="shortcut icon" href="/favicon.ico">\n' +
'  <meta name="theme-color" content="#d4a029">\n' +
'  <meta name="description" content="ニュータイプチャレンジの公式集計(色ペア別使用率・優勝数・店舗別優勝デッキ色)をまとめたページです。">\n' +
'  <link rel="canonical" href="https://gcg-stats.com/ntc-official.html">\n' +
'  <!-- OGP -->\n' +
'  <meta property="og:site_name" content="GCG STATS">\n' +
'  <meta property="og:locale" content="ja_JP">\n' +
'  <meta property="og:title" content="ニュータイプチャレンジ 公式集計 | GCG STATS">\n' +
'  <meta property="og:description" content="公式が公開している色ペア別使用率・優勝数・店舗別優勝デッキ色の集計。">\n' +
'  <meta property="og:type" content="website">\n' +
'  <meta property="og:url" content="https://gcg-stats.com/ntc-official.html">\n' +
'  <meta property="og:image" content="https://gcg-stats.com/images/ogp-default.png">\n' +
'  <meta name="twitter:card" content="summary_large_image">\n' +
'  <meta name="twitter:image" content="https://gcg-stats.com/images/ogp-default.png">\n' +
'  <link rel="preconnect" href="https://fonts.googleapis.com">\n' +
'  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">\n' +
'  <link rel="stylesheet" href="css/style.css">\n' +
'  <style>\n' +
'    .ntc-intro { max-width: 900px; font-size: 13px; color: var(--text-secondary); line-height: 1.9; }\n' +
'    .ntc-series { margin-top: 32px; background: var(--bg-card); border: 1px solid var(--border);\n' +
'      border-radius: var(--radius-lg); padding: 24px; }\n' +
'    .ntc-series-title { font-size: 18px; margin: 0 0 8px; color: var(--text-primary); }\n' +
'    .ntc-series-meta { display: flex; flex-wrap: wrap; gap: 16px; font-size: 12px;\n' +
'      color: var(--text-muted); font-family: var(--font-mono); }\n' +
'    .ntc-h3 { font-size: 14px; margin: 24px 0 8px; color: var(--text-primary); }\n' +
'    .ntc-table { width: 100%; border-collapse: collapse; font-size: 13px; }\n' +
'    .ntc-table th { text-align: left; font-size: 11px; color: var(--text-muted);\n' +
'      border-bottom: 1px solid var(--border); padding: 6px 8px; font-weight: 600; }\n' +
'    .ntc-table td { border-bottom: 1px solid var(--border); padding: 7px 8px;\n' +
'      color: var(--text-secondary); vertical-align: middle; }\n' +
'    .ntc-col-num { text-align: right; font-family: var(--font-mono); white-space: nowrap; }\n' +
'    .ntc-col-rank { width: 56px; }\n' +
'    .ntc-col-cap { width: 72px; }\n' +
'    .ntc-col-date { font-family: var(--font-mono); white-space: nowrap; }\n' +
'    .ntc-col-bar { width: 38%; }\n' +
'    .ntc-bar { display: block; height: 8px; border-radius: 4px; background: var(--accent); }\n' +
'    .ntc-colors { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }\n' +
'    .ntc-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; }\n' +
'    .ntc-colors-label { font-size: 12px; }\n' +
'    .ntc-pref { font-size: 11px; color: var(--text-muted); }\n' +
'    .ntc-empty { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }\n' +
'    .ntc-note { font-size: 11px; color: var(--text-muted); margin-top: 16px; }\n' +
'    .ntc-notes { margin-top: 28px; padding: 16px 18px; border: 1px solid var(--border);\n' +
'      border-radius: var(--radius); background: var(--bg-elevated); font-size: 11.5px;\n' +
'      color: var(--text-muted); line-height: 1.9; }\n' +
'    .ntc-notes ul { margin: 6px 0 0 18px; }\n' +
'    @media (max-width: 640px) {\n' +
'      .ntc-series { padding: 16px; }\n' +
'      .ntc-col-bar { display: none; }\n' +
'      .ntc-table { font-size: 12px; }\n' +
'    }\n' +
'  </style>\n' +
'</head>\n' +
'<body>\n' +
'  <div id="header"></div>\n' +
'\n' +
'  <main class="container">\n' +
'    <div class="section-header">\n' +
'      <h1 class="section-title">ニュータイプチャレンジ 公式集計</h1>\n' +
'    </div>\n' +
'\n' +
'    <p class="ntc-intro">公式のデッキログサービスが公開している、ニュータイプチャレンジの集計値をまとめたページです。\n' +
'      色ペア別の使用率・優勝数と、店舗別の優勝デッキ色を掲載しています。当サイト独自の大会結果集計とは別系統のデータです。</p>\n' +
'\n' +
sections +
'\n' +
'    <div class="ntc-notes">\n' +
'      <strong>ご利用にあたって</strong>\n' +
'      <ul>\n' +
'        <li>出典: BANDAI TCG+ 大会データ(各シリーズの公式ページへのリンクを上記に掲載しています)。掲載内容に問題がある場合は <a href="contact.html">お問い合わせ</a> よりご連絡ください。速やかに対応いたします。</li>\n' +
'        <li>店舗一覧は取得元の表示仕様により全件でない場合があります。</li>\n' +
'        <li>色分類は当サイトの推定対応です(公式定義と異なる可能性があります)。</li>\n' +
'      </ul>\n' +
'    </div>\n' +
'  </main>\n' +
'\n' +
'  <div id="footer"></div>\n' +
'\n' +
'  <script src="js/common.js?v=15"></script>\n' +
'  <script>\n' +
'    GCG.init();\n' +
"    document.getElementById('header').innerHTML = GCG.renderHeader('ntc-official');\n" +
"    document.getElementById('footer').innerHTML = GCG.renderFooter();\n" +
'  </script>\n' +
'</body>\n' +
'</html>\n';

  return { html, counters };
}

/** data 側の期待件数を数える */
function countData(data) {
  const c = { series: 0, usages: 0, wins: 0, shops: 0 };
  for (const id of Object.keys(data.series || {})) {
    const S = data.series[id] || {};
    if (!isVisibleSeries(S)) continue;      // 非表示シリーズは件数ガードの対象外
    c.series++;
    const L = S.aggregates_latest || {};
    c.usages += (L.usages || []).length;
    c.wins += (L.win_counts || []).length;
    c.shops += Object.keys(S.shops || {}).length;
  }
  return c;
}

/** 生成HTML内のマーカー数を数える(件数ガード用) */
function countHtml(html) {
  const n = (re) => (html.match(re) || []).length;
  return {
    series: n(/data-ntc="series"/g),
    usages: n(/data-ntc="usage-row"/g),
    wins: n(/data-ntc="win-row"/g),
    shops: n(/data-ntc="shop-row"/g)
  };
}

function generate() {
  if (!fs.existsSync(DATA_PATH)) {
    ERR('data/ntc_dashboard.json がありません: ' + DATA_PATH + '(生成せず終了)');
    return { ok: false, reason: 'no-data' };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  } catch (e) {
    ERR('data/ntc_dashboard.json を読めません: ' + e.message + '(生成せず終了)');
    return { ok: false, reason: 'broken-data' };
  }
  if (!data || typeof data.series !== 'object' || data.series === null) {
    ERR('data/ntc_dashboard.json の形式が不正です(生成せず終了)');
    return { ok: false, reason: 'bad-shape' };
  }
  const visible = Object.keys(data.series).filter((id) => isVisibleSeries(data.series[id]));
  if (visible.length === 0) {
    ERR('表示対象のシリーズが0件です(結果が公開されているシリーズがありません)。' +
      '空ページの上書きを避けるため生成しません。');
    return { ok: false, reason: 'empty' };
  }
  const hidden = Object.keys(data.series).length - visible.length;
  if (hidden > 0) LOG('結果未公開のため非表示: ' + hidden + 'シリーズ');

  const storeIdx = loadStoreIndex();
  const { html, counters } = buildHtml(data, storeIdx);

  const expect = countData(data);
  const actual = countHtml(html);
  const keys = ['series', 'usages', 'wins', 'shops'];
  const bad = keys.filter((k) => expect[k] !== actual[k] || counters[k] !== expect[k]);
  if (bad.length) {
    ERR('件数ガード不一致のため生成を中断しました: ' +
      keys.map((k) => k + ' data=' + expect[k] + '/html=' + actual[k] + '/build=' + counters[k]).join(', '));
    return { ok: false, reason: 'count-guard' };
  }

  fs.writeFileSync(OUT_PATH, html, 'utf-8');
  LOG('出力: ' + OUT_PATH + ' (' + Buffer.byteLength(html, 'utf-8') + ' bytes)');
  LOG('  シリーズ' + expect.series + ' / 使用率行' + expect.usages +
    ' / 優勝行' + expect.wins + ' / 店舗行' + expect.shops +
    ' / 店舗名join ' + Object.keys(storeIdx).length + '件の辞書');
  return { ok: true, html: html, counts: expect };
}

module.exports = {
  buildHtml, countData, countHtml, isVisibleSeries, colorsHtml, escapeHtml, normalizeDate,
  loadStoreIndex, generate, COLOR_BY_NUM, DECK_COLORS, OUT_PATH, DATA_PATH
};

if (require.main === module) {
  try { generate(); } catch (e) { ERR('FATAL: ' + (e && e.message)); }
  process.exit(0);
}
