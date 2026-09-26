#!/usr/bin/env node
/**
 * scripts/fetch-promos-0926.js  (発行元 2026-09-26)
 * 公式カードリストの「プロモーションカード」(package=615901) にあって cards_master.json に無いカードを取り込む。
 *
 *   node scripts/fetch-promos-0926.js            # 取得（一覧 → 詳細 → 通常版の詳細 → 画像。1.5 秒間隔）
 *   node scripts/fetch-promos-0926.js --merge     # 取得した物から master を作る（PROMO_OUT に書く。data/ は変えない）
 *
 * 作り方（既存の master と同じ書き方にそろえる。2026-09-26 に master c9ad2ed3 で確認）:
 *  - 通常のカードのプロモ（_pN）: 共通の項目（名前・タイプ・色・Lv・COST・特徴・AP/HP・出典・リンク・効果・地形）は
 *    master の通常版を写す。レアリティと入手情報は公式のプロモのページから取る。package_set は入手情報で決める
 *    （fetch-promos.js の classify と同じ: 弾コード [GD01] 等があればその弾・is_promo=false / β を含めば β /
 *    それ以外は PROMO・is_promo=true）。通常版に地形が無ければ、公式のページの地形を使う（既存のプロモ 152 件と同じ）。
 *  - トークンのプロモ（T-xxx_pN）: 既存のトークンのプロモ（T-015_p1 など 6 件）と同じ並び・値。共通の項目は通常版から。
 *  - リソース系（R/RP/EXR/EXRP/EXB/EXBP）: fetch-resource-cards.js（指示書113）の toMasterEntry と同じ作り方
 *    （公式のページの値。色の「-」そろえ・Lv/COST は消す・package_set は EXB/EXBP=EXBASE、ほか RESOURCE・
 *    _pN は is_parallel=true / is_promo=false）。
 *  - 並び: 通常のカード・トークンは、同じ番号の既存の _pN のうち番号が小さい物の直後（無ければ通常版の直後）。
 *    リソース系は同じ接頭辞で番号が 1 つ前の物の直後（例 EXRP-016 は EXRP-015 の後）。
 *  - 公式のプロモのページと通常版のページを同じ読み取りで比べ、共通の項目が違えば報告する（効果のかっこ書きだけの違いは注記）。
 *  - 画像は公式の物だけ（取れなければ報告して止める。通常版の画像は流用しない）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const ROOT = process.env.PROMO_ROOT || path.resolve(__dirname, '..');
const MASTER_PATH = path.join(ROOT, 'data', 'cards_master.json');
const OUT_PATH = process.env.PROMO_OUT || path.join(ROOT, 'tmp', 'promos-0926', 'cards_master.json');
const IMG_DIR = process.env.PROMO_IMG_DIR || path.join(ROOT, 'tmp', 'promos-0926', 'images');
const CACHE_DIR = path.join(ROOT, 'tmp', 'promos-0926', 'cache');
const REQUEST_DELAY_MS = 1500;   // 公式サーバ配慮（他スクリプトと同値・変更禁止）
const MIN_SIZE = 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.gundam-gcg.com/jp/';
const PROMO_PACKAGE = '615901';
// fetch-promos.js と同じ一覧（ST11〜14 を入れると「スタートデッキそのままバトル！[ST11]～[ST14] 参加記念品」を弾内と誤判定するので入れない）
const BOOSTERS = new Set(['GD01', 'GD02', 'GD03', 'GD04', 'GD05', 'ST01', 'ST02', 'ST03', 'ST04', 'ST05', 'ST06', 'ST07', 'ST08', 'ST09', 'ST10', 'EB01']);
const RESOURCE_LIKE = /^(R|EXB|EXR|RP|EXBP|EXRP)-\d/;
const SHARED = ['name_jp', 'card_type', 'color', 'level', 'cost', 'traits', 'stats', 'source_title', 'link', 'effect_text', 'terrain'];

const args = process.argv.slice(2);
const DO_MERGE = args.includes('--merge');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const baseIdOf = (id) => id.replace(/_p\d+$/, '');
const pNumOf = (id) => { const m = id.match(/_p(\d+)$/); return m ? parseInt(m[1], 10) : 0; };

let lastReq = 0;
async function polite() { const w = lastReq + REQUEST_DELAY_MS - Date.now(); if (w > 0) await sleep(w); lastReq = Date.now(); }
async function fetchHtml(url) {
  await polite();
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html', 'Referer': REFERER } }, (res) => {
      if (res.statusCode !== 200) { resolve(null); res.resume(); return; }
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}
function isWebp(buf) { return buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP'; }
async function downloadImage(url, depth = 0) {
  if (depth > 3) return { ok: false, reason: 'too-many-redirects' };
  const u = new URL(url);
  if (u.hostname !== 'www.gundam-gcg.com') return { ok: false, reason: 'redirect to other host ' + u.hostname };
  await polite();
  return new Promise((resolve, reject) => {
    https.get(u, { headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) { res.resume(); resolve(downloadImage(new URL(res.headers.location, u).toString(), depth + 1)); return; }
      if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, reason: 'http ' + res.statusCode }); return; }
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); if (buf.length < MIN_SIZE || !isWebp(buf)) { resolve({ ok: false, reason: 'invalid (size=' + buf.length + ')' }); return; } resolve({ ok: true, buf }); });
    }).on('error', reject);
  });
}
// fetch-st11-14-parallels.js の parseCard と同じ
function parseCard(html, cardId) {
  const $ = cheerio.load(html);
  const text = (sel) => $(sel).first().text().trim();
  const name = text('h1.cardName');
  if (!name) return null;
  const fields = {};
  $('.dataBox').each((_, el) => { const k = $(el).find('.dataTit').first().text().trim(); const v = $(el).find('.dataTxt').first().text().trim(); if (k) fields[k] = v; });
  let effect = '';
  const ov = $('.cardDataRow.overview .dataTxt').first();
  if (ov.length) {
    effect = ov.html() ? ov.html().replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim() : '';
    effect = effect.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
    effect = effect.split('\n').map((l) => l.trim()).filter(Boolean).join('');
  }
  const numOrNull = (v) => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; };
  const traits = (fields['特徴'] || '').match(/〔([^〕]+)〕/g);
  const links = (fields['リンク'] || '').match(/「([^」]+)」/g);
  const entry = {
    id: cardId, name_jp: name, rarity: (text('.cardNoCol .rarity') || '').replace(/\s+/g, ''),
    card_type: fields['タイプ'] || '', color: fields['色'] || '', level: numOrNull(fields['Lv.']), cost: numOrNull(fields['COST']),
    traits: traits ? traits.map((t) => t.replace(/[〔〕]/g, '')) : [], stats: {}, source_title: fields['出典タイトル'] || '',
    link: links ? links.map((l) => l.replace(/[「」]/g, '')) : [], package_set: cardId.split('-')[0], effect_text: effect,
  };
  if (fields['地形']) entry.terrain = fields['地形'];
  if (fields['入手情報']) entry.acquisition_info = fields['入手情報'];
  const apRaw = fields['AP']; const hpRaw = fields['HP'];
  const ap = numOrNull(apRaw); const hp = numOrNull(hpRaw);
  if (ap !== null) { if (/^\s*[+＋]/.test(String(apRaw))) entry.stats.ap_mod = ap; else entry.stats.ap = ap; }
  if (hp !== null) { if (/^\s*[+＋]/.test(String(hpRaw))) entry.stats.hp_mod = hp; else entry.stats.hp = hp; }
  return entry;
}
function parseList(html) {
  const $ = cheerio.load(html);
  const numText = $('.num').first().text().trim();
  const reported = /^\d+$/.test(numText) ? parseInt(numText, 10) : null;
  const ids = [];
  $('li.cardItem').each((_, el) => { const img = $(el).find('img').first(); const src = img.attr('data-src') || img.attr('src') || ''; const m = src.match(/([A-Za-z0-9]+-\d{3}(?:_p\d+)?)\.webp/); if (m) ids.push(m[1]); });
  return { reported, ids };
}
function stripParens(t) { let out = ''; let d = 0; for (const ch of String(t || '')) { if (ch === '(') { d++; continue; } if (ch === ')' && d > 0) { d--; continue; } if (d === 0) out += ch; } return out; }
function classify(ai) {
  ai = ai || '';
  const codes = [...ai.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  for (const c of codes) if (BOOSTERS.has(c)) return { package_set: c, is_promo: false };
  if (ai.includes('β')) return { package_set: 'β', is_promo: false };
  return { package_set: 'PROMO', is_promo: true };
}
// 公式の値の比べ方（Lv/COST が null のときは無いのと同じ。色「-」のゆれをそろえる）
function norm(e) {
  const o = JSON.parse(JSON.stringify(e));
  if (o.level === null) delete o.level; if (o.cost === null) delete o.cost;
  if (['—', '－', ''].includes(o.color)) o.color = '-';
  return o;
}
// 発行元が 1 件ずつ見て「中身は同じ」と判断した効果の書き方の違い（2026-09-26）
const EFFECT_WORDING_OK = {
  'ST03-001_p3': '効果の 2 つの文の順番だけが違う（言葉は同じ）',
  'GD01-023_p2': '「手札の、〔ジオン〕」と読点が 1 つ多いだけ',
};
function compareOfficial(p, b) {
  const diffs = []; const notes = [];
  const P = norm(p); const B = norm(b);
  for (const k of SHARED) {
    if (same(P[k], B[k])) continue;
    if (k === 'effect_text' && stripParens(P[k]) === stripParens(B[k])) { notes.push('効果のかっこ書きだけが違う（通常版の値を使う）'); continue; }
    if (k === 'effect_text' && EFFECT_WORDING_OK[p.id]) { notes.push('効果の書き方の違い: ' + EFFECT_WORDING_OK[p.id] + '（通常版の値を使う）'); continue; }
    if (k === 'source_title') { notes.push(`出典が通常版と違う: プロモ「${P[k]}」/ 通常版「${B[k]}」（絵が別の作品。プロモの値を使う）`); continue; }
    if (k === 'card_type' && String(P[k]).replace(/[・\s]/g, '') === String(B[k]).replace(/[・\s]/g, '')) { notes.push(`タイプの書き方だけが違う: 「${P[k]}」/「${B[k]}」（master の値を使う）`); continue; }
    diffs.push(`${k}: プロモ ${JSON.stringify(P[k])} / 通常版 ${JSON.stringify(B[k])}`);
  }
  return { diffs, notes };
}

// ---------- 取得 ----------
async function fetchAll() {
  fs.mkdirSync(path.join(CACHE_DIR, 'base'), { recursive: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf-8'));
  const listHtml = await fetchHtml(`https://www.gundam-gcg.com/jp/cards/index.php?package=${PROMO_PACKAGE}`);
  if (!listHtml) { console.error('中止: プロモーションカードの一覧を取れない'); process.exit(1); }
  const { reported, ids } = parseList(listHtml);
  if (reported !== null && reported !== ids.length) { console.error(`中止: 一覧の表示 ${reported} 件に対し読み取り ${ids.length} 件`); process.exit(1); }
  const missing = [...new Set(ids)].filter((id) => !master[id]);
  fs.writeFileSync(path.join(CACHE_DIR, 'list.json'), JSON.stringify({ fetched_at: new Date().toISOString(), reported, ids, missing }, null, 2));
  console.log(`一覧: ${ids.length} 件（表示 ${reported}）/ master に無い: ${missing.length} 件`);
  const bases = new Set();
  for (const id of missing) {
    const cp = path.join(CACHE_DIR, id + '.json');
    if (!fs.existsSync(cp)) {
      const html = await fetchHtml(`https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=${encodeURIComponent(id)}`);
      const e = html ? parseCard(html, id) : null;
      if (!e) { console.error(`  ✖ ${id}: 詳細を読めない`); continue; }
      fs.writeFileSync(cp, JSON.stringify(e, null, 2));
    }
    const e = JSON.parse(fs.readFileSync(cp, 'utf-8'));
    const ip = path.join(IMG_DIR, id + '.webp');
    let img = 'あり';
    if (!fs.existsSync(ip)) {
      const r = await downloadImage(`https://www.gundam-gcg.com/jp/images/cards/card/${id}.webp`);
      if (r.ok) fs.writeFileSync(ip, r.buf); else img = '失敗(' + r.reason + ')';
    }
    console.log(`  ✓ ${id} [${e.rarity}] ${e.name_jp} / ${e.card_type} / ${e.acquisition_info || ''} / 画像 ${img}`);
    if (/_p\d+$/.test(id)) bases.add(baseIdOf(id));
  }
  for (const b of bases) {
    const cp = path.join(CACHE_DIR, 'base', b + '.json');
    if (fs.existsSync(cp)) continue;
    const html = await fetchHtml(`https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=${encodeURIComponent(b)}`);
    const e = html ? parseCard(html, b) : null;
    fs.writeFileSync(cp, JSON.stringify(e, null, 2));
    console.log(`  (通常版) ${b}: ${e ? e.name_jp : '公式に無い(302)'}`);
  }
}

// ---------- 作る ----------
// 出典: 公式のプロモのページと公式の通常版のページで同じなら master の通常版の値（表記のそろえを保つ）、
//       違えば（絵が別の作品）公式のプロモの値
let OFFICIAL_BASE = {};
function srcTitle(off, mb) {
  const ob = OFFICIAL_BASE[baseIdOf(off.id)];
  if (ob && ob.source_title === off.source_title) return mb.source_title;
  return off.source_title;
}
function buildParallel(off, mb, cls) {   // 通常のカード（キーの並びは fetch-st11-14-parallels.js と同じ）
  const e = { id: off.id, name_jp: mb.name_jp, rarity: off.rarity, card_type: mb.card_type, color: mb.color };
  if ('level' in mb) e.level = mb.level;
  if ('cost' in mb) e.cost = mb.cost;
  e.traits = JSON.parse(JSON.stringify(mb.traits || []));
  e.stats = JSON.parse(JSON.stringify(mb.stats || {}));
  e.source_title = srcTitle(off, mb);
  e.link = JSON.parse(JSON.stringify(mb.link || []));
  e.package_set = cls.package_set;
  e.effect_text = mb.effect_text;
  e.effect = ('effect' in mb) ? mb.effect : mb.effect_text;
  if ('terrain' in mb) e.terrain = mb.terrain; else if (off.terrain) e.terrain = off.terrain;
  e.acquisition_info = off.acquisition_info;
  e.is_parallel = true;
  e.is_promo = cls.is_promo;
  e.parallel_number = pNumOf(off.id);
  e.base_card_id = baseIdOf(off.id);
  return e;
}
// トークン（既存の T-015_p1 などと同じ並び）。公式のページはトークンを「C」「C+」・「UNIT TOKEN」と表示するが、
// master はトークン 24 件すべてを「T」・「TOKEN」で持つ（既存のトークンのプロモ 6 件も同じ）ので、通常版の値にそろえる
function buildToken(off, mb, cls) {
  return {
    id: off.id, name_jp: mb.name_jp, rarity: mb.rarity, card_type: mb.card_type, color: mb.color,
    traits: JSON.parse(JSON.stringify(mb.traits || [])), stats: JSON.parse(JSON.stringify(mb.stats || {})),
    source_title: srcTitle(off, mb), package_set: cls.package_set, effect_text: mb.effect_text,
    terrain: ('terrain' in mb) ? mb.terrain : '-', acquisition_info: off.acquisition_info,
    is_parallel: true, is_promo: cls.is_promo, parallel_number: pNumOf(off.id), base_card_id: baseIdOf(off.id),
    link: JSON.parse(JSON.stringify(mb.link || [])),
  };
}
function buildResource(off) {            // fetch-resource-cards.js の toMasterEntry と同じ
  const e = JSON.parse(JSON.stringify(off));
  if (['—', '－', '-', ''].includes(e.color)) e.color = '-';
  if (e.level === null || e.level === undefined) delete e.level;
  if (e.cost === null || e.cost === undefined) delete e.cost;
  e.rarity = String(e.rarity || '').replace(/\s+/g, '');
  e.package_set = /^EXBP?-/.test(e.id) ? 'EXBASE' : 'RESOURCE';
  if (/_p\d+$/.test(e.id)) { e.is_parallel = true; e.is_promo = false; e.parallel_number = pNumOf(e.id); e.base_card_id = baseIdOf(e.id); }
  return e;
}

// 松岡さんの決定（2026-09-26）
//  (a) リソース系で公式の効果が「-」の物は、既存と同じ説明文にそろえる（既存のリソース 219 件はすべて説明文あり。
//      種類ごとに同じ文: RP 66 件・EXRP 16 件・EXR 15 件・EXBP 27 件・EXB 7 件を 2026-09-26 に master で確認）。
//      パラレル（RP-068_p1）は通常版の文を写す（9/25 の ST パラレルと同じ考え方）。
//  (b) 既存の T-022 の効果が空なのを公式の文に直す（公式の T-022・T-022_p1〜p4 はどれも同じ文）。プロモ 4 種はそれを写す。
const RESOURCE_TEXT = {
  'EX RESOURCE': '(ゲーム開始時に、後攻のプレイヤーはEXリソース1つをリソースエリアにアクティブで置く)(コストを支払う際、EXリソースをレストにしてゲームから除外する)',
  'EX BASE': '(ゲーム開始時に、EXベース1つをベース置き場にアクティブで置く)',
  'RESOURCE': '(コストを支払う際、リソースをレストにする)',
};
const FIX_T022 = { id: 'T-022', from: '', to: 'このユニットはパイロットをセットできない。' };

function merge() {
  const rawText = fs.readFileSync(MASTER_PATH, 'utf-8');
  const master = JSON.parse(rawText);
  if (JSON.stringify(master, null, 2) !== rawText) { console.error('中止: master が JSON.stringify(…, null, 2) の形ではない'); process.exit(1); }
  const before = JSON.parse(rawText);
  // (b) T-022 の直し（公式の値と一致することを確かめてから）
  {
    const ob = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'base', FIX_T022.id + '.json'), 'utf-8'));
    if (!master[FIX_T022.id] || master[FIX_T022.id].effect_text !== FIX_T022.from || !ob || ob.effect_text !== FIX_T022.to) { console.error('中止: T-022 の直しの前提が合わない'); process.exit(1); }
    master[FIX_T022.id].effect_text = FIX_T022.to;
  }
  const list = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'list.json'), 'utf-8'));
  const report = { added: [], problems: [], notes: [] };
  const add = {};
  for (const id of list.missing) {
    const off = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, id + '.json'), 'utf-8'));
    if (!fs.existsSync(path.join(IMG_DIR, id + '.webp'))) report.problems.push(`${id}: 画像が無い`);
    let e; let kind;
    if (RESOURCE_LIKE.test(id)) {
      kind = 'resource'; e = buildResource(off);
      if (e.effect_text === '-') {
        const std = RESOURCE_TEXT[e.card_type];
        if (!std) { report.problems.push(`${id}: 効果が「-」で、そろえる文が決まっていない（${e.card_type}）`); }
        else { report.notes.push(`${id}: 公式の効果は「-」。既存の ${e.card_type} と同じ説明文にそろえた（松岡さんの決定 9/26）`); e.effect_text = std; }
      }
    } else {
      const b = baseIdOf(id);
      if (b === id) { report.problems.push(`${id}: _pN でない通常のカード（想定外）`); continue; }
      const mb = master[b];
      if (!mb) { report.problems.push(`${id}: 通常版 ${b} が master に無い`); continue; }
      const cls = classify(off.acquisition_info);
      const ob = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'base', b + '.json'), 'utf-8'));
      OFFICIAL_BASE[b] = ob;
      if (!ob) report.problems.push(`${id}: 公式の通常版 ${b} のページが無い`);
      else { const c = compareOfficial(off, ob); c.diffs.forEach((d) => report.problems.push(`${id}: 公式のプロモと通常版で違う: ${d}`)); c.notes.forEach((n) => report.notes.push(`${id}: ${n}`)); }
      if (mb.card_type === 'TOKEN') { kind = 'token'; e = buildToken(off, mb, cls); } else { kind = 'card'; e = buildParallel(off, mb, cls); }
      if (!cls.is_promo) report.notes.push(`${id}: 入手情報「${off.acquisition_info}」から、プロモではなく ${cls.package_set} のパラレルとして登録`);
      if (off.name_jp !== mb.name_jp) report.problems.push(`${id}: 名前が master の通常版と違う（公式 ${off.name_jp} / master ${mb.name_jp}）`);
    }
    add[id] = e;
    report.added.push({ id, kind, rarity: e.rarity, name: e.name_jp, package_set: e.package_set, is_promo: !!e.is_promo, acq: e.acquisition_info || '' });
  }
  // 並べる
  const keys = Object.keys(master);
  const after = new Map();   // 既存キー → その直後に入れる新 ID の並び
  const pushAfter = (k, id) => { if (!after.has(k)) after.set(k, []); after.get(k).push(id); };
  const newIds = Object.keys(add).sort((a, b) => {
    const ba = baseIdOf(a), bb = baseIdOf(b);
    return ba === bb ? pNumOf(a) - pNumOf(b) : (ba < bb ? -1 : 1);
  });
  const placedNew = new Set();
  for (const id of newIds) {
    let anchor = null;
    if (RESOURCE_LIKE.test(id) && !/_p\d+$/.test(id)) {
      const m = id.match(/^([A-Z]+)-(\d+)$/); const pre = m[1]; const num = parseInt(m[2], 10);
      const cands = keys.filter((k) => new RegExp('^' + pre + '-\\d+$').test(k) && parseInt(k.split('-')[1], 10) < num);
      cands.sort((a, b) => parseInt(a.split('-')[1], 10) - parseInt(b.split('-')[1], 10));
      anchor = cands.length ? cands[cands.length - 1] : null;
      // その番号のパラレルが既にあれば、その後ろ
      if (anchor) { const ps = keys.filter((k) => k.startsWith(anchor + '_p')); if (ps.length) anchor = ps[ps.length - 1]; }
    } else {
      const b = baseIdOf(id); const n = pNumOf(id);
      const olds = keys.filter((k) => k === b || (k.startsWith(b + '_p') && pNumOf(k) < n));
      anchor = olds.length ? olds[olds.length - 1] : null;
      if (!anchor && add[b]) anchor = null;   // 通常版も今回新しく入る（RP-068 → RP-068_p1）
    }
    if (!anchor) {
      const b = baseIdOf(id);
      if (add[b] && placedNew.has(b)) { // 新しい通常版の後ろにつなぐ
        for (const [k, arr] of after) { const i = arr.indexOf(b); if (i >= 0) { arr.splice(i + 1, 0, id); placedNew.add(id); break; } }
        continue;
      }
      report.problems.push(`${id}: 置く場所を決められない`); continue;
    }
    pushAfter(anchor, id); placedNew.add(id);
  }
  const out = {};
  for (const k of keys) { out[k] = master[k]; for (const id of (after.get(k) || [])) out[id] = add[id]; }
  // 検証
  const outKeys = Object.keys(out);
  if (outKeys.length !== keys.length + newIds.length) report.problems.push(`件数が合わない: ${keys.length} + ${newIds.length} ≠ ${outKeys.length}`);
  const oldOrder = outKeys.filter((k) => master[k]);
  if (!same(oldOrder, keys)) report.problems.push('既存の並びが変わった');
  for (const k of keys) {
    if (k === FIX_T022.id) { const exp = JSON.parse(JSON.stringify(before[k])); exp.effect_text = FIX_T022.to; if (!same(out[k], exp)) report.problems.push(`${k} の直しが想定と違う`); continue; }
    if (!same(out[k], before[k])) report.problems.push(`既存 ${k} の中身が変わった`);
  }
  for (const id of newIds) {
    const e = out[id];
    if (!e) continue;
    if (e.is_parallel && !out[e.base_card_id]) report.problems.push(`${id}: 通常版 ${e.base_card_id} が無い`);
    if (!e.name_jp || !e.card_type || !e.rarity) report.problems.push(`${id}: 必須項目の欠け`);
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(path.dirname(OUT_PATH), 'report.json'), JSON.stringify(report, null, 2));
  console.log(`追加 ${newIds.length} 件 / 問題 ${report.problems.length} 件 / 注記 ${report.notes.length} 件 / ${keys.length} → ${outKeys.length}`);
  report.problems.forEach((p) => console.log('  ✖ ' + p));
  const kinds = {}; report.added.forEach((a) => { const k = a.kind + '/' + a.package_set + '/promo=' + a.is_promo; kinds[k] = (kinds[k] || 0) + 1; });
  console.log('  内訳:', JSON.stringify(kinds));
  if (report.problems.length) process.exitCode = 2;
}

(async () => { if (DO_MERGE) merge(); else await fetchAll(); })().catch((e) => { console.error('致命的エラー: ' + e.message); process.exit(1); });
