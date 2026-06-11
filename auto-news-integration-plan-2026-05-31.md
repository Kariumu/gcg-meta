# auto-news.js 整合 — 差分解析結果と整合計画【A案・範囲拡大】

作成: 2026-05-31 JST / Claude（Cowork）
方針: 松岡さん確定の **A案（OneDrive を正系、5/24〜26機能を維持して dev へ整合）**。
状態: **まだ変更していません（diff 解析のみ）。** 実行は本計画の最終確認後。

---

## 0. 結論（先に要点）

整合は「OneDrive を dev に上書きコピー」では**不可**。次の2点が判明:

1. **保全すべき dev 固有編集が在る**（＝ユーザー懸念の唯一の実リスクが現実に存在）: **2026-05-28 のカード記事 class 化リファクタ**。`auto-news.js` の `buildCardBlockHtml`（インラインstyle→`.news-card-*` クラス）＋ `css/style.css` の16クラス。OneDrive 側は css も**0クラス**（インラインstyleのまま）。
2. **乖離は recognition-core.js にも及ぶ**（auto-news.js 単体ではない）。dev の recognition-core.js は OneDrive より**約1189行少なく**、`sameDayLinkPairs` 対応も無い。

→ 整合は **(a) recognition-core.js の全面同期 ＋ (b) auto-news.js のマージ** になる。

## 1. 依頼の diff 2本の結果

- **diff #2（dev 作業ツリー vs 5/24コミット `813c228d8`、改行正規化）**: 全行差分は CRLF ドリフト。正規化後の**実編集は1箇所＝`buildCardBlockHtml` の class 化（5/28）**。→「dev の5/29に保全すべき実編集があるか」の答えは **YES（class化）**。
- **diff #1（dev vs OneDrive、改行正規化）**: OneDrive固有 201行（6関数＋`sameDayLinkPairs` 統合）、dev固有 33行（class化のHTML生成＋旧呼び出し署名）。**OneDrive は dev の上位集合ではない**。

## 2. 範囲スキャン（主要パイプライン、改行正規化）

| ファイル | dev行 | OneDrive行 | OneDrive固有 | dev固有 | 判定 |
|---|---|---|---|---|---|
| auto-news.js | 2554 | 2722 | 201 | 33 | **マージ**（双方に固有差分） |
| scripts/shared/recognition-core.js | 1096 | 2285 | **1195** | 6 | **全面同期**（dev が大幅遅れ） |
| scripts/manual-card-news.js | 1059 | 1059 | 0 | 0 | 同一（対応不要） |
| scripts/post-processing.js | 440 | 408 | 0 | 32 | dev 先行（Stage1+2、維持） |
| git-push.js | 186 | 186 | 0 | 0 | 同一（対応不要） |
| scripts/batch-recognize.js | 533 | 533 | 0 | 0 | 同一（対応不要） |

- recognition-core.js の dev固有6行＝`generateIntroText`(3引数)/`generateCardAnalyses`(2引数) の**旧署名**等。OneDrive に更新版（`sameDayLinkPairs=[]` 付き）があり、**保全不要**。
- auto-news.js の dev固有33行のうち、実質の保全対象は class 化ブロック。残る `generateIntroText/Analyses` 呼び出し2行は OneDrive 側の `sameDayLinkPairs` 付き版を採用する（＝機能側、dev版は破棄でよい）。

## 3. 保全リスト / 取得リスト

- **保全（dev 側を残す）**: ① `auto-news.js` の `buildCardBlockHtml` class版、② `css/style.css` の `.news-card-*` 16クラス（OneDriveは0）、③ `scripts/post-processing.js`（Stage1+2 のパンくず）。
- **取得（OneDrive から得る）**: ① `recognition-core.js` 全面（+1195行、`sameDayLinkPairs` ほか）、② `auto-news.js` の6関数（`detectSameDayLinkPairs` 他）＋ `sameDayLinkPairs` 統合呼び出し。

## 4. 整合計画（各段階で 作業者→二次確認）

1. **recognition-core.js 全面同期**: OneDrive→dev へバイト移植（dev固有なし＝Stage 1 と同形）。差分ゼロ照合＋require/パス検証。
2. **auto-news.js マージ**: OneDrive 版（2722行）を基底にし、**`buildCardBlockHtml` のみ dev の class版へ差し替え**。`generateIntroText/Analyses` 呼び出しは OneDrive の `sameDayLinkPairs` 付き版を採用。結果を node --check＋（隔離）レンダリングで検証、`detectSameDayLinkPairs` 等が定義・エクスポートされていること、Phase 3 が dev/scripts/post-processing.js を呼ぶこと、`require.main` ガード健在を確認。
3. **css/style.css**: dev を維持（`.news-card-*` を残す。**上書きしない**）。
4. **post-processing.js**: 現状維持（Stage1+2）。
5. **regenerate-article.js 移植**: 上記1・2で依存が揃った後に Stage 1 と同形で移植。

## 5. 留意（要 松岡さん共有・確認）

- 整合範囲が auto-news.js 単体でなく **recognition-core.js（+約1189行）にも及ぶ**。中核パイプラインの大きめの変更になる点を共有。
- 移行ウィンドウ中の **OneDrive 凍結**（切替まで OneDrive 側を編集しない）が再乖離防止に必要。
- 本計画は**未実行**。中核ファイルの大規模変更のため、方針の最終確認後に、段階ごと二重確認で実施する。
