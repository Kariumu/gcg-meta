#!/usr/bin/env node
/**
 * build-tcgplus-tokenmap.js — BANDAI TCG+ トークン対応表の自動生成（指示書46）
 *
 * data/events.json の大会結果（results[].deck と results[].tcgplus_url）から、
 * カード番号 → BANDAI TCG+ 内部トークンID（base64 3文字）の対応表
 * data/tcgplus_tokenmap.json を生成する。
 *
 * 【注意 / 制約】
 * - 本対応表は BANDAI TCG+ の内部ID体系に依存する非公式データであり、
 *   TCG+側の仕様変更・規約変更で機能しなくなる可能性がある。
 * - base64連番の法則による未知カードの推測導出は行わない（パラレル有無で
 *   ±ズレがあり、1ズレ=別カードのため危険）。対応表に無いカードは
 *   URL生成対象外とする（公式リスト外は作成不可の方針と一致）。
 *
 * 【アルゴリズム: B+方式（2026-07-17 松岡さん承認）】
 * 実データでは deck 配列とトークン列の並び順が一致しないデッキが約28%存在
 * する（カードの種類×枚数の集合としては一致）。そのため3段階で集計する:
 *   Phase 1: 完全一様デッキ（各カードで count 枚ぶん同一トークンが連続）のみ
 *            位置対応で集計。結果は「1トークン=1カード」矛盾ゼロが必須
 *            （違反検出時は異常終了＝データ異常として人間の確認を要求）。
 *   Phase 2: 並び順不一致デッキのうち、Phase 1 の対応でトークン列を翻訳した
 *            カード多重集合が deck 配列と完全一致するデッキのみ追加集計。
 *   Phase 3: 未知トークンを含む残デッキのうち、「不足カード⇔未知トークン」が
 *            枚数の集合演算で一意に確定する場合のみ新規対応として採用。
 *            曖昧・矛盾はスキップ＋ログ。
 *   最終防御: 合算後に全域一意性を再検証。Phase 3 由来の衝突はデッキごと破棄。
 * 集計単位は延べ枚数（count = そのトークンが実URLに出現した合計枚数）。
 * 代表 = 最頻トークン（同数時はトークン文字列昇順で決定的に選択）。
 *
 * 【冪等性】同一入力→同一出力。内容が不変なら既存ファイルへ一切書き込まず、
 * _meta.generated_at も前回値を維持する。大会結果取得（scraper / auto-news）で
 * events.json が更新されるたびに再実行すれば対応表が育つ（パイプライン組込・
 * 定期実行の設定は別指示）。
 *
 * 使い方: node scripts/build-tcgplus-tokenmap.js   （終了コード 0=成功 / 1=異常）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'events.json');
const OUT = path.join(ROOT, 'data', 'tcgplus_tokenmap.json');
const GAME_TITLE_ID = 15;
const TOKEN_RE = /^[A-Za-z0-9+/]{3}$/;

/*
 * 保存URLの deck= 値は %エンコード（%2F=/ %2B=+ %21=!）されており、復号すると
 * 「3文字トークンの . 連結」+ 末尾 "!!!"。"!" は TCG+ のセクション区切り
 * （メインデッキ以外の空セクション）とみられ、対応表を作った全6,685件で
 * 「末尾に3連のみ・途中には一切出現しない」ことを検証済み。よって末尾の
 * 連続 "!" のみを除去する。末尾以外に "!" が現れた場合は想定外として null
 * を返し、呼び出し側でスキップ＋ログする。
 */
function extractTokens(url) {
  const m = /[?&]deck=([^&#]*)/.exec(url || '');
  if (!m) return null;
  let v;
  try { v = decodeURIComponent(m[1]); } catch (e) { return null; }
  const body = v.replace(/!+$/, '');
  if (body.indexOf('!') !== -1) return null;
  const toks = body.split('.').filter(function (t) { return t.length > 0; });
  for (const t of toks) if (!TOKEN_RE.test(t)) return null;
  return toks;
}

function deckMultiset(deck) {
  const m = new Map();
  for (const c of deck) m.set(c.card_id, (m.get(c.card_id) || 0) + c.count);
  return m;
}
function msEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const kv of a) if (b.get(kv[0]) !== kv[1]) return false;
  return true;
}
function inc(map, key, tok, n) {
  let c = map.get(key);
  if (!c) { c = new Map(); map.set(key, c); }
  c.set(tok, (c.get(tok) || 0) + n);
}
function sortedTokens(counter) {
  return Array.from(counter.entries()).sort(function (x, y) {
    return y[1] - x[1] || (x[0] < y[0] ? -1 : 1);
  });
}

