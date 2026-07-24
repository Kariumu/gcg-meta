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
echo [%date% %time%] fetch-schedule END: exit code %ERRORLEVEL% >> auto-news-schtasks.log
exit /b %ERRORLEVEL%
