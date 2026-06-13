@echo off
chcp 65001 >nul
REM ============================================================
REM  rebuild-site.bat  -  GCG STATS サイト再生成バッチ (v7-p2)
REM  5つの生成スクリプトを正しい順序で実行する(順序ミス防止)。
REM  事前に「git pull」を済ませてから実行。完了後に git add / commit / push。
REM  ※ generate_cards.js(カード追加時の sitemap 全再生成)を回す場合は、
REM    このバッチの「前」に実行すること(本バッチは sitemap 処理の最後を担うため)。
REM ============================================================
cd /d "%~dp0"

echo [1/5] articles.json 再生成 (記事HTMLの ^<title^> を正に同期)
call node scripts\build-articles-manifest.js || goto :err

echo [2/5] reports/index.html 再生成 (一覧 title 同期) + sitemap reports/ 更新 (API不使用)
call node generate-report.js --index-only || goto :err

echo [3/5] sets/ 再生成 (各カードに id アンカー付与)
call node generate_preview_sets.js || goto :err

echo [4/5] cards.html 再生成 (common.js?v=15 反映)
call node generate_cardlist.js || goto :err

echo [5/5] sitemap に series/ / sets/ / reports/news/ を追記 (必ず最後)
call node generate-sitemap-extra.js || goto :err

echo.
echo === 完了: 全5ステップ成功。git status で差分を確認し、コミット/プッシュしてください。 ===
exit /b 0

:err
echo.
echo !!! エラー: 直前のステップが失敗しました。中断します。上のログを確認してください。 !!!
exit /b 1
