/**
 * GCG STATS - NTC順位集計統合モジュール
 *
 * 64名定員のニュータイプチャレンジ大会(results.length >= 16)の順位を
 * 「ベスト16表記」から「ベスト8(各順位2名)表記」に変換する純粋関数。
 *
 * 32名定員大会(results.length === 8)や他大会には一切影響を与えません(R2/R5 充足)。
 *
 * UMD パターンで Node.js / ブラウザ両環境に対応。
 *
 * 詳細仕様: reports/investigation-ntc-rank-consolidation-2026-05-18.md
 *
 * 作成: 2026-05-18 (指示書 NTC順位集計統合 第2セッション)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    // CommonJS / Node.js
    module.exports = factory();
  } else {
    // Browser global
    root.NtcRankConsolidator = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // NTC のシリーズID。将来 NTC の新シリーズが追加された場合はここに追記する。
  // TODO: NTC 他シリーズ(MISSION3 以降)追加時はこの配列に新 series_id を追加すること
  var NTC_SERIES_IDS = ['6226'];

  /**
   * イベントが NTC シリーズか判定する
   */
  function isTargetSeries(event) {
    return !!event && NTC_SERIES_IDS.indexOf(event.series_id) >= 0;
  }

  /**
   * イベントが本変換の対象(64名定員相当)か判定する
   * 条件: NTCシリーズ かつ results が配列 かつ length が16以上
   *   - results.length === 16: 64名定員(松岡さん回答により8件=32名・16件=64名)
   *   - results.length === 17: 異常データ1件(rank=[..,16,16])、変換対象に含める(新8位が3名になることを許容)
   *   - results.length === 8 や 9: 対象外(R2 厳守、32名定員には一切手を加えない)
   */
  function isTargetEvent(event) {
    return isTargetSeries(event)
      && Array.isArray(event.results)
      && event.results.length >= 16;
  }

  /**
   * イベントの順位を「ベスト8(各順位2名)」表記に変換する純粋関数
   *
   * 元イベントオブジェクトは破壊せず、新オブジェクトを返す(ロールバック容易性のため)。
   *
   * @param {Object} event - 元イベントオブジェクト
   * @param {Object} [options] - オプション
   * @param {Function} [options.getDeckColors] - deck 配列を受け取り色配列を返す関数。
   *   提供時: top4_colors を新rank=1〜8 すべて分(最大16件)に完全再生成する(サーバ側集計向け)。
   *   未提供時: top4_colors は既存4件の rank のみ変換(クライアント側表示向け、軽量モード)。
   * @returns {Object} 変換後の新イベントオブジェクト。対象外の場合は元 event をそのまま返す。
   */
  function consolidateNtcRank(event, options) {
    if (!isTargetEvent(event)) {
      return event;
    }
    options = options || {};
    var getDeckColors = options.getDeckColors;

    // 段階A: results 各要素の rank を Math.ceil(rank/2) で変換
    var newResults = event.results.map(function (r) {
      return Object.assign({}, r, { rank: Math.ceil(r.rank / 2) });
    });

    // 段階B: top4_colors の処理
    var newTopColors;
    if (typeof getDeckColors === 'function') {
      // 完全再生成モード(サーバ側集計向け、generate-report.js 等)
      // 新rank=1〜8 の最大16件(新8位が3名の場合は17件)の色情報を deck から再構築する
      newTopColors = [];
      for (var i = 0; i < newResults.length; i++) {
        var r = newResults[i];
        if (!r.deck || !Array.isArray(r.deck) || r.deck.length === 0) continue;
        var colors = getDeckColors(r.deck) || [];
        if (colors.length === 0) continue;
        newTopColors.push({
          rank: r.rank,
          colors: colors,
          type_key: colors.join('+')
        });
      }
    } else {
      // 軽量モード(クライアント側表示向け、events.html / index.html / store.html)
      // 既存 top4_colors(旧rank=1〜4 の4件)の rank だけを Math.ceil で変換する。
      // これにより新rank=1(優勝、2名)+新rank=2(準優勝、2名)= 4件 となり、
      // クライアント側の「TOP4表示」はそのまま新表記で正しく動作する。
      newTopColors = (event.top4_colors || []).map(function (t) {
        return Object.assign({}, t, { rank: Math.ceil(t.rank / 2) });
      });
    }

    return Object.assign({}, event, {
      results: newResults,
      top4_colors: newTopColors
    });
  }

  return {
    consolidateNtcRank: consolidateNtcRank,
    isTargetEvent: isTargetEvent,
    isTargetSeries: isTargetSeries,
    NTC_SERIES_IDS: NTC_SERIES_IDS
  };
}));
