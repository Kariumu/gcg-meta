@echo off
chcp 65001 >nul
REM ============================================================
REM  rebuild-site.bat  -  GCG STATS site rebuild batch (v7-p2)
REM  Runs the 5 generator scripts in the correct order to avoid order mistakes.
REM  Run "git pull" first. After it finishes, do git add / commit / push.
REM  NOTE: generate_cards.js regenerates the whole sitemap when cards are added.
REM        Run it BEFORE this batch, because this batch owns the last sitemap step.
REM ============================================================
cd /d "%~dp0"

echo [1/5] Rebuilding articles.json - syncs article HTML titles as the source of truth
call node scripts\build-articles-manifest.js || goto :err

echo [2/5] Rebuilding reports/index.html - index title sync + sitemap reports/ update, no API use
call node generate-report.js --index-only || goto :err

echo [3/5] Rebuilding sets/ - adds id anchors to each card
call node generate_preview_sets.js || goto :err

echo [4/5] Rebuilding cards.html - reflects common.js?v=15
call node generate_cardlist.js || goto :err

echo [5/5] Appending series/, sets/, reports/news/ and events/ to sitemap - must be last
call node generate-sitemap-extra.js || goto :err

echo.
echo === DONE: all 5 steps succeeded. Check the diff with git status, then commit and push. ===
exit /b 0

:err
echo.
echo !!! ERROR: the previous step failed. Aborting. Check the log above. !!!
exit /b 1
