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
 * NTC 判定は以下の優先順位:
 *   1) options.isNtcType(series_id) が提供されていれば使用
 *      (series.json の type='ntc' を参照する関数を呼び出し側で構築)
 *   2) 未提供時は NTC_SERIES_IDS のハードコード配列にフォールバック
 *
 * 詳細仕様: reports/investigation-ntc-rank-consolidation-2026-05-18.md
 *
 * 作成: 2026-05-18
 * 更新: 2026-05-19 (type ベース判定追加、MISSION3 取りこぼし対応)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NtcRankConsolidator = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // NTC の既知シリーズID(フォールバック用ハードコードリスト)。
  // 通常は series.json の type='ntc' で判定するが、呼び出し側が isNtcType を渡せない場合の保険。
  // 新シリーズ追加時はここにも追記しておくと、series.json 未ロードの状況でも判定できる。
  var NTC_SERIES_IDS = ['6226', '6776', '6791'];

  function isTargetSeries(event, options) {
    if (!event || event.series_id == null) return false;
    options = options || {};
    if (typeof options.isNtcType === 'function') {
      try {
        if (options.isNtcType(event.series_id)) return true;
      } catch (_) { /* フェイルセーフ */ }
    }
    return NTC_SERIES_IDS.indexOf(String(event.series_id)) >= 0;
  }

  function isTargetEvent(event, options) {
    return isTargetSeries(event, options)
      && Array.isArray(event.results)
      && event.results.length >= 16;
  }

  function consolidateNtcRank(event, options) {
    if (!isTargetEvent(event, options)) {
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
      // 完全再生成モード(サーバ側集計向け)
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
      // 軽量モード(クライアント側表示向け)
      // 既存 top4_colors(旧rank=1〜4 の4件)の rank だけを Math.ceil で変換
      newTopColors = (event.top4_colors || []).map(function (t) {
        return Object.assign({}, t, { rank: Math.ceil(t.rank / 2) });
      });
    }

    return Object.assign({}, event, {
      results: newResults,
      top4_colors: newTopColors
    });
  }

  function makeIsNtcTypeFromSeriesMap(seriesMap) {
    return function (seriesId) {
      if (seriesId == null || !seriesMap) return false;
      var entry = seriesMap[String(seriesId)];
      return !!(entry && entry.type === 'ntc');
    };
  }

  return {
    consolidateNtcRank: consolidateNtcRank,
    isTargetEvent: isTargetEvent,
    isTargetSeries: isTargetSeries,
    makeIsNtcTypeFromSeriesMap: makeIsNtcTypeFromSeriesMap,
    NTC_SERIES_IDS: NTC_SERIES_IDS
  };
}));
