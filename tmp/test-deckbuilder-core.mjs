/**
 * test-deckbuilder-core.mjs — §16 検証チェックリストの境界テスト（一次確認）
 * 実データ（cards_master / restrictions / tokenmap）に対して DeckCore を検証する。
 * 実行: node tmp/test-deckbuilder-core.mjs
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import url from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const C = require(path.join(ROOT, 'js/deckbuilder-core.js'));
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf-8'));

const master = Object.values(read('data/cards_master.json')).filter(c => c && c.id);
const slim = master.map(C.slimFromMaster);
const R = read('data/restrictions.json');
const tmRaw = read('data/tcgplus_tokenmap.json');
const TOKENS = {};
for (const [k, v] of Object.entries(tmRaw)) if (k !== '_meta' && v && v.token) TOKENS[k] = v.token;

// 合成先行カード（実previewは実質0件のため、§16の指示どおりスタブを投入して検証）
const stubPreview = [{
  card_number: 'ZZ99-001', card_name: 'テスト先行機体', color: 'Blue', card_type: 'UNIT',
  level: 3, cost: 2, ap: 3, hp: 2, terrain: ['宇宙', '地球'], traits: ['〔テスト〕'],
  link: 'テストパイロット', rarity: 'R', effect: '【テスト】効果。'
}];
const db = C.buildDb(slim, stubPreview);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
};
const kinds = (v) => v.map(x => x.kind).sort().join(',');

// 禁止・制限・ペア・グループのどれにも触れない青カードで50枚デッキを構築
const NG = new Set([...(R.banned || []), ...(R.restricted || []).map(r => r.id)]);
(R.banned_pairs?.specific || []).flat().forEach(id => NG.add(id));
(R.banned_pairs?.group?.members || []).forEach(id => NG.add(id));
const pool = db.cards.filter(c => c.color === 'Blue' && !c.par && !c.pv && !NG.has(c.base));
function cleanDeck(total = 50) {
  const d = {};
  let sum = 0;
  for (const c of pool) {
    if (sum >= total) break;
    const q = Math.min(4, total - sum);
    d[c.id] = q; sum += q;
  }
  return d;
}

console.log('== 1. 枚数判定 ==');
{
  const d = cleanDeck(50);
  ok('50枚ちょうど・1色 → 違反0', C.validate(d, db, R).length === 0, kinds(C.validate(d, db, R)));
  const d49 = cleanDeck(49);
  const v49 = C.validate(d49, db, R);
  ok('49枚 → count違反のみ・「あと1枚」', kinds(v49) === 'count' && v49[0].msg.includes('あと1枚'), JSON.stringify(v49));
  const d53 = cleanDeck(53);
  const v53 = C.validate(d53, db, R);
  ok('53枚 → count違反・「3枚超過」', kinds(v53) === 'count' && v53[0].msg.includes('3枚超過'), JSON.stringify(v53));
}

console.log('== 2. 色数判定（方式A・警告のみ） ==');
{
  const g = db.cards.find(c => c.color === 'Green' && !c.par && !NG.has(c.base));
  const r = db.cards.find(c => c.color === 'Red' && !c.par && !NG.has(c.base));
  const d = cleanDeck(42); d[g.id] = 4; d[r.id] = 4;
  const v = C.validate(d, db, R);
  ok('青+緑+赤(50枚) → colors違反のみ・3色表記', kinds(v) === 'colors' && v[0].msg.includes('3色'), JSON.stringify(v.map(x=>x.msg)));
  const d2 = cleanDeck(46); d2[g.id] = 4;
  ok('青+緑(50枚・2色) → 違反0', C.validate(d2, db, R).length === 0, kinds(C.validate(d2, db, R)));
}

console.log('== 3. 制限カード（コルシカ ST02-016・最大2枚） ==');
{
  const d2 = cleanDeck(48); d2['ST02-016'] = 2;
  const v2 = C.validate(d2, db, R).filter(v => v.kind === 'limited');
  ok('2枚 → 制限違反なし', v2.length === 0);
  const d3 = cleanDeck(47); d3['ST02-016'] = 3;
  const v3 = C.validate(d3, db, R).filter(v => v.kind === 'limited');
  ok('3枚 → limited違反・「最大2枚まで（現在3枚」', v3.length === 1 && v3[0].msg.includes('最大2枚まで（現在3枚'), JSON.stringify(v3));
  ok('制限値では＋を止めない（2枚時 addable=2）', C.addableCount(d2, 'ST02-016', db.byId) === 2, String(C.addableCount(d2, 'ST02-016', db.byId)));
}

console.log('== 4. 禁止カード（GD01-020） ==');
{
  const d = cleanDeck(49); d['GD01-020'] = 1;
  const v = C.validate(d, db, R).filter(v => v.kind === 'banned');
  ok('1枚で banned違反・施行日併記', v.length === 1 && v[0].msg.includes('2026年7月25日'), JSON.stringify(v));
}

console.log('== 5. 禁止ペア（個別: GD01-008 × GD05-015） ==');
{
  const dBoth = cleanDeck(42); dBoth['GD01-008'] = 4; dBoth['GD05-015'] = 4;
  const vB = C.validate(dBoth, db, R).filter(v => v.kind === 'pair');
  ok('両方 → pair違反', vB.length === 1, JSON.stringify(vB));
  const dOne = cleanDeck(46); dOne['GD01-008'] = 4;
  const vO = C.validate(dOne, db, R).filter(v => v.kind === 'pair');
  ok('片方のみ → 違反なし', vO.length === 0);
}

console.log('== 6. 20種グループ ==');
{
  const m = R.banned_pairs.group.members;
  const d2 = cleanDeck(42); d2[m[0]] = 4; d2[m[1]] = 4;
  const vG = C.validate(d2, db, R).filter(v => v.kind === 'group');
  ok('2種 → group違反・ST05特例注記つき', vG.length === 1 && (vG[0].note || '').includes('ST05'), JSON.stringify(vG));
  const d1 = cleanDeck(46); d1[m[0]] = 4;
  ok('1種×4枚 → 違反なし', C.validate(d1, db, R).filter(v => v.kind === 'group').length === 0);
}

console.log('== 7. 同名4枚（base_card_id 名寄せ・§6.4） ==');
{
  // 通常版3 + パラレル2 = base5枚 → over4（インポート由来を想定）
  const par = db.cards.find(c => c.par && db.byId.get(c.base));
  const d = cleanDeck(45); d[par.base] = 3; d[par.id] = 2;
  const v = C.validate(d, db, R).filter(v => v.kind === 'over4');
  ok('通常3+パラレル2=5枚 → over4違反', v.length === 1 && v[0].msg.includes('現在5枚'), JSON.stringify(v));
  // ＋のブロック: base合算4で addable=0（パラレル側にも足せない）
  const d4 = {}; d4[par.base] = 2; d4[par.id] = 2;
  ok('base合算4 → addable=0（通常版）', C.addableCount(d4, par.base, db.byId) === 0);
  ok('base合算4 → addable=0（パラレル版）', C.addableCount(d4, par.id, db.byId) === 0);
}

console.log('== 8. TCG＋登録可否（3系統・§5.4/§10.1） ==');
{
  const dBad = cleanDeck(53);
  ok('違反あり → reason=violation', C.tcgStatus(dBad, db, TOKENS, C.validate(dBad, db, R)).reason === 'violation');
  const dPv = cleanDeck(46); dPv['ZZ99-001'] = 4;
  const stPv = C.tcgStatus(dPv, db, TOKENS, C.validate(dPv, db, R));
  ok('先行カード入り(違反なし) → reason=preview', stPv.reason === 'preview' && stPv.items.includes('ZZ99-001'), JSON.stringify(stPv));
  const dOk = cleanDeck(50);
  const stOk = C.tcgStatus(dOk, db, TOKENS, C.validate(dOk, db, R));
  if (stOk.ok) {
    const u = C.tcgUrl(dOk, db, TOKENS);
    ok('適正50枚 → ok・URLに deck= と !!!(エンコード済)', u.includes('deck_recipe?deck=') && u.includes(encodeURIComponent('!!!')) && u.includes('game_title_id=15'), u.slice(0, 90));
    const tokenCount = decodeURIComponent(u.split('deck=')[1].split('&')[0]).replace('!!!','').split('.').length;
    ok('URL内トークン数=50', tokenCount === 50, String(tokenCount));
  } else {
    ok('適正50枚 → ok（token未収載カードが混入: ' + JSON.stringify(stOk.items) + '）', false);
  }
  const noTok = db.cards.find(c => !c.par && !c.pv && !TOKENS[c.base] && !NG.has(c.base) && c.color === 'Blue');
  if (noTok) {
    const dU = cleanDeck(46); dU[noTok.id] = 4;
    const stU = C.tcgStatus(dU, db, TOKENS, C.validate(dU, db, R));
    ok('変換表未収載 → reason=unmapped', stU.reason === 'unmapped', JSON.stringify(stU));
  } else {
    console.log('  （token未収載の青カードが無いため unmapped 系はスキップ）');
  }
}

console.log('== 8b. パラレル固有トークン（§10.3改・GD05パラレル対応） ==');
{
  let parTok = {};
  try { parTok = read('data/tcgplus_parallel_tokens.json'); } catch (e) {}
  const T2 = { ...TOKENS };
  for (const [k, v] of Object.entries(parTok)) if (k !== '_meta' && typeof v === 'string') T2[k] = v;
  const parId = Object.keys(parTok).find(k => k !== '_meta' && db.byId.get(k) && T2[db.byId.get(k).base] && T2[k] && T2[k] !== T2[db.byId.get(k).base]);
  if (parId) {
    const base = db.byId.get(parId).base;
    const u = C.tcgUrl({ [parId]: 1 }, db, T2);
    const code = decodeURIComponent(u.split('deck=')[1].split('&')[0]).replace('!!!', '');
    ok('パラレルは自トークンを使用（本体トークンと異なる）', code === T2[parId] && code !== T2[base], 'par=' + T2[parId] + ' base=' + T2[base] + ' got=' + code);
  } else {
    console.log('  （GD05パラレルがdb/変換表に無いためスキップ）');
  }
}

console.log('== 9. 先行カード正規化（§13） ==');
{
  const p = db.byId.get('ZZ99-001');
  ok('terrain 配列→文字列', p.terrain === '宇宙 地球', p.terrain);
  ok('link 文字列→配列', Array.isArray(p.link) && p.link[0] === 'テストパイロット', JSON.stringify(p.link));
  ok('traits 括弧除去', p.traits[0] === 'テスト', JSON.stringify(p.traits));
  ok('収録弾を型番接頭辞から導出', p.set === 'ZZ99', p.set);
  ok('base=自身・pv=1', p.base === 'ZZ99-001' && p.pv === 1);
  ok('禁止制限は先行カードに適用されない', C.regBadge('ZZ99-001', R) === null);
}

console.log('== 10. 枠色の優先度（§5.4: 禁止＞ペア＞制限） ==');
{
  const d = cleanDeck(42); d['GD01-020'] = 4; d['ST02-016'] = 4; // 禁止 + 制限超過
  const v = C.validate(d, db, R);
  ok('禁止カードの枠=banned', C.frameKind('GD01-020', db.byId, v) === 'banned');
  ok('制限超過カードの枠=limited', C.frameKind('ST02-016', db.byId, v) === 'limited');
}

console.log('== 11. 施行日（§5.3: 判定は常時・案内文のみ日付） ==');
{
  ok('7/24 → 施行前（案内を出す）', C.isBeforeEffective(new Date('2026-07-24T12:00:00+09:00')) === true);
  ok('7/25 → 施行後（案内を出さない）', C.isBeforeEffective(new Date('2026-07-25T00:00:01+09:00')) === false);
  ok('7/26 → 施行後', C.isBeforeEffective(new Date('2026-07-26T12:00:00+09:00')) === false);
}

console.log('== 12. master∪preview（master優先） ==');
{
  const dup = C.buildDb(slim, [{ card_number: slim[0].id, card_name: '偽物' }]);
  ok('同一型番の preview は master 優先', dup.byId.get(slim[0].id).name !== '偽物');
  ok('TOKEN はデッキ対象から除外', db.cards.every(c => c.type !== 'TOKEN'));
}

console.log('== 13. レビュー指摘の追加検証（2026-07-22） ==');
{
  // unmapped を実際に実行（tokenmapのコピーから1件消して合成）
  const first = pool[0];
  const T2 = { ...TOKENS };
  delete T2[first.base];
  const dU = cleanDeck(50);
  const stU = C.tcgStatus(dU, db, T2, C.validate(dU, db, R));
  ok('token欠落を合成 → reason=unmapped・該当id列挙', stU.reason === 'unmapped' && stU.items.includes(first.id), JSON.stringify(stU));

  // パラレル入りデッキのURL: base の token が枚数分入る（§10.3）
  // ※ベースデッキ側と base が衝突しないパラレルを選ぶ（衝突すると合算8枚=over4で別の違反になる）
  const dP = cleanDeck(46);
  const usedBases = new Set(Object.keys(dP).map(id => (db.byId.get(id)||{}).base || id));
  const par = db.cards.find(c => c.par && TOKENS[c.base] && !NG.has(c.base) && !usedBases.has(c.base));
  dP[par.id] = 4;
  const stP = C.tcgStatus(dP, db, TOKENS, C.validate(dP, db, R));
  ok('パラレル入り50枚 → 登録ok', stP.ok === true, JSON.stringify(stP));
  const uP = C.tcgUrl(dP, db, TOKENS);
  const decoded = decodeURIComponent(uP.split('deck=')[1].split('&')[0]);
  const cnt = decoded.replace('!!!','').split('.').filter(t => t === TOKENS[par.base]).length;
  ok('URLに base token が4回（パラレル→通常版token置換）', cnt >= 4, 'count=' + cnt + ' token=' + TOKENS[par.base]);
  ok('デコード後の末尾が !!!', decoded.endsWith('!!!'));

  // '+'や'/'を含むtokenのエンコード（%エンコードされ生の+が残らない）
  const plusTok = Object.entries(TOKENS).find(([k,v]) => /[+/]/.test(v));
  if (plusTok) {
    const holder = db.cards.find(c => c.base === plusTok[0] && !c.par);
    if (holder) {
      const dE = {}; dE[holder.id] = 1;
      const uE = C.tcgUrl(dE, db, TOKENS);
      const qv = uE.split('deck=')[1].split('&')[0];
      ok("token内の '+'/'/' が%エンコードされる", !/[+]/.test(qv) && !/\//.test(qv), qv);
    } else { console.log('  （+/入りtokenの通常カードなし・スキップ）'); }
  } else { console.log('  （+/入りtokenなし・スキップ）'); }

  // 空デッキ → reason=empty
  ok('空デッキ → reason=empty', C.tcgStatus({}, db, TOKENS, []).reason === 'empty');

  // over4 の枠色 = limited（橙・制限と共用）
  const par2 = db.cards.find(c => c.par);
  const dO = cleanDeck(45); dO[par2.base] = 3; dO[par2.id] = 2;
  const vO = C.validate(dO, db, R);
  ok('over4 の枠=limited（橙）・通常版側', C.frameKind(par2.base, db.byId, vO) === 'limited');
  ok('over4 の枠=limited（橙）・パラレル側', C.frameKind(par2.id, db.byId, vO) === 'limited');

  // 未解決型番（byIdに無いid）: validateは落ちず、tcgStatusはunmapped
  const dX = cleanDeck(46); dX['XX99-999'] = 4;
  const vX = C.validate(dX, db, R);
  ok('未解決型番混入 → validateが例外なく50枚として判定', vX.filter(x=>x.kind==='count').length === 0);
  const stX = C.tcgStatus(dX, db, TOKENS, vX);
  ok('未解決型番混入 → reason=unmapped', stX.reason === 'unmapped' && stX.items.includes('XX99-999'), JSON.stringify(stX));
}

console.log('== 14. URL共有の符号化（§11・2026-07-22実装） ==');
{
  // 50枚（パラレル・コルシカ2枚込み）ラウンドトリップ
  const dR = cleanDeck(42);
  const usedB = new Set(Object.keys(dR).map(id => (db.byId.get(id)||{}).base || id));
  const par = db.cards.find(c => c.par && !NG.has(c.base) && !usedB.has(c.base));
  dR[par.id] = 4; dR['ST02-016'] = 2; dR[Object.keys(dR)[0]] = dR[Object.keys(dR)[0]] - 4 + 2; // 合計50調整(4→2で-2, +6分は par4+corsica2で+6 → 42-2+... )
  // ↑調整が煩雑なので単純に作り直す: 40 + par4 + corsica2 + 4 = 50
  const d2 = cleanDeck(40);
  const usedB2 = new Set(Object.keys(d2).map(id => (db.byId.get(id)||{}).base || id));
  const par2 = db.cards.find(c => c.par && !NG.has(c.base) && !usedB2.has(c.base));
  const extra = pool.find(c => !usedB2.has(c.base) && c.base !== par2.base && c.base !== 'ST02-016');
  d2[par2.id] = 4; d2['ST02-016'] = 2; d2[extra.id] = 4;
  ok('検証デッキ=50枚', C.totalCount(d2) === 50, String(C.totalCount(d2)));
  const enc = C.encodeShareCode(d2, db.byId);
  ok('符号化ok・バージョンA先頭', enc.ok && enc.code[0] === 'A', JSON.stringify(enc).slice(0,80));
  const dec = C.decodeShareCode(enc.code, db.byId);
  ok('復号ok・完全一致（パラレル/制限カード込み）', dec.ok && JSON.stringify(dec.cards) === JSON.stringify(Object.fromEntries(Object.entries(d2).sort())), 'skipped='+dec.skipped.length);
  ok('URL長が現実的（50枚で200字未満）', enc.code.length < 200, enc.code.length + '字');

  // 枚数9以上（違反状態）も分割エントリで往復できる
  const d9 = {}; d9[pool[0].id] = 9;
  const e9 = C.encodeShareCode(d9, db.byId);
  const r9 = C.decodeShareCode(e9.code, db.byId);
  ok('枚数9（4枚超違反）も往復一致', r9.cards[pool[0].id] === 9, JSON.stringify(r9.cards));

  // 先行カードは共有不可
  const dPv = cleanDeck(46); dPv['ZZ99-001'] = 4;
  ok('先行カード入り → reason=preview', C.encodeShareCode(dPv, db.byId).reason === 'preview');

  // 未収載idは共有不可
  const dU = cleanDeck(46); dU['XX99-999'] = 4;
  ok('未収載id入り → reason=unresolved', C.encodeShareCode(dU, db.byId).reason === 'unresolved');

  // 未知バージョンは拒否
  ok('未知バージョン → reason=version', C.decodeShareCode('Z' + enc.code.slice(1), db.byId).reason === 'version');
  ok('不正文字列 → reason=invalid', C.decodeShareCode('A!!!ﾃｽﾄ', db.byId).reason === 'invalid');

  // 復号側: マスターに無い型番はskippedに載りデッキは壊れない
  // （GD09は表にあるが実カード無し → set6bit=GD09で合成）
  ok('SET_CODES整合: 全マスター通常カードのセットが表に存在',
    db.cards.filter(c=>!c.pv).every(c => { var p=C.parseCardId(c.id); return p && C.SET_CODES.indexOf(p.set) !== -1; }));
}

console.log('== 15. コマンド＋パイロット型のリンク解決（タスク#19・2026-07-22） ==');
{
  const pcs = db.cards.filter(c => !c.par && !c.pv && c.pname);
  ok('パイロット面名の抽出=64種（通常版）', pcs.length === 64, String(pcs.length));
  ok('抽出名が空でない', pcs.every(c => c.pname.length > 0));
  // EB01-001（リンク: ロウ・ギュール）→ コマンドEB01-076が解決される
  const r1 = C.linkTargets(db.byId.get('EB01-001'), db);
  ok('EB01-001のリンク「ロウ・ギュール」→ EB01-076（ガーベラ・ストレート）',
     r1.cards.some(x => x.id === 'EB01-076') && r1.raw.length === 0, JSON.stringify({cards:r1.cards.map(x=>x.id),raw:r1.raw}));
  // PILOTカードとパイロットコマンドが同名のケース → 両方リストされる
  const dual = db.cards.find(c => !c.par && c.type === 'PILOT' &&
    db.cards.some(k => !k.par && k.pname === c.name));
  if (dual) {
    const holder = { link: [dual.name], id:'TEST' };
    const r2 = C.linkTargets(holder, db);
    const hasP = r2.cards.some(x => x.type === 'PILOT');
    const hasC = r2.cards.some(x => x.type === 'COMMAND');
    ok('同名（'+dual.name+'）→ PILOTとコマンドの両方がヒット', hasP && hasC, JSON.stringify(r2.cards.map(x=>x.id+':'+x.type)));
  } else { ok('同名ケースの存在（データ上5例あるはず）', false); }
  // 実在しないパイロット名は引き続きraw（未収載）扱い
  const r3 = C.linkTargets({ link: ['シャリア・ブル'], id:'TEST2' }, db);
  ok('真の未収載（シャリア・ブル）→ raw扱い', r3.cards.length === 0 && r3.raw.length === 1);
  // 全体の解決率再計測
  const withLink = db.cards.filter(c => !c.par && !c.pv && c.link && c.link.length);
  let full=0, none=0;
  withLink.forEach(c => { const r = C.linkTargets(c, db); if (r.cards.length && !r.raw.length) full++; else if (!r.cards.length) none++; });
  ok('全解決が367→400件以上に改善', full >= 400, 'full='+full+' none='+none);
}

console.log('== 16. パイロット側の逆引き（リンク対象カード・2026-07-22） ==');
{
  // pname逆引き: ガーベラ・ストレート(EB01-076・パイロット面ロウ・ギュール) → EB01-001が出る
  const r1 = C.linkableUnits(db.byId.get('EB01-076'), db);
  ok('EB01-076の逆引き → EB01-001（リンク: ロウ・ギュール）', r1.cards.some(x => x.id === 'EB01-001'), JSON.stringify(r1.cards.map(x=>x.id)));
  // 特徴形逆引き: 〔ジージェネ〕特徴を持つPILOT → 特徴〔ジージェネ〕リンクのユニット(EB01-002等)が出る
  const gp = db.cards.find(c => !c.par && c.type === 'PILOT' && c.traits.indexOf('ジージェネ') !== -1);
  const r2 = C.linkableUnits(gp, db);
  ok('ジージェネPILOT('+gp.id+')の逆引き → EB01-002を含む', r2.cards.some(x => x.id === 'EB01-002'), 'hits='+r2.cards.length);
  // 名前逆引き: 素の名前リンクを持つユニット→そのPILOTからの逆引きに元ユニットが出る
  const uNamed = db.cards.find(c => !c.par && c.link && c.link.some(e => !/^特徴|[〔]/.test(e) &&
    db.cards.some(p => !p.par && p.type === 'PILOT' && p.name === String(e).replace(/[「」]/g,''))));
  const pn = String(uNamed.link.find(e => !/^特徴|[〔]/.test(e))).replace(/[「」]/g,'');
  const pCard = db.cards.find(p => !p.par && p.type === 'PILOT' && p.name === pn);
  const r3 = C.linkableUnits(pCard, db);
  ok('名前逆引き: '+pCard.id+'('+pn+') → '+uNamed.id+' を含む', r3.cards.some(x => x.base === uNamed.base), 'hits='+r3.cards.length);
  // 自分自身は逆引きに含まれない
  ok('逆引きに自分自身は含まれない', !r1.cards.some(x => x.base === 'EB01-076'));
}

console.log('== 17. 貼り付けインポートの自動判別（§10.4/§10.6・2026-07-22） ==');
{
  const REV = {}; Object.keys(TOKENS).forEach(id => { if (!(TOKENS[id] in REV)) REV[TOKENS[id]] = id; });
  const P = (s) => C.parsePastedDeck(s, db, REV);
  const a = pool[0].id, b = pool[1].id;

  // GCG DOCK形式（名前|型番:枚数|…・全角混じり）
  const r1 = P('青単テスト｜'+a+'：4|'+b.toLowerCase()+':2|XX99-999:3');
  ok('GCG DOCK: 判別・名前・全角正規化・小文字型番', r1.kind==='gcgdock' && r1.name==='青単テスト' && r1.cards[a]===4 && r1.cards[b]===2, JSON.stringify(r1));
  ok('GCG DOCK: 未収載は unresolved 報告', r1.unresolved.length===1 && r1.unresolved[0]==='XX99-999');

  // EXBURST形式（枚数 型番 の行）
  const r2 = P('４ '+a+'\n2 '+b+'\nこれはメモ行');
  ok('EXBURST: 判別・全角枚数・メモ行無視', r2.kind==='exburst' && r2.cards[a]===4 && r2.cards[b]===2 && Object.keys(r2.cards).length===2, JSON.stringify(r2.cards));

  // 汎用（x表記・:表記・型番のみ＝1枚・重複合算）
  const r3 = P(a+' x2 '+b+':3 '+a);
  ok('汎用: x/:/裸=1枚・重複合算', r3.kind==='generic' && r3.cards[a]===3 && r3.cards[b]===3, JSON.stringify(r3.cards));

  // 当サイト共有URL（ラウンドトリップ）
  const dS = cleanDeck(50);
  const enc2 = C.encodeShareCode(dS, db.byId);
  const r4 = P('https://gcg-stats.com/deck-builder.html?d='+enc2.code+'&n='+encodeURIComponent('共有デッキ'));
  ok('共有URL: 判別・名前・完全復元', r4.kind==='siteurl' && r4.name==='共有デッキ' && JSON.stringify(r4.cards)===JSON.stringify(Object.fromEntries(Object.entries(dS).sort())));

  // TCG＋URL（自サイト生成→貼り戻しラウンドトリップ）
  const dT = cleanDeck(50);
  const url = C.tcgUrl(dT, db, TOKENS);
  const r5 = P(url);
  ok('TCG＋URL: 判別・50枚復元', r5.kind==='tcgplus' && C.totalCount(r5.cards)===50 && JSON.stringify(r5.cards)===JSON.stringify(Object.fromEntries(Object.entries(dT).sort())), 'total='+C.totalCount(r5.cards));

  // 空・ゴミ入力
  ok('空入力 → none', P('').kind==='none');
  ok('無関係テキスト → none', P('こんにちは、これはデッキではありません。').kind==='none');

  // 枚数99クリップ
  const r6 = P(a+':99\n'+a+':99');
  ok('枚数は99でクリップ', r6.cards[a]===99);
}

console.log('== 18. 弾グループ並び順（#17決着・2026-07-23） ==');
{
  const r = C.setGroupRank;
  ok('通常弾GD < 特殊弾EB < デッキST < SC < β < PROMO',
     r('GD05') < r('EB01') && r('EB01') < r('ST01') && r('ST10') < r('SC01') && r('SC01') < r('β') && r('β') < r('PROMO'),
     [r('GD05'),r('EB01'),r('ST01'),r('SC01'),r('β'),r('PROMO')].join('<'));
  ok('同グループ内はグループ値が同一（型番昇順に委ねる）', r('GD01') === r('GD05') && r('ST01') === r('ST10'));
  // 実データを弾・型番順に並べたときの先頭と境界
  const sorted = db.cards.slice().sort((a,b)=>(r(a.set)-r(b.set))||(a.id<b.id?-1:1));
  ok('先頭はGD01-001', sorted[0].id === 'GD01-001', sorted[0].id);
  const firstEB = sorted.findIndex(c=>/^EB/.test(c.set));
  const firstST = sorted.findIndex(c=>/^ST/.test(c.set));
  ok('GD群の後にEB群、その後にST群', firstEB > 0 && firstST > firstEB,
     'EB@'+firstEB+' ST@'+firstST);
  ok('GD群の末尾までにEB/STが混ざらない', sorted.slice(0,firstEB).every(c=>/^GD/.test(c.set)));

  // SP(パラレル)は各弾の末尾に型番順（2026-07-23 追加確定）
  const sorted2 = db.cards.slice().sort((a,b)=>(r(a.set)-r(b.set))||(a.par-b.par)||(a.id<b.id?-1:1));
  let okOrder = true, prev = null;
  for (const c of sorted2) {
    const key = r(c.set) + ':' + c.set;   // 同ランク内は弾が分かれないため rank単位で par の逆転を検査
    if (prev && prev.rank === r(c.set) && prev.set === c.set && prev.par === 1 && c.par === 0) { okOrder = false; break; }
    prev = { rank: r(c.set), set: c.set, par: c.par };
  }
  ok('各弾内で通常カード→SP(パラレル)の順に並ぶ', okOrder);
  const gd01 = sorted2.filter(c=>c.set==='GD01');
  const firstPar = gd01.findIndex(c=>c.par===1);
  ok('GD01: 通常の後にSPがまとまり、SP内は型番順', firstPar > 0 && gd01.slice(firstPar).every(c=>c.par===1), 'firstPar='+firstPar+'/'+gd01.length);
}

console.log('\n結果: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
