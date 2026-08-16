@echo off
REM ============================================================
REM  run-ntc-flash.bat  (2026-08-14 / shijisho 72)
REM  NTC winning-deck flash: post TOP4 share images to X.
REM
REM  Runs every 15 minutes, phase-locked to :00 / :15 / :30 / :45.
REM  Registered through wscript.exe + run-hidden.vbs so NO console
REM  window ever appears (matsuoka-san: "a window popping up while
REM  I am gaming is a problem"). Therefore this file must contain
REM  NOTHING interactive: no pause, no choice, no set /p, no start.
REM  The only place to watch it is the shared log below.
REM
REM  Task registration (run once, by matsuoka-san):
REM    schtasks /Create /TN "GCG-STATS-ntc-flash"
REM      /TR "C:\Windows\System32\wscript.exe //B //Nologo
REM           E:\GCGSTATS\run-hidden.vbs E:\GCGSTATS\run-ntc-flash.bat"
REM      /SC MINUTE /MO 15 /ST 09:00
REM
REM  Guards, all decided by "node post-x-ntc-flash.js --preflight",
REM  which reports the outcome through its exit code and writes exactly
REM  one [ntc-flash] line to the log saying which one it was:
REM     0  go ahead (lock taken)
REM    13  outside the working window 09:00-23:30
REM    14  inside the always-skip window 19:20-20:40
REM    10  run-ntc-collect is running (its lock is fresh)
REM    11  another tick of this task is still running
REM    12  internal error (could not create the lock)
REM  Anything other than 0 means "do nothing this tick".
REM
REM  Why the window test is not done here: %TIME% / %DATE% are
REM  locale dependent (leading space for single digit hours, and
REM  12-hour clocks on some locales), so comparing them in batch
REM  can silently drop afternoon ticks. All time logic lives in
REM  one tested place instead - windowState() in the node script.
REM
REM  Exit code: always 0, so a failure never shows up as a Task
REM  Scheduler error. The node exit code is recorded in NTCFLASHRC
REM  and written to the log only.
REM ============================================================
chcp 65001 >nul
cd /d E:\GCGSTATS
if errorlevel 1 goto no_root

set NTCFLASHRC=0
set FLASHLOG=auto-news-schtasks.log

node post-x-ntc-flash.js --preflight >> %FLASHLOG% 2>&1
set FLASHPRE=%ERRORLEVEL%
if not "%FLASHPRE%"=="0" goto no_run

echo ============================================================ >> %FLASHLOG%
echo [%date% %time%] [ntc-flash] START >> %FLASHLOG%

node post-x-ntc-flash.js >> %FLASHLOG% 2>&1
set NTCFLASHRC=%ERRORLEVEL%
echo [%date% %time%] [ntc-flash] post-x-ntc-flash exit %NTCFLASHRC% >> %FLASHLOG%

node post-x-ntc-flash.js --release >> %FLASHLOG% 2>&1
echo [%date% %time%] [ntc-flash] END >> %FLASHLOG%
exit /b 0

:no_run
REM preflight already wrote one [ntc-flash] line saying why, so nothing is
REM echoed here. That single line is the freshness marker this task is
REM watched by (see shijisho 72 section 7).
exit /b 0

:no_root
echo [%date% %time%] [ntc-flash] cannot enter E:\GCGSTATS - aborted >> "%TEMP%\ntc-flash-error.log"
exit /b 0
