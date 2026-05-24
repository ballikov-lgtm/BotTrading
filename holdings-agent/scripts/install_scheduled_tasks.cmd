@echo off
REM ============================================================================
REM install_scheduled_tasks.cmd  —  one-shot Windows Task Scheduler installer
REM
REM Creates two tasks (replaces any existing with the same name):
REM   - "Holdings Daily Lens+Watch"  - daily at 06:30  - runs run_daily.bat
REM   - "Holdings Weekly Review"     - Sundays at 09:00 - runs run_weekly.bat
REM
REM Re-run any time to reset the schedule. Uninstall via:
REM   schtasks /Delete /TN "Holdings Daily Lens+Watch" /F
REM   schtasks /Delete /TN "Holdings Weekly Review" /F
REM ============================================================================

set SCRIPTS_DIR=%~dp0

echo Removing any prior tasks with the same names (ignore "not found" errors)...
schtasks /Delete /TN "Holdings Daily Lens+Watch" /F >nul 2>&1
schtasks /Delete /TN "Holdings Weekly Review" /F >nul 2>&1
echo.

echo Creating "Holdings Daily Lens+Watch" (daily 06:30)...
schtasks /Create /TN "Holdings Daily Lens+Watch" /TR "\"%SCRIPTS_DIR%run_daily.bat\"" /SC DAILY /ST 06:30 /F
echo.

echo Creating "Holdings Weekly Review" (Sundays 09:00)...
schtasks /Create /TN "Holdings Weekly Review" /TR "\"%SCRIPTS_DIR%run_weekly.bat\"" /SC WEEKLY /D SUN /ST 09:00 /F
echo.

echo Done. Verify with:
echo   schtasks /Query /TN "Holdings Daily Lens+Watch" /FO LIST
echo   schtasks /Query /TN "Holdings Weekly Review" /FO LIST
