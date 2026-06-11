# Stage 4 事前: 起動バッチのフラグ一致確認 & dev 切替手順（松岡さん向け）

作成: 2026-05-31 JST / Claude（Cowork）/ 目的: 切替時の**挙動差防止**（現行 OneDrive タスクと同一挙動で dev へ）

> バッチ作成・スケジューラ登録・OneDrive 旧タスク無効化は松岡さんの領域。本書は read-only 比較に基づく**推奨内容の提示**です。

---

## 1. 現行（OneDrive）日次バッチの実体

`C:\Users\kariu\OneDrive\GCGSimulator\homepage\run-auto-news-daily.bat`（タスク名 `GCG-STATS-auto-news`、毎日18:00 JST）の核心:

```bat
chcp 65001 >nul
cd /d C:\Users\kariu\OneDrive\GCGSimulator\homepage
REM TODAY / YESTERDAY を PowerShell で yyyy-MM-dd 算出
node auto-news.js --start-time "%YESTERDAY%T17:40" --end-time "%TODAY%T17:39" --no-test-mode >> auto-news-schtasks.log 2>&1
```

フラグの意味（＝そのまま dev でも維持すべき挙動）:

| 要素 | 値 | 意味 |
|---|---|---|
| 起動 | `node auto-news.js` | ルート版 auto-news.js |
| `--start-time` | `<前日>T17:40` | 取得ウィンドウ開始（明示指定）|
| `--end-time` | `<当日>T17:39` | 取得ウィンドウ終了。※明示指定時 `last-check.json` は更新しない（auto-news.js 設計）|
| `--no-test-mode` | — | **X 投稿 ON（本番）** |
| （無し）`--enable-survey` | — | アンケート投稿は**しない**（既定無効）|
| （無し）`--enable-combo-eval` | — | コンボ評価 Phase 4 は**走らない**（既定無効、API課金なし）|
| （無し）`--enable-rule-clarification` | — | ルール解説 Phase 5 は**走らない**（既定無効、API課金なし）|
| ログ | `auto-news-schtasks.log` 追記 | stdout+stderr |

補足（重要）: `detectSameDayLinkPairs`（同日リンク）は**フラグ不要の既定経路**（auto-news.js main `:2352`）なので、日次で動く＝今回復活させた機能。コンボ評価・ルール解説は opt-in のままなので日次の挙動・コストは現行と変わりません。

## 2. dev 側に推奨するバッチ（変更は **cd 先のみ**）

`C:\dev\gcg-meta\run-auto-news-daily.bat` として、cd 先を dev リポジトリ直下にする以外は**完全に同一**にしてください:

```bat
@echo off
chcp 65001 >nul
cd /d C:\dev\gcg-meta
for /f %%I in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"') do set TODAY=%%I
for /f %%I in ('powershell -NoProfile -Command "(Get-Date).AddDays(-1).ToString('yyyy-MM-dd')"') do set YESTERDAY=%%I
echo. >> auto-news-schtasks.log
echo [%date% %time%] auto-news START (dev): window %YESTERDAY%T17:40 to %TODAY%T17:39 >> auto-news-schtasks.log
node auto-news.js --start-time "%YESTERDAY%T17:40" --end-time "%TODAY%T17:39" --no-test-mode >> auto-news-schtasks.log 2>&1
echo [%date% %time%] auto-news END: exit code %ERRORLEVEL% >> auto-news-schtasks.log
exit /b %ERRORLEVEL%
```

**唯一の差分**: `cd /d C:\Users\kariu\OneDrive\GCGSimulator\homepage` → `cd /d C:\dev\gcg-meta`。フラグ・ウィンドウ・X投稿ON・ログ運用は同一。

### なぜ cd 先が dev 直下なのか（致命的注意）
- 整合した auto-news.js は **dev リポジトリ直下**（`C:\dev\gcg-meta\auto-news.js`）。`cd C:\dev\gcg-meta` で `node auto-news.js` を起動すれば、`__dirname` 基準のパス（`.env`／`scripts/`／`cards/`／`images/`）がすべて dev 直下に解決。
- **`C:\dev\gcg-meta\homepage\auto-news.js`（旧版）を絶対に指さない**こと（Phase 3 なし・機能欠落の旧版）。

## 3. 切替前ゲート（松岡さん・ホスト Windows）

1. **ホスト dry-run**（Linux/私では sharp 不可のため必須・松岡さん限定）:
   - `cd /d C:\dev\gcg-meta && node auto-news.js --dry-run`
   - `cd /d C:\dev\gcg-meta && node scripts\regenerate-article.js --date <既存日付> --dry-run`
   - 確認: (a) `require('sharp')` が通る、(b) 同日リンク検出ログ等まで到達しクラッシュしない、(c) push/X 投稿が走らない（dry-run ガード）。
2. **dev/.env のキー確認**: auto-news.js は main 冒頭で X API キー不足時 `process.exit(1)`。`X_API_KEY`／`X_API_SECRET`／`X_API_ACCESS_TOKEN`／`X_API_ACCESS_TOKEN_SECRET`／`GITHUB_TOKEN`／`ANTHROPIC_API_KEY`／`GOOGLE_CLOUD_API_KEY` が `C:\dev\gcg-meta\.env` に揃っているか。（秘匿情報のため Cowork は中身を読みません）

## 4. 切替実行（松岡さん）

- スケジューラ `GCG-STATS-auto-news` の実行対象を dev バッチへ（または既存バッチの cd を dev へ）。
- **OneDrive 旧タスク無効化と dev 新タスク有効化を同時に**（二重起動も空白も作らない＝二重push防止／凍結の恒久停止化）。
- タイミング: ゲート通過後、次の18:00を**人が監視できる時間帯**に。未了なら無理せず1日ずらす。

## 5. Stage 5 合否（2段階）
- 技術的成功: 切替後の次の18:00で 記事・X投稿・Phase 3・push が完走。
- 機能的成功: 次に新カードが公開された日に、そのページへパンくず（`?set=`）＋記事に同日リンクが反映（新カードが出ない日は全既存スキップでパンくず非観測）。
