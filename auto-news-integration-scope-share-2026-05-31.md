# 松岡さんへ — auto-news.js 整合の「範囲拡大」共有（A案の補足・要承認）

作成: 2026-05-31 JST / Claude（Cowork）
状態: **未実行**（diff 解析のみ）。下記ご承認後に段階実施します。
詳細: `auto-news-integration-plan-2026-05-31.md`（同フォルダ）

---

## なぜ共有するか

A案（OneDrive を正系・5/24〜26機能を維持して dev へ整合）で実差分を取ったところ、**整合範囲が当初想定（auto-news.js 1枚の同期）より広い**ことが判明しました。中核パイプラインの大きめの変更になるため、実行前に共有します。

## 判明事項（事実）

1. **recognition-core.js も大きく乖離**: dev 1096行 / OneDrive 2285行（約 **1189行 dev が遅れ**、`sameDayLinkPairs` 未対応）。auto-news.js は recognition-core.js に依存するので、**auto-news.js だけ同期しても動きません**。→ recognition-core.js も OneDrive→dev へ全面同期が必要。
2. **dev に固有の 2026-05-28 編集あり（保全対象）**: カード記事の **class 化**（`auto-news.js` の `buildCardBlockHtml` ＋ `css/style.css` の `.news-card-*` 16クラス）。OneDrive 側は未対応（インラインstyle・css 0クラス）。→ 単純上書きでは失われるため**マージで保全**。
3. **影響なしのファイル**: `manual-card-news.js` / `git-push.js` / `scripts/batch-recognize.js` は dev=OneDrive で**同一**。`post-processing.js` は Stage 1+2 済で**維持**。

## 整合方針（ご承認いただきたい内容）

- A. `recognition-core.js`: OneDrive→dev へ**全面同期**（dev 固有編集なし＝安全）。
- B. `auto-news.js`: OneDrive 版を基底に、**dev の class 版 `buildCardBlockHtml` のみ再適用**（マージ）。5/24〜26機能（`detectSameDayLinkPairs` 他）は OneDrive から取得。
- C. `css/style.css`・`post-processing.js`: **dev を維持**（上書きしない）。
- D. 移行ウィンドウ中は OneDrive 側 `auto-news.js` / `recognition-core.js` を**凍結**（再乖離防止）。

## 確認事項（ご回答ください）

1. 上記 A〜C のマージ方針で進めてよいか（中核パイプラインの大きめ変更）。
2. 5/28 の class 化（dev 固有）は**保全**でよいか（＝最新の styling を採用）。
3. 移行完了まで OneDrive 側の該当2ファイルを**凍結**できるか。

承認後、**段階ごと（recognition-core 同期→二次確認→auto-news マージ→二次確認）**に二重確認つきで実施します。現時点では一切変更していません。
