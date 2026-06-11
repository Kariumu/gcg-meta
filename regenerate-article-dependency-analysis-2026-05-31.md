# regenerate-article.js 依存解析（移植着手前）

実施日: 2026-05-31 JST
作業者: Claude（Cowork・本セッション）
目的: 移植前に「regenerate-article.js は独立スクリプトか」を確定（松岡さん／二次確認者の依頼）

## 結論（先に要点）

**regenerate-article.js は独立スクリプトではなく、このままでは dev で動きません。** byte-copy 単体での移植は不可。根因は **dev auto-news.js が OneDrive 版（本番）から乖離している**ことにあり、これは regenerate-article.js だけでなく Stage 4（日次の dev 切替）の機能退行リスクにも直結します。

## 1. regenerate-article.js の require 依存（OneDrive 原本、457行）

- `require('dotenv')` ＋ `../.env` 読込（`:26`）→ dev は Stage 0-A 済・`.env` 存在 ✓
- **`const autoNews = require(path.resolve(__dirname,'..','auto-news.js'))`（`:32`、トップレベル）** → dev ルート auto-news.js を require。
- `require('./post-processing')`（`:251`、関数内）→ dev/scripts/post-processing.js ✓（Stage 1 済）

dev ルート auto-news.js は `require.main===module` ガードあり（`:2547`）で require 時に本処理は走らない ✓、`module.exports`（`:2515`）で関数公開済 ✓。ここまでは問題なし。

## 2. 致命的な不一致：分割代入する名前が dev に無い

regenerate-article.js は `const { … } = autoNews;`（`:33-59`）で23名を取り込む。うち **6名が dev auto-news.js に存在しない**（定義0・エクスポート0）。OneDrive auto-news.js には在る。

| 関数 | dev auto-news.js | OneDrive auto-news.js | regenerate での使用 |
|------|------------------|------------------------|----------------------|
| `detectSameDayLinkPairs` | **無し(0)** | 在り(2) | **既定経路 `:186`（フラグ無し）** ★ |
| `findComboCandidates` | 無し(0) | 在り(2) | `--enable-combo-eval` 時のみ（既定無効 `:291`） |
| `evaluateComboCandidates` | 無し(0) | 在り(2) | 同上 |
| `writeComboCandidatesReport` | 無し(0) | 在り(2) | 同上 |
| `evaluateRuleClarifications` | 無し(0) | 在り(2) | `--enable-rule-clarification` 時のみ（既定無効 `:357`） |
| `writeRuleClarificationsReport` | 無し(0) | 在り(2) | 同上 |

→ **`detectSameDayLinkPairs` は既定経路（`:186`）で無条件に呼ばれる**ため、dev では `undefined(...)` で **TypeError → 即クラッシュ**。残り5名は任意フラグ経路のみなので、フラグ未使用なら呼ばれないが、いずれにせよ dev では未提供。

## 3. 根因：dev auto-news.js は OneDrive 版から乖離（168行少ない）

| | 行数 | mtime | 5/24〜26 機能(同日リンク/コンボ評価/ルール解説) |
|--|------|-------|----------------------------------------------|
| dev `auto-news.js` | 2554 | 2026-05-29 | **無し** |
| OneDrive `auto-news.js` | 2722 | 2026-05-26 | 在り |

dev は mtime が新しいが**内容は OneDrive より少なく**、2026-05-24〜26 に OneDrive へ追加された機能群を含んでいない＝**別系統で乖離**している（dev が本番より遅れている）。

## 4. 影響（regenerate-article.js を超える）

- **regenerate-article.js**: 既定経路で `detectSameDayLinkPairs` を呼ぶため、dev へ byte-copy しても起動時クラッシュ。単体移植不可。
- **Stage 4（日次の dev 切替）**: 日次が現在動かしているのは OneDrive auto-news.js（全機能）。dev auto-news.js に切替えると、**同日リンク検出・コンボ評価・ルール解説が日次生成から欠落（機能退行）**する（クラッシュではないが本番機能が減る）。
- これは runbook の前提（「dev ルート auto-news.js が現行・正」＝Stage 0-B）を揺るがす。**実際の本番現行は OneDrive auto-news.js（2722行）で、dev のものは遅れた別版**である可能性が高い。

## 5. 推奨（要 松岡さん判断）

1. **regenerate-article.js の移植は保留**（auto-news.js 側が整うまで動かない）。
2. 先に **auto-news.js の乖離を解消**：どちらを正とするか松岡さんが確定。本番退行を避けるなら、**OneDrive auto-news.js（全機能）を dev へ同期**してから移植を続けるのが自然。dev 版を正とする（=5/24-26機能を意図的に捨てる）なら、その判断を明記。
3. auto-news.js を OneDrive 版に揃えれば、6関数が揃い regenerate-article.js も素直に移植できる（その後 Stage 1 と同形でバイト一致コピー＋二重確認）。

## 6. 事実確認の出典

- regenerate-article.js: `:26,:32,:33-59,:186,:251,:277,:291,:344,:357`（OneDrive）
- dev auto-news.js: `:2515`(exports), `:2547`(require.main), 6関数の grep=0
- OneDrive auto-news.js: 6関数の grep=各2、2722行
