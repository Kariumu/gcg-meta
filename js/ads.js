/* GCG STATS — 広告の枠(指示書133 の枠・指示書152 で AdSense に差し替え)
 *
 * このファイルは手で書いたファイル(生成物ではない)。直すときはこのファイルを直接直す。
 *
 * 動き:
 *   ページに置かれた <div class="ad-slot" data-slot="…" data-kind="band|rect"> を探し、
 *   枠の実際の幅に収まる AdSense の固定サイズの広告ユニットを 1 つだけ選んで差し込む。
 *   収まらない幅では何も出さない(ad-slot-none)。
 *   差し込む <ins> は AdSense の管理画面が「固定サイズ」で出す形と同じ(属性と順序を変えない)。
 *   pub ID はこのファイルに持たない。ページの head にある AdSense の読み込みタグの client= から実行時に読む。
 *   読めなければ何もしない(枠は空のまま。高さの予約はページ側にあるので本文は動かない)。
 *   マイページの枠(data-slot が mypage- で始まる)は、お気に入りが 1 件以上あるときだけ埋める(指示書152 §8-1)。
 *   広告が埋まらなかったとき(unfilled)も何もしない(畳むと本文が動くため。§8-2)。
 *   枠の高さの予約はページ側の <style> が持つ。ここの <style> は中身の見た目だけ。
 *   置き場所ごとの広告ユニット(PLACEMENT_SLOTS・置き場所 → 大きさ → スロット)。表に無い置き場所・大きさは、大きさで決まる既存のスロット(SLOTS)。
 *     記事の本文中 article-mid は帯(指示書154)・記事の末尾 article-end は四角(指示書153)・大会結果のデッキの間 events-deck-1〜3 は帯(指示書154)。
 *     カード個別の表の直後 card-top と入賞デッキの直前 card-decks・大会結果の関連大会の直前 events-related は帯(指示書156-A)。
 *     環境分析の本文中 meta-mid・カードリストの本文中 cards-mid は帯で、表だけ先に入れてある(枠は指示書156-B で置く)。
 *   後から作られた枠は window.GCGAds.scan(root) で埋める(大会結果のページの描き直しの後に呼ぶ・指示書154)。
 *     埋めたかどうかは枠ごとの印(data-ad-filled)で決める。scan はページ全体の再実行ガード(__gcgAdsDone)を立ても見もしない。
 *   カード個別と大会結果のページはこのファイルを ads.js?v=4 で読む(指示書156-A)。記事は ?v=3 のまま(指示書156-A の決定。?v= が違っても配られる中身は同じこのファイル)。
 *   店舗・スケジュール・マイページは ?v=1 のまま。このファイルを直したら、読むページの ?v= を上げるかどうかを指示書で決める。
 *   タッチ端末の縮め方(usableWidth)で帯が 320 未満になっても、記事の本文中・大会結果のデッキの間の帯は、枠の本当の幅が 320 以上なら
 *     320x50 を出す(指示書154-R1・BAND_FALLBACK_PLACEMENT)。前提: そのページに「351px 以下で帯を隠す」予約の CSS があること。
 *     指示書156-A で card-top・card-decks・events-related・meta-mid・cards-mid を足した。meta-mid・cards-mid は、156-B で枠を置くページにこの CSS を置くことが前提。
 */
