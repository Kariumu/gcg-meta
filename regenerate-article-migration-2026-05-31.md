# regenerate-article.js 移植 — 結果（二次確認用）

実施日: 2026-05-31 JST / 作業者: Claude（Cowork）/ 二次確認: 松岡さん側（ホスト Read）
前提: recognition-core 同期済・auto-news.js マージ済（依存充足）。Stage 1 と同形でバイト移植。

---

## 1. 移植（バイト一致）

- OneDrive `scripts/regenerate-article.js`（19,214B / 457行 / md5 `8c750fde826f271dd0fa778f56b14cf5`）を dev `scripts/regenerate-article.js` へバイト移植。dev は新規（既存なし）。
- 移植後: **dev = 19,214B / 457行 / md5 `8c750fde…` → 完全一致**。

## 2. 自己検証（静的）

- **分割代入の全名解決**: regenerate が auto-news から取り込む **21名すべてが dev exports に存在**（未解決0）。
  - 当初問題だった6関数（`detectSameDayLinkPairs` / `findComboCandidates` / `evaluateComboCandidates` / `writeComboCandidatesReport` / `evaluateRuleClarifications` / `writeRuleClarificationsReport`）は **recognition-core で定義 → auto-news.js が `...require(recognition-core)` で re-export** により取得。→ 既定経路 `detectSameDayLinkPairs(cardInfoList)`（`:186`）の undefined クラッシュは解消見込み。
- **require 依存が dev で全解決**: `dotenv`(`:26`)＋`../.env`、`fs`/`path`、`../auto-news.js`(`:32`＝マージ済)、`./post-processing`(`:251`＝Stage1+2移植済)。
- **ファイル完全・エントリ正**: 末尾 `main().catch(...)`（`:453-457`）で完結。regenerate は**直接実行のCLIスクリプト**（他から require されない）ため、main() 無条件呼びが正しい（auto-news.js 側の require.main ガードとは役割が別）。
- **依存パッケージ**: dev `node_modules` に `sharp`（@img/**sharp-win32-x64**）・`dotenv` あり（松岡さんの 0-A 導入が dev に反映済）。

## 3. 動的 dry-run は「ホスト（Windows）」で実施が必要

- 本セッションの sandbox は **Linux x86_64**。dev の sharp は **win32-x64 バイナリ**のため、sandbox で `require('sharp')` は失敗（`Could not load the "sharp" module using the linux-x64 runtime` を実測）。
- → sharp に依存する auto-news.js / recognition-core.js / regenerate-article.js は **sandbox では実行不可**。dry-run はホスト（Windows）で行う。
- **推奨（松岡さん・ホスト）**: `node scripts/regenerate-article.js --date <日付> --dry-run` を1回。
  - 確認点: 既定経路の `detectSameDayLinkPairs`（:186）で undefined クラッシュしないこと（依存充足の実行確認）。これは API 呼び出しより前なので早期に確認可能。
  - 注意: dry-run は **push しない**が、記事再生成のため `generateIntroText`/`generateCardAnalyses`（Claude API）を呼ぶ＝**少額の API 課金**が発生し得る。クラッシュ有無だけ見るなら「同日リンク組合せ検出」ログ到達時点で中断可。

## 4. 二次確認のお願い（ホスト Read、CRLF正規化/md5で比較）

- dev `scripts/regenerate-article.js` が OneDrive 原本とバイト一致（19,214B・md5 `8c750fde…`）。
- 分割代入21名が dev で解決可能（特に6関数が recognition-core 経由で取得）。
- ファイル完全（`main().catch` 末尾まで・切断なし）。

---

## 5. dev 側コード作業の完了状況

| 対象 | 状態 |
|---|---|
| post-processing.js | 移植＋パンくず＋①修正（Stage1+2）✅ |
| recognition-core.js | 全面同期（OneDrive→dev）✅ |
| auto-news.js | 3-wayマージ（OneDrive基底＋dev class buildCardBlockHtml）✅ |
| regenerate-article.js | バイト移植 ✅（本書） |
| css/style.css | dev 維持（機能的上位・マージ不要）✅ |
| manual-card-news.js / git-push.js | 同一（対応不要）✅ |

→ **Cowork のコード整合作業は完了**。残るは Stage 4 切替（松岡さん）と Stage 5 監視。

## 6. 残り

- **Stage 4 切替（松岡さん・PowerShell）**: `.env`（GITHUB_TOKEN 等）確認、スケジューラ実行対象を dev 直下 `auto-news.js` へ（homepage 旧版を指さない）、OneDrive 旧タスク無効化（＝凍結を恒久停止へ）。事前にホストで auto-news.js / regenerate-article.js の `--dry-run` 確認を推奨。
- **Stage 5 監視**: 次の新カード公開日に、本番で「記事＋パンくず＋同日リンク＋カードページ生成＋push」が出るか。既存42ページは上書きされないため、パンくず等は**新規カードのページから**反映。
