@echo off
REM ============================================================================
REM run_weekly.bat  —  scheduled-task entry point for weekly portfolio review
REM
REM Runs weekly_review.py — aggregates past 7 days of archives, writes Markdown
REM report, pushes Telegram summary, commits + pushes to GitHub.
REM
REM Triggered by Windows Task Scheduler "Holdings Weekly Review" Sundays 09:00.
REM Log lands in %USERPROFILE%\OneDrive\Documents\Private Investments\logs\
REM ============================================================================

setlocal

set LOGDIR=%USERPROFILE%\OneDrive\Documents\Private Investments\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set LOGFILE=%LOGDIR%\weekly-last-run.log

echo ============================================================  >  "%LOGFILE%"
echo  Holdings weekly review started %date% %time%                 >> "%LOGFILE%"
echo ============================================================  >> "%LOGFILE%"

echo [weekly_review.py]                                            >> "%LOGFILE%"
cd /D "C:\Users\balli\OneDrive\Documents\Claude Base\Trading Setup\holdings-agent"
py weekly_review.py                                                >> "%LOGFILE%" 2>&1
set EXIT_CODE=%errorlevel%
echo weekly_review.py exit: %EXIT_CODE%                            >> "%LOGFILE%"

echo.                                                              >> "%LOGFILE%"
echo ============================================================  >> "%LOGFILE%"
echo  Finished %date% %time%  (exit=%EXIT_CODE%)                   >> "%LOGFILE%"
echo ============================================================  >> "%LOGFILE%"

endlocal