(function () {
  'use strict';

  // 再実行ガード: 同じページで 2 回読まれても枠は 1 つ・push も 1 回
  if (window.__gcgAdsDone) return;
  window.__gcgAdsDone = true;

  // AdSense の広告ユニット(固定サイズ・2026-10-21 作成)。スロット ID は公開される値
  var SLOTS = {
    '728x90': { w: 728, h: 90, slot: '4252104100' },
    '320x50': { w: 320, h: 50, slot: '2939022430' },
    '300x250': { w: 300, h: 250, slot: '1489762280' }
  };

  // 置き場所ごとの広告ユニット(置き場所 → 大きさ → スロット)。指示書153(2026-10-23 作成)・指示書154(2026-10-24 作成)・指示書156-A(2026-10-28 作成)・どれも固定サイズ
  var PLACEMENT_SLOTS = {
    'article-mid': { '728x90': '3057214576', '320x50': '1744132902' },
    'article-end': { '300x250': '2575772345' },
    'events-deck': { '728x90': '8473278509', '320x50': '4414528271' },
    'card-top': { '728x90': '8524412641', '320x50': '3480095836' },
    'card-decks': { '728x90': '8920124774', '320x50': '3849515516' },
    'events-related': { '728x90': '5209864498', '320x50': '8540850826' },
    'meta-mid': { '728x90': '1970291789', '320x50': '4906400136' },
    'cards-mid': { '728x90': '7227769157', '320x50': '3010864535' }
  };
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  // data-slot から表を引く名前(events-deck-1〜 は events-deck で引く)
  function placementKey(p) { return /^events-deck-\d+$/.test(p) ? 'events-deck' : p; }
  // 指示書154-R1: 縮めた幅で帯を畳まない置き場所(ページ側に「351px 以下で帯を隠す」予約の CSS がある所だけ)
  var BAND_FALLBACK_PLACEMENT = {
    'article-mid': true, 'events-deck': true,
    'card-top': true, 'card-decks': true, 'events-related': true, 'meta-mid': true, 'cards-mid': true
  };
  function isBandFallbackPlacement(p) { return has(BAND_FALLBACK_PLACEMENT, placementKey(p)); }

  // 帯の PC 用(728x90)を選ぶ画面幅の下限。ページ側の予約(@media(min-width:820px))と同じ値にすること
  var BAND_WIDE_MIN_VIEWPORT = 820;

  // お気に入りの保存先(js/favorites.js と同じキー・同じ版)
  var FAV_KEY = 'gcg_favorites';
  var FAV_VERSION = 1;

  var CSS =
    // 152-R1(2026-10-23): AdSense の未配信処理(unfill-optimized)が枠の中に 360x360 の iframe を置き、幅 360 の店舗ページで横幅が 557px になった。はみ出しだけ止める(高さは触らない)
    '.ad-slot{overflow:hidden}' +
    '.ad-slot-inner{display:inline-flex;flex-direction:column;align-items:flex-end;gap:4px;position:relative}' +
    '.ad-label{font-size:10px;color:var(--text-muted);border:1px solid var(--border);border-radius:3px;' +
    'padding:1px 6px;font-family:var(--font-mono);line-height:14px}';

  var warned = false;
  function warnOnce(e) {
    if (warned) return;
    warned = true;
    try { console.warn('[ads] ' + (e && e.message ? e.message : e)); } catch (_) { /* 何もしない */ }
  }

  function injectStyle() {
    if (document.getElementById('gcg-ads-style')) return;
    var st = document.createElement('style');
    st.id = 'gcg-ads-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // head の AdSense の読み込みタグから pub ID を読む。読めなければ null
  function readClient() {
    var s = document.querySelector('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]');
    if (!s) return null;
    var m = /[?&]client=(ca-pub-\d{16})(?![0-9])/.exec(s.getAttribute('src') || '');
    return m ? m[1] : null;
  }

  // お気に入り(店舗+大会)の件数。読めない・壊れている → 0(js/favorites.js の read() と同じ読み方)
  function favoriteCount() {
    try {
      var raw = window.localStorage.getItem(FAV_KEY);
      if (!raw) return 0;
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object' || d.version !== FAV_VERSION) return 0;
      var n = 0, i;
      if (Array.isArray(d.stores)) {
        for (i = 0; i < d.stores.length; i++) { if (String(d.stores[i]) !== '') n++; }
      }
      if (Array.isArray(d.events)) {
        for (i = 0; i < d.events.length; i++) { if (isFinite(Number(d.events[i]))) n++; }
      }
      return n;
    } catch (_) {
      return 0;
    }
  }

  // 枠の実際の幅。タッチ端末だけ、横向きで開いたときに縦向きで収まらない大きさを選ばないよう縮める
  function usableWidth(slot) {
    var w = slot.clientWidth;
    var coarse = false;
    try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (_) { coarse = false; }
    if (coarse && window.screen) {
      var shortSide = Math.min(window.screen.width, window.screen.height);
      w = w - Math.max(0, window.innerWidth - shortSide);
    }
    return w;
  }

  // 返り値: 大きさの名前 / null(収まらないので出さない) / undefined(data-kind が不正なので何もしない)
  function pickSize(kind, w) {
    if (kind !== 'band' && kind !== 'rect') return undefined;
    if (!(w > 0)) return null;
    if (kind === 'band') {
      if (w >= 728 && window.innerWidth >= BAND_WIDE_MIN_VIEWPORT) return '728x90';
      if (w >= 320) return '320x50';
      return null;
    }
    return w >= 300 ? '300x250' : null;
  }

  function fill(slot, client, favCount) {
    if (slot.getAttribute('data-ad-filled') === '1') return;
    if (slot.className.indexOf('ad-slot-none') !== -1) return;

    // マイページはお気に入りが 0 件なら空のまま(クラスも付けない=予約の高さは残る)
    var placement = slot.getAttribute('data-slot') || '';
    if (placement.indexOf('mypage-') === 0 && favCount() < 1) return;

    var size = pickSize(slot.getAttribute('data-kind'), usableWidth(slot));
    if (size === undefined) return;
    // 指示書154-R1: 新しい置き場所の帯だけ、タッチ端末で縮めた幅が 320 未満でも、枠の本当の幅が 320 以上なら 320x50 を選ぶ
    // (縮めた幅は 728x90 を選ぶかどうかにだけ使う)。回して枠が 320 未満になる画面幅 351 以下では、ページ側の予約の CSS
    // (@media(max-width:351px){.ad-slot[data-kind="band"]{display:none}})が枠ごと隠すので、はみ出さない。
    // この CSS が無いページの帯には効かせない(ほかの 7 枠は 152 のまま)。BAND_FALLBACK_PLACEMENT に足すときは、そのページにこの CSS を置く。
    if (size === null && slot.getAttribute('data-kind') === 'band' && isBandFallbackPlacement(placement) && slot.clientWidth >= 320) size = '320x50';
    if (size === null) { slot.classList.add('ad-slot-none'); return; }

    var u = SLOTS[size];
    var unitSlot = u.slot;
    // 置き場所が表にあり、その大きさも表にあるときだけ置き場所のスロット(無ければ大きさで決まる既存のスロット)
    var key = placementKey(placement);
    if (has(PLACEMENT_SLOTS, key) && has(PLACEMENT_SLOTS[key], size)) unitSlot = PLACEMENT_SLOTS[key][size];
    slot.innerHTML =
      '<div class="ad-slot-inner"><span class="ad-label">広告</span>' +
      '<ins class="adsbygoogle" style="display:inline-block;width:' + u.w + 'px;height:' + u.h + 'px"' +
      ' data-ad-client="' + client + '" data-ad-slot="' + unitSlot + '"></ins></div>';
    slot.classList.add('ad-size-' + size);
    slot.setAttribute('data-ad-filled', '1');

    // <ins> 1 つにつき 1 回だけ頼む(innerHTML の <script> は動かないのでここから呼ぶ)
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  }

  // root の中の枠をまだ埋めていない物だけ埋める(埋めた枠は fill の最初の判定で飛ばす)
  function run(root) {
    try {
      var slots = (root || document).querySelectorAll('.ad-slot[data-slot]');
      if (!slots.length) return;
      var client = readClient();
      if (!client) { warnOnce('AdSense の読み込みタグ(client=)が見つからないため広告を出しません'); return; }
      injectStyle();
      var cached = null;
      var favCount = function () { if (cached === null) cached = favoriteCount(); return cached; };
      // 読み込み時に 1 回だけ決める(回転・リサイズでは変えない)
      for (var i = 0; i < slots.length; i++) {
        try { fill(slots[i], client, favCount); } catch (e) { warnOnce(e); }
      }
    } catch (e) { warnOnce(e); }
  }

  // 後から作られた枠を埋める入口(指示書154)。root を省くとページ全体
  window.GCGAds = { scan: function (root) { run(root && root.querySelectorAll ? root : document); } };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { run(document); });
  } else {
    run(document);
  }
})();
