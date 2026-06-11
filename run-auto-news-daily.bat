@echo off
REM --- Force UTF-8 to prevent Japanese mojibake in log output ---
chcp 65001 >nul
REM ============================================================
REM GCG STATS auto-news daily runner  (unified target: C:\dev\gcg-meta)
REM Created: 2026-05-31 (repoint from OneDrive\GCGSimulator\homepage)
REM Schedule: Daily 18:45 JST via Windows Task Scheduler
REM           (Task name: GCG-STATS-auto-news)
REM Time range: previous day 18:40 JST to current day 18:39 JST
REM Updated: 2026-06-09 (run 18:00->18:45; window +60min to capture ~18:30 card reveals)
REM Logging: auto-news-schtasks.log (append)
REM X-post: enabled via --no-test-mode flag
REM ============================================================
cd /d C:\dev\gcg-meta
REM --- Compute today and yesterday in YYYY-MM-DD via PowerShell ---
for /f %%I in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"') do set TODAY=%%I
for /f %%I in ('powershell -NoProfile -Command "(Get-Date).AddDays(-1).ToString('yyyy-MM-dd')"') do set YESTERDAY=%%I
REM --- Log start ---
echo. >> auto-news-schtasks.log
echo ============================================================ >> auto-news-schtasks.log
echo [%date% %time%] auto-news START: window %YESTERDAY%T18:40 to %TODAY%T18:39 >> auto-news-schtasks.log
REM --- Run auto-news.js (X-post forced ON via --no-test-mode) ---
node auto-news.js --start-time "%YESTERDAY%T18:40" --end-time "%TODAY%T18:39" --no-test-mode >> auto-news-schtasks.log 2>&1
REM --- Log exit code ---
echo [%date% %time%] auto-news END: exit code %ERRORLEVEL% >> auto-news-schtasks.log
echo ============================================================ >> auto-news-schtasks.log
exit /b %ERRORLEVEL%
