@echo off
REM --- Force UTF-8 to prevent Japanese mojibake in log output ---
chcp 65001 >nul
REM ============================================================
REM GCG STATS auto-news daily runner  (target: E:\GCGSTATS)
REM Created: 2026-05-31 (repoint from OneDrive\GCGSimulator\homepage)
REM Schedule: Daily 20:00 JST via Windows Task Scheduler
REM           (Task name: GCG-STATS-auto-news)
REM Time range: previous day 20:01 JST to run time (~current day 20:00 JST)
REM Updated: 2026-07-09 (18:45->20:00; start=prev 20:01; end omitted=up to run time; X-post OFF locked; repoint C:\dev\gcg-meta -> E:\GCGSTATS)
REM Updated: 2026-07-28 (append official card list sync check; task fails when it reports action-required)
REM Logging: auto-news-schtasks.log (append)
REM X-post: DISABLED, locked via --test-mode. To post to X, replace --test-mode with --no-test-mode.
REM ============================================================
cd /d E:\GCGSTATS
REM --- Compute today and yesterday in YYYY-MM-DD via PowerShell ---
for /f %%I in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"') do set TODAY=%%I
for /f %%I in ('powershell -NoProfile -Command "(Get-Date).AddDays(-1).ToString('yyyy-MM-dd')"') do set YESTERDAY=%%I
REM --- Log start ---
echo. >> auto-news-schtasks.log
echo ============================================================ >> auto-news-schtasks.log
echo [%date% %time%] auto-news START: window %YESTERDAY%T20:01 to run-time (target cutoff %TODAY%T20:00) >> auto-news-schtasks.log
REM --- Run auto-news.js. X-post OFF locked via --test-mode. ---
REM     end-time is omitted on purpose: fixing it to exactly 20:00 can hit the X API
REM     "end_time must be >=10s in the past" rule at 20:00 start and fail the whole run.
REM     End therefore = run time (~20:00). To enable X posting, replace --test-mode with --no-test-mode.
node auto-news.js --start-time "%YESTERDAY%T20:01" --no-test-mode >> auto-news-schtasks.log 2>&1
REM --- Log exit code ---
echo [%date% %time%] auto-news END: exit code %ERRORLEVEL% >> auto-news-schtasks.log
echo ============================================================ >> auto-news-schtasks.log
REM --- Schedule fetch (added 2026-07-24, shijisho-50) ---
echo [%date% %time%] fetch-schedule START >> auto-news-schtasks.log
node fetch-schedule.js >> auto-news-schtasks.log 2>&1
set FETCHRC=%ERRORLEVEL%
echo [%date% %time%] fetch-schedule END: exit code %FETCHRC% >> auto-news-schtasks.log
REM ============================================================
REM --- Official card list sync check (added 2026-07-28) ---
REM     Compares the official card list (gundam-gcg.com, 21 categories) against
REM     data\cards_master.json and the generated pages. Read-only; writes nothing
REM     except tmp\cardlist-sync-report.json.
REM     Exit codes: 0=no problem / 1=action required / 2=execution error
REM     Takes about 40 seconds (22 requests at 1.5s intervals, same politeness rule
REM     as the other fetch scripts).
REM     To skip temporarily, comment out the node line below.
REM ============================================================
echo [%date% %time%] cardlist-sync START >> auto-news-schtasks.log
node scripts\check-official-cardlist-sync.js >> auto-news-schtasks.log 2>&1
set SYNCRC=%ERRORLEVEL%
if "%SYNCRC%"=="1" echo [%date% %time%] *** ACTION REQUIRED *** cardlist-sync found unregistered cards or junk pages. See tmp\cardlist-sync-report.json >> auto-news-schtasks.log
if "%SYNCRC%"=="2" echo [%date% %time%] *** ERROR *** cardlist-sync could not run (official site structure change or network failure?). See log above. >> auto-news-schtasks.log
echo [%date% %time%] cardlist-sync END: exit code %SYNCRC% >> auto-news-schtasks.log
echo ============================================================ >> auto-news-schtasks.log
REM --- NTC results ingest (added 2026-07-25, shijisho-51) ---
echo [%date% %time%] ntc-results START >> auto-news-schtasks.log
node fetch-ntc-results.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%] ntc-results FETCH exit %ERRORLEVEL% >> auto-news-schtasks.log
REM   --- deck-log ingest (shijisho 63, added 2026-08-03) ---
REM     fetch-ntc-dashboard.js: pulls the NTC aggregate page plus each shop's winner
REM       decks (RSC, ~57KB per shop). Only shops whose decks are not stored yet.
REM     import-ntc-decks.js: writes those decks into data/events.json (no player names)
REM       and sets the same ntc-new-events.flag, so the regen+deploy chain below picks
REM       them up in the same run. Official-site records win on (date, store) collision.
node fetch-ntc-dashboard.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   fetch-ntc-dashboard exit %ERRORLEVEL% >> auto-news-schtasks.log
node import-ntc-decks.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   import-ntc-decks exit %ERRORLEVEL% >> auto-news-schtasks.log
REM fetch-ntc-results.js creates .sched-run-tmp\ntc-new-events.flag when new events exist; deletes it when zero.
if not exist ".sched-run-tmp\ntc-new-events.flag" goto ntc_skip
echo [%date% %time%] ntc-results: new events found - regen+deploy start >> auto-news-schtasks.log
node scripts\build-series-summary.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   build-series-summary exit %ERRORLEVEL% >> auto-news-schtasks.log
node scripts\build-series-pages.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   build-series-pages exit %ERRORLEVEL% >> auto-news-schtasks.log
node generate-events.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   generate-events exit %ERRORLEVEL% >> auto-news-schtasks.log
node generate.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   generate exit %ERRORLEVEL% >> auto-news-schtasks.log
node generate_cards.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   generate_cards exit %ERRORLEVEL% >> auto-news-schtasks.log
REM   generate_cardlist.js: rebuilds cards.html. The "recent season" flag on each card is
REM   derived from events.json, so it changes whenever new tournament results land.
REM   Added 2026-08-05: it was never in this chain and cards.html was not a deploy candidate,
REM   so the card list kept showing MISSION3 (June) while the August series was running.
node generate_cardlist.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   generate_cardlist exit %ERRORLEVEL% >> auto-news-schtasks.log
REM   generate-report.js --index-only: re-adds reports/*.html URLs to sitemap.xml (no API use).
REM   generate_cards.js rewrites the whole sitemap, so without this step the 41 reports URLs vanish.
REM   Must run before generate-sitemap-extra.js (extra re-adds reports/news/ to keep it consistent).
node generate-report.js --index-only >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   generate-report --index-only exit %ERRORLEVEL% >> auto-news-schtasks.log
node generate-sitemap-extra.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   generate-sitemap-extra exit %ERRORLEVEL% >> auto-news-schtasks.log
node deploy-results.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   deploy-results exit %ERRORLEVEL% >> auto-news-schtasks.log
goto ntc_done
:ntc_skip
echo [%date% %time%] ntc-results: no new events - skip regen/deploy >> auto-news-schtasks.log
:ntc_done
REM ============================================================
REM --- X daily post (added 2026-08-01, shijisho-61) ---
REM     Posts one "card of the day" every night, plus the weekly mover on
REM     Mondays (the weekday check lives inside post-x-daily.js).
REM     Placed right after :ntc_done so it runs on both the :ntc_skip and the
REM     regen/deploy path. Post failures are logged only and are NOT allowed to
REM     change this batch exit code (XPOSTRC is recorded but never returned).
REM     Dry run (safe, posts nothing): node post-x-daily.js --dry-run
REM ============================================================
echo [%date% %time%] post-x-daily START >> auto-news-schtasks.log
node post-x-daily.js >> auto-news-schtasks.log 2>&1
set XPOSTRC=%ERRORLEVEL%
echo [%date% %time%] post-x-daily END: exit code %XPOSTRC% >> auto-news-schtasks.log
echo ============================================================ >> auto-news-schtasks.log
REM ============================================================
REM  NTC official dashboard (shijisho 63 Step 1-N)
REM     Regenerates ntc-official.html from the data fetched earlier in this run and
REM     pushes the 3 changed files via the GitHub API (fetch happens with ntc-results).
REM     All ntc scripts always exit 0; NTCDASHRC is recorded for the log only
REM     and is never returned as this batch's exit code.
REM     Dry run (safe, writes nothing): node fetch-ntc-dashboard.js --dry-run
REM ============================================================
echo [%date% %time%] ntc-dashboard START >> auto-news-schtasks.log
node generate-ntc-dashboard.js >> auto-news-schtasks.log 2>&1
echo [%date% %time%]   generate-ntc-dashboard exit %ERRORLEVEL% >> auto-news-schtasks.log
node deploy-ntc-dashboard.js >> auto-news-schtasks.log 2>&1
set NTCDASHRC=%ERRORLEVEL%
echo [%date% %time%] ntc-dashboard END: exit code %NTCDASHRC% >> auto-news-schtasks.log
echo ============================================================ >> auto-news-schtasks.log
REM ============================================================
REM  Friday preview material (shijisho 68 section 2-B)
REM     Builds the image + post text + booking guide for the Friday 13:00 post,
REM     so it is ready on Thursday night for manual scheduling on X.
REM     Runs only on Thursday (JST); the weekday check lives inside the script.
REM     It never posts to X, never uploads media, and never touches the
REM     post-x-daily state file. Output goes to tmp\x-weekly-pack\friday-<date>\
REM     and is not a push target.
REM     The script always exits 0. FRIPREVRC is recorded for the log only and is
REM     never returned as this batch's exit code (same rule as XPOSTRC/NTCDASHRC).
REM     Dry run (safe, writes nothing): node generate-friday-preview.js --dry-run
REM ============================================================
echo [%date% %time%] friday-preview START >> auto-news-schtasks.log
node generate-friday-preview.js >> auto-news-schtasks.log 2>&1
set FRIPREVRC=%ERRORLEVEL%
echo [%date% %time%] friday-preview END: exit code %FRIPREVRC% >> auto-news-schtasks.log
echo ============================================================ >> auto-news-schtasks.log
REM --- Final exit code ---
REM     When cardlist-sync reports a problem, surface it as a task failure so it is
REM     visible in Task Scheduler history without reading the log every day.
REM     Otherwise keep the previous behaviour (fetch-schedule's exit code).
if not "%SYNCRC%"=="0" exit /b %SYNCRC%
exit /b %FETCHRC%
