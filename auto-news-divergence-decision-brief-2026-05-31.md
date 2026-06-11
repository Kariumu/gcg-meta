# auto-news.js 乖離：松岡さんへの確認事項（要判断・変更は保留中）

作成: 2026-05-31 JST / Claude（Cowork）
状態: **auto-news.js / regenerate-article.js は変更せず保留**。下記の判断後に再開。
契機: regenerate-article.js 移植の着手前依存解析で、dev と本番(OneDrive)の auto-news.js 乖離が判明。

---

## 1. 事実（読み取り専用で確認済）

- 日次18:00 が実際に動かしているのは **OneDrive `auto-news.js`（2722行・2026-05-26）**。同日リンク検出 `detectSameDayLinkPairs`、コンボ評価、ルール解説の各機能を持つ（2026-05-24〜26 追加）。
- dev リポジトリの **`auto-news.js`（2554行・作業ツリー mtime 5/29／最終コミットは 2026-05-24 `813c228d8`）** は、上記6関数を**0箇所**＝未定義・未エクスポート。
- dev の git 履歴上、`detectSameDayLinkPairs` は**一度も存在したことがない**（`git log -S` が空）。
  → 5/24〜26 の機能は OneDrive 側で開発され、**dev リポジトリへは取り込まれていない**（＝dev が本番より遅れている）。
- regenerate-article.js（OneDrive）は auto-news.js から23名を取り込み、うち `detectSameDayLinkPairs` を**既定経路（フラグ無し）で呼ぶ**。dev では未定義のため、コピーしても**起動時クラッシュ**する。

## 2. 確認したいこと（ご回答ください）

1. **正系はどちらですか？** dev の `auto-news.js`（機能少・遅れている）か、OneDrive の `auto-news.js`（機能多・本番稼働中）か。
2. **5/24〜26 の機能（同日リンク検出・コンボ評価・ルール解説）を、dev 一本化後も使いますか？**
3. dev リポジトリが本番より遅れている理由に心当たりはありますか（OneDrive 側だけで開発が進み dev へ未反映、等）。

## 3. ご回答別の進め方

- **「OneDrive を正・機能維持」の場合**（推奨・本番退行なし）:
  OneDrive `auto-news.js` を dev へ同期 → 6関数が揃う → regenerate-article.js も Stage 1 と同形（バイト一致コピー＋二重確認）で移植可。Stage 4 切替後も機能が落ちない。
- **「dev を正・5/24-26機能を廃止」の場合**:
  その方針を明記 → regenerate-article.js は欠落6関数の使用を除去/ガードして移植。日次は同日リンク検出等なしで運用（機能が減ることを承知の上で）。

## 4. 影響範囲（重要）

- **regenerate-article.js 移植**: 上記判断まで**ブロック**（auto-news.js が揃わないと動かない）。
- **Stage 4（日次の dev 切替）**: 現状の dev `auto-news.js` のまま切替えると、本番にある同日リンク検出・コンボ評価・ルール解説が**日次生成から欠落（機能退行）**。runbook の前提（「dev の auto-news.js が現行・正」）の再確認が必要。
- 一方、**Stage 1（post-processing 移植）・Stage 2（パンくず追加）・Stage 3（dry-run）は完了済**で、本件の影響を受けない（post-processing.js は auto-news.js のこれら機能に依存しない）。

## 5. 現在の保留状態

ご指示どおり、`auto-news.js` と `regenerate-article.js` は**一切変更していません**。判断後、選ばれた方針に沿って（同期 or 改修移植）作業を再開し、いずれも作業者→二次確認の二重確認を通します。