function main() {
  const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const events = data.events || {};

  // ---- 走査・分類 ----
  const withUrl = [];            // tcgplus_url あり・deckあり・枚数一致
  const skipped = [];            // { eid, idx, reason, detail }
  const universeAll = new Set(); // 全 results[].deck 出現カード（URL無しの結果も含む）
  const universeUrl = new Set(); // URL付き結果の deck 出現カード
  let deckTotal = 0;
  for (const eid of Object.keys(events)) {
    const results = events[eid].results || [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const deck = r.deck;
      if (Array.isArray(deck)) {
        for (const c of deck) {
          universeAll.add(c.card_id);
          if (r.tcgplus_url) universeUrl.add(c.card_id);
        }
      }
      if (!r.tcgplus_url) continue; // URL無しは対象外（トークン列が存在しない）
      deckTotal++;
      const toks = extractTokens(r.tcgplus_url);
      if (!Array.isArray(deck) || deck.length === 0) {
        skipped.push({ eid: eid, idx: i, reason: 'missing_deck',
          detail: 'deck配列が空。URL側も通常と別形式（トークン' + (toks ? toks.length : '?') + '個・"!"無し）' });
        continue;
      }
      if (!toks) {
        skipped.push({ eid: eid, idx: i, reason: 'bad_url', detail: 'deck=の形式が想定外' });
        continue;
      }
      const total = deck.reduce(function (s, c) { return s + c.count; }, 0);
      if (toks.length !== total) {
        skipped.push({ eid: eid, idx: i, reason: 'count_mismatch',
          detail: 'トークン' + toks.length + '個 vs デッキ' + total + '枚' });
        continue;
      }
      withUrl.push({ eid: eid, idx: i, deck: deck, toks: toks });
    }
  }

  // ---- Phase 1: 完全一様デッキのみ位置対応で集計 ----
  const uniformDecks = [];
  const nonUniform = [];
  for (const d of withUrl) {
    let pos = 0, uni = true;
    for (const c of d.deck) {
      const first = d.toks[pos];
      for (let k = 1; k < c.count; k++) {
        if (d.toks[pos + k] !== first) { uni = false; break; }
      }
      pos += c.count;
      if (!uni) break;
    }
    if (uni) uniformDecks.push(d); else nonUniform.push(d);
  }
  const p1 = new Map(); // card_id -> Map(token -> 延べ枚数)
  for (const d of uniformDecks) {
    let pos = 0;
    for (const c of d.deck) { inc(p1, c.card_id, d.toks[pos], c.count); pos += c.count; }
  }
  // Phase 1 の全域一意性（土台の健全性）。違反＝位置対応の前提が崩れている。
  const inv = new Map(); // token -> card_id
  let p1Conflict = 0;
  for (const e1 of p1) {
    for (const tok of e1[1].keys()) {
      const owner = inv.get(tok);
      if (owner && owner !== e1[0]) {
        console.error('[FATAL] Phase1一意性違反: ' + tok + ' -> ' + owner + ' / ' + e1[0]);
        p1Conflict++;
      } else inv.set(tok, e1[0]);
    }
  }
  if (p1Conflict > 0) {
    console.error('[FATAL] 位置対応の土台が崩れています（データ異常）。生成を中止します。');
    process.exit(1);
  }

  // ---- Phase 2: 集合一致で検証できた並び順不一致デッキを追加集計 ----
  const p2decks = [];
  const p3cand = [];
  for (const d of nonUniform) {
    const orig = deckMultiset(d.deck);
    const trans = new Map();
    const unknown = new Map();
    for (const t of d.toks) {
      const cid = inv.get(t);
      if (cid) trans.set(cid, (trans.get(cid) || 0) + 1);
      else unknown.set(t, (unknown.get(t) || 0) + 1);
    }
    if (unknown.size === 0 && msEqual(trans, orig)) p2decks.push(d);
    else p3cand.push({ d: d, orig: orig, trans: trans, unknown: unknown });
  }
  const merged = new Map();
  for (const e1 of p1) for (const e2 of e1[1]) inc(merged, e1[0], e2[0], e2[1]);
  for (const d of p2decks) for (const t of d.toks) inc(merged, inv.get(t), t, 1);

  // ---- Phase 3: 集合演算で一意に確定する場合のみ新規対応を採用 ----
  const p3assign = [];
  for (const cand of p3cand) {
    const d = cand.d;
    let excess = 0;
    const leftover = new Map();
    for (const e1 of cand.orig) {
      const t = cand.trans.get(e1[0]) || 0;
      if (e1[1] > t) leftover.set(e1[0], e1[1] - t);
    }
    for (const e1 of cand.trans) {
      const o = cand.orig.get(e1[0]) || 0;
      if (e1[1] > o) excess += e1[1] - o;
    }
    let unkTotal = 0; for (const v of cand.unknown.values()) unkTotal += v;
    let leftTotal = 0; for (const v of leftover.values()) leftTotal += v;
    if (excess > 0 || cand.unknown.size === 0 || unkTotal !== leftTotal) {
      skipped.push({ eid: d.eid, idx: d.idx, reason: 'inconsistent',
        detail: '既知トークンの翻訳がデッキ集合と整合しない' });
      continue;
    }
    let pairs = null;
    if (cand.unknown.size === 1 && leftover.size === 1) {
      const u = Array.from(cand.unknown)[0];
      const l = Array.from(leftover)[0];
      if (u[1] === l[1]) pairs = [[l[0], u[0], u[1]]];
    } else if (cand.unknown.size === leftover.size) {
      // 枚数がすべて相異なり、枚数同士が1対1で一致する場合のみ確定とみなす
      const un = Array.from(cand.unknown).sort(function (a, b) { return a[1] - b[1]; });
      const lf = Array.from(leftover).sort(function (a, b) { return a[1] - b[1]; });
      const counts = un.map(function (x) { return x[1]; });
      const distinct = new Set(counts).size === counts.length;
      let match = distinct;
      for (let i = 0; match && i < un.length; i++) if (un[i][1] !== lf[i][1]) match = false;
      if (match) pairs = un.map(function (x, i) { return [lf[i][0], x[0], x[1]]; });
    }
    if (pairs) p3assign.push({ d: d, pairs: pairs });
    else skipped.push({ eid: d.eid, idx: d.idx, reason: 'ambiguous',
      detail: '未知トークンと不足カードの対応が一意に定まらない' });
  }
  // Phase 3 候補どうし・既知対応との全域整合。矛盾トークンを含むデッキは破棄。
  const p3TokCards = new Map();
  for (const a of p3assign) {
    for (const pr of a.pairs) {
      const set = p3TokCards.get(pr[1]) || new Set();
      set.add(pr[0]);
      p3TokCards.set(pr[1], set);
    }
  }
  const poisoned = new Set();
  for (const e1 of p3TokCards) if (e1[1].size > 1 || inv.has(e1[0])) poisoned.add(e1[0]);
  const p3used = [];
  for (const a of p3assign) {
    let bad = false;
    for (const pr of a.pairs) if (poisoned.has(pr[1])) bad = true;
    if (bad) {
      skipped.push({ eid: a.d.eid, idx: a.d.idx, reason: 'p3_conflict',
        detail: '推定トークンが他デッキ・既知対応と矛盾' });
      continue;
    }
    p3used.push(a);
    for (const t of a.d.toks) { const cid = inv.get(t); if (cid) inc(merged, cid, t, 1); }
    for (const pr of a.pairs) inc(merged, pr[0], pr[1], pr[2]);
  }

  // ---- 集計・出力オブジェクト ----
  const deckUsed = uniformDecks.length + p2decks.length + p3used.length;
  const cardIds = Array.from(merged.keys()).sort();
  const out = {};
  out._meta = {
    generated_at: null, // 内容が前回から不変なら前回値を維持（冪等性）
    source: 'data/events.json',
    deck_total: deckTotal,
    deck_used: deckUsed,
    deck_skipped: deckTotal - deckUsed,
    card_count: cardIds.length,
    game_title_id: GAME_TITLE_ID,
    count_unit: 'copies',
    method: {
      phase1_uniform: uniformDecks.length,
      phase2_multiset_verified: p2decks.length,
      phase3_inferred: p3used.length,
      skipped_missing_deck: skipped.filter(function (s) { return s.reason === 'missing_deck'; }).length,
      skipped_ambiguous: skipped.filter(function (s) { return s.reason === 'ambiguous'; }).length,
      skipped_other: skipped.filter(function (s) {
        return s.reason !== 'missing_deck' && s.reason !== 'ambiguous';
      }).length
    }
  };
  for (const cid of cardIds) {
    const toks = sortedTokens(merged.get(cid));
    const alt = {};
    for (let i = 1; i < toks.length; i++) alt[toks[i][0]] = toks[i][1];
    out[cid] = { token: toks[0][0], count: toks[0][1], alt: alt };
  }

  // ---- 最終防御: 全域一意性の再検証 ----
  const finalInv = new Map();
  let finalViol = 0;
  for (const cid of cardIds) {
    const all = [out[cid].token].concat(Object.keys(out[cid].alt));
    for (const t of all) {
      const owner = finalInv.get(t);
      if (owner && owner !== cid) {
        console.error('[FATAL] 最終一意性違反: ' + t + ' -> ' + owner + ' / ' + cid);
        finalViol++;
      } else finalInv.set(t, cid);
    }
  }
  if (finalViol > 0) process.exit(1);

  // ---- 冪等な書き込み（LF・整形JSON・末尾改行）----
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { prev = null; }
  function stripTime(o) {
    const c = JSON.parse(JSON.stringify(o));
    if (c._meta) delete c._meta.generated_at;
    return JSON.stringify(c, null, 2);
  }
  let wrote = false;
  if (prev && prev._meta && stripTime(prev) === stripTime(out)) {
    out._meta.generated_at = prev._meta.generated_at;
  } else {
    out._meta.generated_at = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
    wrote = true;
  }

  // ---- ラウンドトリップ検証: 全使用デッキを代表トークンで再生成し集合一致を確認 ----
  const usedAll = uniformDecks.concat(p2decks, p3used.map(function (a) { return a.d; }));
  let rtOk = 0, rtNg = 0, repDiff = 0;
  for (const d of usedAll) {
    const gen = [];
    for (const c of d.deck) {
      const e = out[c.card_id];
      for (let k = 0; k < c.count; k++) gen.push(e.token);
    }
    const back = new Map();
    for (const t of gen) { const cid = finalInv.get(t); back.set(cid, (back.get(cid) || 0) + 1); }
    if (msEqual(back, deckMultiset(d.deck))) rtOk++; else rtNg++;
    const oc = new Map(), gc = new Map();
    for (const t of d.toks) oc.set(t, (oc.get(t) || 0) + 1);
    for (const t of gen) gc.set(t, (gc.get(t) || 0) + 1);
    if (!msEqual(oc, gc)) repDiff++;
  }

  // ---- ログ出力 ----
  console.log('[tokenmap] URL付き結果: ' + deckTotal + ' / 使用: ' + deckUsed + ' / スキップ: ' + (deckTotal - deckUsed));
  console.log('[tokenmap] Phase1(一様): ' + uniformDecks.length + ' / Phase2(集合一致): ' + p2decks.length + ' / Phase3(一意推定): ' + p3used.length);
  for (const s of skipped) console.log('[skip] event=' + s.eid + ' result#' + s.idx + ' reason=' + s.reason + ' ' + s.detail);
  console.log('[tokenmap] カード数: ' + cardIds.length + ' / 複数トークン保有: ' + cardIds.filter(function (c) { return Object.keys(out[c].alt).length > 0; }).length);
  console.log('[tokenmap] 一意性検証: Phase1衝突 0 / 最終衝突 0');
  console.log('[roundtrip] カード集合一致: ' + rtOk + '/' + usedAll.length + ' 不一致: ' + rtNg + ' / 代表トークンが元URLと異なるデッキ: ' + repDiff);
  const unmappedAll = Array.from(universeAll).filter(function (c) { return !out[c]; }).sort();
  const unmappedUrl = Array.from(universeUrl).filter(function (c) { return !out[c]; }).sort();
  console.log('[coverage] 採用実績(全デッキ): ' + universeAll.size + '種中 ' + (universeAll.size - unmappedAll.length) + '種を収載 / 未収載: ' + (unmappedAll.join(',') || 'なし'));
  console.log('[coverage] 採用実績(URL付きデッキ): ' + universeUrl.size + '種中 ' + (universeUrl.size - unmappedUrl.length) + '種 / 未収載: ' + (unmappedUrl.join(',') || 'なし'));
  function buildUrl(deck) {
    const toks = [];
    for (const c of deck) for (let k = 0; k < c.count; k++) toks.push(out[c.card_id].token);
    return 'https://www.bandai-tcg-plus.com/deck_recipe?deck=' + encodeURIComponent(toks.join('.')) + '%21%21%21&game_title_id=' + GAME_TITLE_ID;
  }
  const samples = [];
  if (uniformDecks[0]) samples.push(['Phase1', uniformDecks[0]]);
  if (p2decks[0]) samples.push(['Phase2', p2decks[0]]);
  if (p3used[0]) samples.push(['Phase3', p3used[0].d]);
  for (const sm of samples) {
    console.log('[sample-' + sm[0] + '] event=' + sm[1].eid + ' result#' + sm[1].idx);
    console.log('  ' + buildUrl(sm[1].deck));
  }
  console.log(wrote ? '[tokenmap] 書き込み: ' + OUT : '[tokenmap] 内容不変のためファイル未変更（generated_at維持: ' + out._meta.generated_at + '）');
}

main();
