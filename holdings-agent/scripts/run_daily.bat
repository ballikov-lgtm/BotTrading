@echo off
REM ============================================================================
REM run_daily.bat  —  scheduled-task entry point for daily holdings monitoring
REM
REM Sequence: lens.py (researches holdings) -> daily_watch.py (diffs + alerts)
REM
REM Triggered by Windows Task Scheduler "Holdings Daily Lens+Watch" at 06:30.
REM Log lands in %USERPROFILE%\OneDrive\Documents\Private Investments\logs\
REM ============================================================================

setlocal

set LOGDIR=%USERPROFILE%\OneDrive\Documents\Private Investments\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set LOGFILE=%LOGDIR%\daily-last-run.log

REM --- header --------------------------------------------------------------
echo ============================================================  >  "%LOGFILE%"
echo  Holdings daily run started %date% %time%                     >> "%LOGFILE%"
echo ============================================================  >> "%LOGFILE%"

REM --- 1. lens.py: produces today's holdings-alerts.json -------------------
echo [lens.py]                                                     >> "%LOGFILE%"
cd /D "C:\Users\balli\OneDrive\Documents\Claude Base\Trading Setup\research-agent\lens-holdings"
py lens.py                                                         >> "%LOGFILE%" 2>&1
set LENS_EXIT=%errorlevel%
echo lens.py exit: %LENS_EXIT%                                     >> "%LOGFILE%"

REM --- 2. daily_watch.py: diffs vs yesterday, sends Telegram ---------------
echo.                                                              >> "%LOGFILE%"
echo [daily_watch.py]                                              >> "%LOGFILE%"
cd /D "C:\Users\balli\OneDrive\Documents\Claude Base\Trading Setup\holdings-agent"
py daily_watch.py                                                  >> "%LOGFILE%" 2>&1
set WATCH_EXIT=%errorlevel%
echo daily_watch.py exit: %WATCH_EXIT%                             >> "%LOGFILE%"

REM --- footer --------------------------------------------------------------
echo.                                                              >> "%LOGFILE%"
echo ============================================================  >> "%LOGFILE%"
echo  Finished %date% %time%  (lens=%LENS_EXIT% watch=%WATCH_EXIT%) >> "%LOGFILE%"
echo ============================================================  >> "%LOGFILE%"

endlocal
