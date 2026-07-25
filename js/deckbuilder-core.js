/**
 * deckbuilder-core.js — デッキビルダー純ロジック（UI非依存）
 *
 * 指示書49（デッキビルダー仕様書）準拠。ブラウザ（window.DeckCore）と
 * Node（require）の両方で動く UMD 形式。Node 側は tmp/test-deckbuilder-core.mjs が
 * §16 検証チェックリストの境界テストに使用する。
 *
 * 主な責務:
 *  - cards_master / cards_preview の正規化（§13 正規化マッピング）
 *  - base_card_id 名寄せ（§6.4: パラレルは通常版と同一カードとして合算）
 *  - 構築違反6種の判定（§5.4: 枚数/色数/禁止/制限超過/禁止ペア/同名4枚超）
 *    ※新レギュレーション（2026-07-25施行）を施行日前から常時適用（§5.3）
 *  - TCG＋登録可否の3系統判定と deck= URL 生成（§10.1・§5.4）
 *
 * 公開はまだ行わない（ローカル検証用ビルド）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.DeckCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EFFECTIVE_DATE = '2026-07-25';
  var EFFECTIVE_LABEL = '2026年7月25日';
  var DECK_SIZE = 50;          // メインデッキはちょうど50枚（§4）
  var MAX_PER_NAME = 4;        // 同名（base_card_id合算）4枚まで（§4・§8）
  var MAX_SAVED_DECKS = 50;    // 保存デッキ上限（§12・2026-07-19確定）

  var COLOR_JA = { Blue: '青', Green: '緑', Red: '赤', White: '白', Purple: '紫' };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- 正規化（§13） ---------- */

  // コマンド＋パイロット型のパイロット面名を効果テキストから抽出（実データ形式:【パイロット】「名前」・2026-07-22検証=64/64成功）
  var PILOT_NAME_RX = /【パイロット】\s*「([^」]+)」/;
  function extractPilotName(cardType, effectText) {
    if (cardType !== 'COMMAND') return null;
    var m = PILOT_NAME_RX.exec(effectText || '');
    return m ? m[1] : null;
  }

  // cards_master.json の1カード → ビルダー用スリム形
  function slimFromMaster(c) {
    var st = c.stats || {};
    return {
      id: c.id,
      name: c.name_jp || '',
      color: c.color || '-',
      type: c.card_type || '',
      level: (c.level === undefined ? null : c.level),
      cost: (c.cost === undefined ? null : c.cost),
      ap: (st.ap === undefined ? null : st.ap),
      hp: (st.hp === undefined ? null : st.hp),
      apm: (st.ap_mod === undefined ? null : st.ap_mod),   // PILOT補正
      hpm: (st.hp_mod === undefined ? null : st.hp_mod),
      traits: Array.isArray(c.traits) ? c.traits : [],
      rarity: c.rarity || '',
      set: c.package_set || '',
      src: c.source_title || '',
      effect: c.effect_text || '',
      terrain: (typeof c.terrain === 'string' ? c.terrain : ''),
      link: Array.isArray(c.link) ? c.link : [],
      base: c.base_card_id || c.id,
      par: c.is_parallel ? 1 : 0,
      pv: 0,
      pname: extractPilotName(c.card_type, c.effect_text)   // パイロット面の名前（COMMAND＋パイロット型のみ）
    };
  }

  // cards_preview.json の1カード → 同スリム形（§13 正規化マッピング表）
  // preview は master とキー名・型が異なる（実データ照合済み・2026-07-19）
  function normalizePreview(p) {
    var id = p.card_number;
    if (!id) return null;
    var ap = (p.ap !== undefined ? p.ap : null);
    var hp = (p.hp !== undefined ? p.hp : null);
    return {
      id: id,
      name: p.card_name || '',
      color: p.color || '-',
      type: p.card_type || '',
      level: (p.level === undefined ? null : p.level),
      cost: (p.cost === undefined ? null : p.cost),
      // preview のコマンド＋パイロット型は pilot 副オブジェクトを持つ → 補正として取り込む（master の ap_mod/hp_mod と揃える）
      ap: ap, hp: hp,
      apm: (p.pilot && p.pilot.ap !== undefined) ? p.pilot.ap : null,
      hpm: (p.pilot && p.pilot.hp !== undefined) ? p.pilot.hp : null,
      traits: (Array.isArray(p.traits) ? p.traits : []).map(function (t) {
        return String(t).replace(/[〔〕]/g, '');           // 括弧を除去して master 形式へ
      }),
      rarity: p.rarity || '',
      set: (id.split('-')[0] || ''),                       // 収録弾は型番接頭辞から導出（実証100%）
      src: p.source_title || '',                           // 出典は導出不可→欠損のまま
      effect: p.effect || '',
      terrain: Array.isArray(p.terrain) ? p.terrain.join(' ') : (p.terrain || ''),
      link: (typeof p.link === 'string')
        ? (p.link ? [p.link] : [])
        : (Array.isArray(p.link) ? p.link : []),
      base: id,                                            // 先行カードは自身が base（§4.5）
      par: 0,
      pv: 1,                                               // 先行フラグ（バッジ・TCG＋/URL共有可否）
      pname: (p.pilot && p.pilot.name) || extractPilotName(p.card_type, p.effect)   // preview は pilot 副オブジェクト優先
    };
  }

  /* ---------- DB構築（master ∪ preview・master優先） ---------- */

  function buildDb(masterSlim, previewRawArr) {
    var byId = new Map();
    masterSlim.forEach(function (c) { if (c && c.id) byId.set(c.id, c); });
    var previews = [];
    (previewRawArr || []).forEach(function (p) {
      var s = null;
      try { s = normalizePreview(p); } catch (e) { s = null; }
      if (!s || byId.has(s.id)) return;                    // 同一型番は master 優先
      byId.set(s.id, s);
      previews.push(s);
    });
    var cards = [];
    byId.forEach(function (c) { if (c.type !== 'TOKEN') cards.push(c); }); // トークンはデッキ対象外
    var byBase = new Map();
    cards.forEach(function (c) {
      if (!byBase.has(c.base)) byBase.set(c.base, []);
      byBase.get(c.base).push(c);
    });
    byBase.forEach(function (arr) {
      arr.sort(function (a, b) { return (a.par - b.par) || (a.id < b.id ? -1 : 1); });
    });
    return { cards: cards, byId: byId, byBase: byBase, previews: previews };
  }

  /* ---------- 集計 ---------- */

  function totalCount(deck) {
    var n = 0;
    for (var id in deck) if (deck[id] > 0) n += deck[id];
    return n;
  }

  // base_card_id で名寄せした枚数（§6.4）
  function perBaseCounts(deck, byId) {
    var m = new Map();
    for (var id in deck) {
      var q = deck[id];
      if (!q) continue;
      var c = byId.get(id);
      var b = c ? c.base : id;
      m.set(b, (m.get(b) || 0) + q);
    }
    return m;
  }

  // 色数（無色 '-' は除外・§4-2）
  function deckColors(deck, byId) {
    var s = new Set();
    for (var id in deck) {
      if (!(deck[id] > 0)) continue;
      var c = byId.get(id);
      if (c && c.color && c.color !== '-') s.add(c.color);
    }
    return Array.from(s);
  }

  function previewIdsInDeck(deck, byId) {
    var out = [];
    for (var id in deck) {
      if (!(deck[id] > 0)) continue;
      var c = byId.get(id);
      if (c && c.pv) out.push(id);
    }
    return out;
  }

  /* ---------- 違反判定（§5.4・6種）常時新レギュ適用（§5.3） ---------- */

  function validate(deck, db, R) {
    var byId = db.byId;
    var v = [];
    var per = perBaseCounts(deck, byId);
    var total = totalCount(deck);
    var colors = deckColors(deck, byId);

    function nameOf(base) {
      var c = byId.get(base);
      return c ? c.name : base;
    }
    // デッキ内で base に属する型番（表示側のスクロール・枠色づけ用）
    function idsOfBase(base) {
      var out = [];
      for (var id in deck) {
        if (!(deck[id] > 0)) continue;
        var c = byId.get(id);
        if ((c ? c.base : id) === base) out.push(id);
      }
      return out;
    }

    // 1. 枚数（50ちょうどでない）
    if (total !== DECK_SIZE) {
      v.push({
        kind: 'count',
        msg: total < DECK_SIZE
          ? 'メインデッキは50枚ちょうど（現在' + total + '枚: あと' + (DECK_SIZE - total) + '枚）'
          : 'メインデッキは50枚ちょうど（現在' + total + '枚: ' + (total - DECK_SIZE) + '枚超過）',
        ids: []
      });
    }

    // 2. 色数（3色以上・方式A警告のみ）
    if (colors.length >= 3) {
      v.push({
        kind: 'colors',
        msg: '3色以上は大会構築不可（現在' + colors.length + '色: ' +
          colors.map(function (c) { return COLOR_JA[c] || c; }).join('/') + '）',
        ids: [],
        colors: colors
      });
    }

    // 3. 禁止
    (R.banned || []).forEach(function (b) {
      if ((per.get(b) || 0) > 0) {
        v.push({ kind: 'banned', base: b, msg: '禁止カード: 〔' + nameOf(b) + '〕（' + EFFECTIVE_LABEL + '施行）', ids: idsOfBase(b) });
      }
    });

    // 4. 制限超過（違反判定のしきい値のみ制限値。＋の上限は4のまま＝§8）
    (R.restricted || []).forEach(function (r) {
      var n = per.get(r.id) || 0;
      if (n > r.count) {
        v.push({
          kind: 'limited', base: r.id, limit: r.count,
          msg: '制限カード: 〔' + nameOf(r.id) + '〕は最大' + r.count + '枚まで（現在' + n + '枚・' + EFFECTIVE_LABEL + '施行）',
          ids: idsOfBase(r.id)
        });
      }
    });

    // 5. 禁止ペア（個別＋グループ）
    var bp = R.banned_pairs || {};
    (bp.specific || []).forEach(function (pair) {
      var a = pair[0], b = pair[1];
      if ((per.get(a) || 0) > 0 && (per.get(b) || 0) > 0) {
        v.push({
          kind: 'pair', bases: [a, b],
          msg: '禁止ペア: 〔' + nameOf(a) + '〕×〔' + nameOf(b) + '〕は同居不可（' + EFFECTIVE_LABEL + '施行）',
          ids: idsOfBase(a).concat(idsOfBase(b))
        });
      }
    });
    if (bp.group && Array.isArray(bp.group.members)) {
      var present = bp.group.members.filter(function (m) { return (per.get(m) || 0) > 0; });
      if (present.length >= 2) {
        var ids = [];
        present.forEach(function (m) { ids = ids.concat(idsOfBase(m)); });
        v.push({
          kind: 'group', bases: present,
          msg: '禁止ペア（グループ）: グループ内は1種のみ採用可（現在' + present.length + '種・' + EFFECTIVE_LABEL + '施行）',
          note: bp.group.st05_exception || '',
          ids: ids
        });
      }
    }

    // 6. 同名4枚超過（手動は＋がブロックされ到達不能＝インポート由来のみ・§5.4-6）
    per.forEach(function (n, b) {
      if (n > MAX_PER_NAME) {
        v.push({ kind: 'over4', base: b, msg: '〔' + nameOf(b) + '〕は4枚まで（現在' + n + '枚）', ids: idsOfBase(b) });
      }
    });

    return v;
  }

  // デッキ側カード枠の色種別（優先: 禁止＞ペア＞制限/4枚超・§5.4）
  function frameKind(cardId, byId, violations) {
    var c = byId.get(cardId);
    var base = c ? c.base : cardId;
    var kind = null;
    violations.forEach(function (vi) {
      var hit =
        (vi.kind === 'banned' && vi.base === base) ||
        ((vi.kind === 'pair' || vi.kind === 'group') && vi.bases && vi.bases.indexOf(base) !== -1) ||
        ((vi.kind === 'limited' || vi.kind === 'over4') && vi.base === base);
      if (!hit) return;
      if (vi.kind === 'banned') kind = 'banned';
      else if ((vi.kind === 'pair' || vi.kind === 'group') && kind !== 'banned') kind = 'pair';
      else if (kind === null) kind = 'limited';
    });
    return kind;
  }

  // 検索側の規制バッジ（デッキ内容に依存しない静的判定）
  function regBadge(base, R) {
    if ((R.banned || []).indexOf(base) !== -1) return 'banned';
    for (var i = 0; i < (R.restricted || []).length; i++) {
      if (R.restricted[i].id === base) return 'limited';
    }
    var bp = R.banned_pairs || {};
    for (var j = 0; j < (bp.specific || []).length; j++) {
      if (bp.specific[j].indexOf(base) !== -1) return 'pair';
    }
    if (bp.group && (bp.group.members || []).indexOf(base) !== -1) return 'pair';
    return null;
  }

  /* ---------- TCG＋（§10.1・§5.4） ---------- */

  // 登録可否: 3系統で理由を出し分け（優先: 構築違反 → 先行カード → 変換表未収載）
  function tcgStatus(deck, db, tokenmap, violations) {
    if (totalCount(deck) === 0) return { ok: false, reason: 'empty', items: [] };
    if (violations && violations.length) return { ok: false, reason: 'violation', items: [] };
    var pv = previewIdsInDeck(deck, db.byId);
    if (pv.length) return { ok: false, reason: 'preview', items: pv };
    var unmapped = [];
    for (var id in deck) {
      if (!(deck[id] > 0)) continue;
      var c = db.byId.get(id);
      var base = c ? c.base : id;                 // パラレルは通常版 token（§10.3）
      var t = tokenmap[id] || tokenmap[base];     // パラレル固有トークン優先・無ければ通常版（§10.3改）
      if (!t) unmapped.push(id);
    }
    if (unmapped.length) return { ok: false, reason: 'unmapped', items: unmapped };
    return { ok: true, reason: null, items: [] };
  }

  // deck= URL 生成（実証済み方式: token を枚数分ドット連結 + '!!!' + encodeURIComponent）
  function tcgUrl(deck, db, tokenmap) {
    var ids = Object.keys(deck).filter(function (id) { return deck[id] > 0; }).sort();
    var tokens = [];
    ids.forEach(function (id) {
      var c = db.byId.get(id);
      var base = c ? c.base : id;
      var t = tokenmap[id] || tokenmap[base];     // パラレル固有トークン優先・無ければ通常版（§10.3改）
      if (!t) return;
      for (var i = 0; i < deck[id]; i++) tokens.push(t);
    });
    var raw = tokens.join('.') + '!!!';
    return 'https://www.bandai-tcg-plus.com/deck_recipe?deck=' + encodeURIComponent(raw) + '&game_title_id=15';
  }

  /* ---------- ＋操作の上限（§8: ブロックは同名4枚のみ） ---------- */

  // その型番をあと何枚まで足せるか（base合算で4まで。制限値では止めない）
  function addableCount(deck, cardId, byId) {
    var c = byId.get(cardId);
    var base = c ? c.base : cardId;
    var per = perBaseCounts(deck, byId);
    return Math.max(0, MAX_PER_NAME - (per.get(base) || 0));
  }

  /* ---------- リンク対象カードの解決（§6・カード詳細） ----------
   * 実データ2形式（2026-07-22検証）:
   *   ①素の名前 → カード名一致 ＋ コマンド＋パイロット型のパイロット面名（pname）一致【タスク#19対応】
   *   ②「特徴〔…〕」形 → 接頭辞と括弧を除去し PILOT/COMMAND の特徴一致
   */
  function linkTargets(card, db) {
    var out = [], seen = new Set(), raw = [];
    (card.link || []).forEach(function (e) {
      var s = String(e).replace(/[「」]/g, '');
      var hits;
      if (/^特徴/.test(s) || /[〔]/.test(s)) {
        var trait = s.replace(/^特徴/, '').replace(/[〔〕()（）]/g, '');
        hits = db.cards.filter(function (x) {
          return !x.par && (x.type === 'PILOT' || x.type === 'COMMAND') && x.traits.indexOf(trait) !== -1;
        });
      } else {
        hits = db.cards.filter(function (x) {
          return !x.par && (x.name === s || x.pname === s);   // カード名 or パイロット面名
        });
      }
      if (!hits.length) { raw.push(e); return; }
      hits.forEach(function (x) { if (!seen.has(x.base)) { seen.add(x.base); out.push(x); } });
    });
    return { cards: out.slice(0, 40), raw: raw, more: Math.max(0, out.length - 40) };
  }

  // 逆引き: このパイロット（PILOTカード or コマンド＋パイロット型）をリンク対象にできるカード（主にUNIT）を列挙
  //   照合はリンク条件の2形式に対応: 素の名前＝card.name / card.pname と一致、特徴形＝このカードの traits に含まれる
  function linkableUnits(card, db) {
    var myNames = [];
    if (card.name) myNames.push(card.name);
    if (card.pname) myNames.push(card.pname);
    var myTraits = card.traits || [];
    var out = [], seen = new Set();
    db.cards.forEach(function (x) {
      if (x.par || !x.link || !x.link.length || x.base === card.base) return;
      var hit = x.link.some(function (e) {
        var s = String(e).replace(/[「」]/g, '');
        if (/^特徴/.test(s) || /[〔]/.test(s)) {
          var trait = s.replace(/^特徴/, '').replace(/[〔〕()（）]/g, '');
          return myTraits.indexOf(trait) !== -1;
        }
        return myNames.indexOf(s) !== -1;
      });
      if (hit && !seen.has(x.base)) { seen.add(x.base); out.push(x); }
    });
    return { cards: out.slice(0, 40), more: Math.max(0, out.length - 40) };
  }

  /* ---------- URL共有の符号化（§11・2026-07-22 実装確定） ----------
   * 方式: 型番そのものを詰める（マスター連番に依存しない＝新弾追加で過去URLが壊れない）。
   *   1カード = セット6bit + カード番号10bit(1..999) + パラレル3bit(0=通常,1..7=_pN) + 枚数3bit(枚数-1, 1..8)
   *   枚数9以上は同一型番を複数エントリに分割（復号側で合算）。ビット列→Base64URL、先頭1字は方式バージョン'A'。
   * セット表は追記専用（既存の並びは絶対に変えない。新弾は末尾に追加）。
   */
  var SET_CODES = [
    'GD01','GD02','GD03','GD04','GD05','GD06','GD07','GD08','GD09','GD10',
    'ST01','ST02','ST03','ST04','ST05','ST06','ST07','ST08','ST09','ST10','ST11','ST12',
    'EB01','EB02','EB03','SC01','SC02'
  ];
  var B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  // 弾グループの並び順（2026-07-23 松岡さん確定: 通常弾→特殊弾→デッキ→特殊セット）
  function setGroupRank(set) {
    if (/^GD/.test(set)) return 1;      // 通常弾（ブースター）
    if (/^EB/.test(set)) return 2;      // 特殊弾（エクストラブースター）
    if (/^ST/.test(set)) return 3;      // デッキ（スタートデッキ）
    if (/^SC/.test(set)) return 4;      // 特殊セット
    if (set === 'β') return 5;
    if (set === 'PROMO') return 6;
    return 9;
  }
  var SHARE_VERSION = 'A';

  function parseCardId(id) {
    var m = /^([A-Z]{2,4}\d{2})-(\d{3})(?:_p(\d))?$/.exec(id);
    if (!m) return null;
    return { set: m[1], num: parseInt(m[2], 10), par: m[3] ? parseInt(m[3], 10) : 0 };
  }

  function bitsToB64(bits) {
    var out = '';
    for (var i = 0; i < bits.length; i += 6) {
      var v = 0;
      for (var j = 0; j < 6; j++) v = (v << 1) | (bits[i + j] || 0);
      out += B64URL[v];
    }
    return out;
  }
  function b64ToBits(str) {
    var bits = [];
    for (var i = 0; i < str.length; i++) {
      var v = B64URL.indexOf(str[i]);
      if (v < 0) return null;
      for (var j = 5; j >= 0; j--) bits.push((v >> j) & 1);
    }
    return bits;
  }
  function pushBits(bits, value, width) {
    for (var j = width - 1; j >= 0; j--) bits.push((value >> j) & 1);
  }
  function readBits(bits, pos, width) {
    var v = 0;
    for (var j = 0; j < width; j++) v = (v << 1) | bits[pos + j];
    return v;
  }

  // deck → 共有コード。先行カード/未解決/表に無いセットは共有不可（reason・items で報告）
  function encodeShareCode(deck, byId) {
    var ids = Object.keys(deck).filter(function (id) { return deck[id] > 0; }).sort();
    if (!ids.length) return { ok: false, reason: 'empty', items: [] };
    var preview = [], bad = [];
    var bits = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var c = byId.get(id);
      if (c && c.pv) { preview.push(id); continue; }
      var p = parseCardId(id);
      var si = p ? SET_CODES.indexOf(p.set) : -1;
      if (!c || !p || si < 0 || p.num < 1 || p.num > 999 || p.par > 7) { bad.push(id); continue; }
      var rest = deck[id];
      while (rest > 0) {
        var q = Math.min(rest, 8);
        pushBits(bits, si, 6);
        pushBits(bits, p.num, 10);
        pushBits(bits, p.par, 3);
        pushBits(bits, q - 1, 3);
        rest -= q;
      }
    }
    if (preview.length) return { ok: false, reason: 'preview', items: preview };
    if (bad.length) return { ok: false, reason: 'unresolved', items: bad };
    return { ok: true, code: SHARE_VERSION + bitsToB64(bits), reason: null, items: [] };
  }

  // 共有コード → {cards, skipped}。未知バージョンは reason='version'
  function decodeShareCode(code, byId) {
    if (typeof code !== 'string' || code.length < 2 || code.length > 4000) return { ok: false, reason: 'invalid', cards: {}, skipped: [] };
    var ver = code[0];
    if (ver !== SHARE_VERSION) return { ok: false, reason: 'version', cards: {}, skipped: [] };
    var bits = b64ToBits(code.slice(1));
    if (!bits) return { ok: false, reason: 'invalid', cards: {}, skipped: [] };
    var cards = {}, skipped = [];
    for (var pos = 0; pos + 22 <= bits.length; pos += 22) {
      var si = readBits(bits, pos, 6);
      var num = readBits(bits, pos + 6, 10);
      var par = readBits(bits, pos + 16, 3);
      var q = readBits(bits, pos + 19, 3) + 1;
      var set = SET_CODES[si];
      if (!set || num < 1) continue;                       // パディング/不正エントリは無視
      var id = set + '-' + String(num).padStart(3, '0') + (par ? '_p' + par : '');
      if (!byId.get(id)) { if (skipped.indexOf(id) === -1) skipped.push(id); continue; }
      cards[id] = Math.min((cards[id] || 0) + q, 99);
    }
    return { ok: true, reason: null, cards: cards, skipped: skipped };
  }

  /* ---------- 貼り付けインポートの自動判別（§10.4/§10.6・2026-07-22 実装） ----------
   * 判別順: ①当サイト共有URL(?d=) ②TCG＋URL(deck=) ③GCG DOCK形式(名前|型番:枚数|…)
   *         ④EXBURST形式(枚数 型番 の行) ⑤汎用フォールバック(型番の羅列＋近傍の枚数)
   * 前処理: 全角→半角(数字/コロン/パイプ/スペース/×)・型番大文字化・重複合算。
   * 安全策(§10.5): 入力20,000字/500行/800トークン上限・枚数99クリップ・実在型番のみ採用(未解決は報告)。
   */
  function toHalfWidth(s) {
    return String(s)
      .replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
      .replace(/：/g, ':').replace(/｜/g, '|').replace(/　/g, ' ')
      .replace(/[×Ｘｘ]/g, 'x');
  }
  function normId(raw) {
    return raw.toUpperCase().replace('_P', '_p');
  }
  function addParsed(cards, unresolved, rawId, qty, byId) {
    var id = normId(rawId);
    var q = Math.max(1, Math.floor(Number(qty) || 1));
    if (byId.get(id)) cards[id] = Math.min((cards[id] || 0) + q, 99);
    else if (unresolved.indexOf(id) === -1) unresolved.push(id);
  }
  // tokensRev: TCG＋token → 型番 の逆引きマップ（呼び出し側で構築）
  function parsePastedDeck(text, db, tokensRev) {
    if (text == null) return { kind: 'none', name: '', cards: {}, unresolved: [], truncated: false };
    var truncated = String(text).length > 20000;
    var t = toHalfWidth(String(text).slice(0, 20000)).trim();
    if (!t) return { kind: 'none', name: '', cards: {}, unresolved: [], truncated: truncated };
    var byId = db.byId;
    var cards = {}, unresolved = [];

    // ① 当サイト共有URL（?d=）
    var md = /[?&]d=([A-Za-z0-9_-]{2,4000})/.exec(t);
    if (md) {
      var dec = decodeShareCode(md[1], byId);
      if (dec.ok && Object.keys(dec.cards).length) {
        var name = '';
        var mn = /[?&]n=([^&\s]+)/.exec(t);
        if (mn) { try { name = decodeURIComponent(mn[1]).slice(0, 30); } catch (e) { name = ''; } }
        return { kind: 'siteurl', name: name, cards: dec.cards, unresolved: dec.skipped, truncated: truncated };
      }
    }

    // ② TCG＋URL（deck=）
    var mt = /deck=([^&\s]+)/.exec(t);
    if (mt && tokensRev) {
      var body = mt[1];
      try { body = decodeURIComponent(body); } catch (e) { /* 素のまま */ }
      body = body.replace(/!+$/, '');
      var toks = body.split('.').filter(Boolean).slice(0, 800);
      if (toks.length) {
        toks.forEach(function (tk) {
          var id = tokensRev[tk];
          if (id && byId.get(id)) cards[id] = Math.min((cards[id] || 0) + 1, 99);
          else if (unresolved.indexOf(tk) === -1) unresolved.push(tk);
        });
        return { kind: 'tcgplus', name: '', cards: cards, unresolved: unresolved, truncated: truncated };
      }
    }

    var ID_PAIR = /^([A-Za-z]{2,4}\d{2}-\d{3}(?:_[pP]\d)?):(\d{1,2})$/;

    // ③ GCG DOCK形式（| 区切り・先頭はデッキ名）
    if (t.indexOf('|') !== -1 && /[A-Za-z]{2,4}\d{2}-\d{3}(?:_[pP]\d)?:\d/.test(t)) {
      var segs = t.split('|').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 500);
      var dockName = '';
      segs.forEach(function (sg, i) {
        var mm = ID_PAIR.exec(sg);
        if (mm) addParsed(cards, unresolved, mm[1], mm[2], byId);
        else if (i === 0 && !dockName) dockName = sg.slice(0, 30);
      });
      return { kind: 'gcgdock', name: dockName, cards: cards, unresolved: unresolved, truncated: truncated };
    }

    // ④ EXBURST形式（各行「枚数 型番」）
    var lines = t.split(/\r?\n/).slice(0, 500);
    var exbHit = false;
    lines.forEach(function (l) {
      var mm = /^\s*(\d{1,2})\s+([A-Za-z]{2,4}\d{2}-\d{3}(?:_[pP]\d)?)\s*$/.exec(l);
      if (mm) { exbHit = true; addParsed(cards, unresolved, mm[2], mm[1], byId); }
    });
    if (exbHit) return { kind: 'exburst', name: '', cards: cards, unresolved: unresolved, truncated: truncated };

    // ⑤ 汎用フォールバック（型番 x枚数 / 型番:枚数 / 型番のみ=1枚）
    var g = /([A-Za-z]{2,4}\d{2}-\d{3}(?:_[pP]\d)?)(?:\s*(?:x\s*(\d{1,2})|:\s*(\d{1,2})))?/g;
    var m2, hit = 0;
    while ((m2 = g.exec(t)) && hit < 800) {
      hit++;
      addParsed(cards, unresolved, m2[1], m2[2] || m2[3] || 1, byId);
    }
    if (hit) return { kind: 'generic', name: '', cards: cards, unresolved: unresolved, truncated: truncated };

    return { kind: 'none', name: '', cards: {}, unresolved: [], truncated: truncated };
  }

  /* ---------- 施行前案内（§5.3: 判定は常時新レギュ・日付は案内文のみ） ---------- */

  function isBeforeEffective(now) {
    var d = now || new Date();
    return d.getTime() < new Date(EFFECTIVE_DATE + 'T00:00:00+09:00').getTime();
  }

  /* ---------- 保存スキーマ（§12・§13.1 正準形） ---------- */

  function newDeckObject(name, cards, byId) {
    return {
      id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: name || '無題のデッキ',
      cards: cards || {},
      colors: deckColors(cards || {}, byId),
      updated: new Date().toISOString()
    };
  }

  return {
    EFFECTIVE_DATE: EFFECTIVE_DATE,
    EFFECTIVE_LABEL: EFFECTIVE_LABEL,
    DECK_SIZE: DECK_SIZE,
    MAX_PER_NAME: MAX_PER_NAME,
    MAX_SAVED_DECKS: MAX_SAVED_DECKS,
    COLOR_JA: COLOR_JA,
    escapeHtml: escapeHtml,
    slimFromMaster: slimFromMaster,
    normalizePreview: normalizePreview,
    buildDb: buildDb,
    totalCount: totalCount,
    perBaseCounts: perBaseCounts,
    deckColors: deckColors,
    previewIdsInDeck: previewIdsInDeck,
    validate: validate,
    frameKind: frameKind,
    regBadge: regBadge,
    tcgStatus: tcgStatus,
    tcgUrl: tcgUrl,
    addableCount: addableCount,
    extractPilotName: extractPilotName,
    linkTargets: linkTargets,
    linkableUnits: linkableUnits,
    SET_CODES: SET_CODES,
    setGroupRank: setGroupRank,
    parseCardId: parseCardId,
    encodeShareCode: encodeShareCode,
    decodeShareCode: decodeShareCode,
    toHalfWidth: toHalfWidth,
    parsePastedDeck: parsePastedDeck,
    isBeforeEffective: isBeforeEffective,
    newDeckObject: newDeckObject
  };
});
