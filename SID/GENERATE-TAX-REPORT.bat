@echo off
setlocal enabledelayedexpansion
REM ============================================================================
REM  SID - Generate Tax Report (Windows)
REM
REM  Double-click this file. It builds an Excel spreadsheet of all your closed
REM  SID trades on YOUR computer. Nothing is uploaded anywhere. Hand the Excel
REM  to your accountant.
REM ============================================================================

echo.
echo  ============================================================
echo   SID - Build my tax report (all my closed trades in Excel)
echo  ============================================================
echo.

REM --- Move to the repo root (this .bat lives in SID\, so go up one level) ---
cd /d "%~dp0\.."

REM --- Find a working Python (python -> py -3 -> python3) ---
set "PY="
python --version >nul 2>&1 && set "PY=python"
if not defined PY ( py -3 --version >nul 2>&1 && set "PY=py -3" )
if not defined PY ( python3 --version >nul 2>&1 && set "PY=python3" )

if not defined PY (
  echo  [!] Python does not seem to be installed on this computer.
  echo.
  echo      Please install Python 3 from:  https://www.python.org/downloads/
  echo      During install, tick "Add Python to PATH".
  echo      Then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo  [1/3] Getting your latest trades from your online copy...
git pull origin main
if errorlevel 1 (
  echo.
  echo      [i] Couldn't refresh the latest trades from online - that's OK.
  echo          Generating the report from what's already on this computer.
  echo.
) else (
  echo      Done.
  echo.
)

echo  [2/3] Making sure the spreadsheet library is ready...
%PY% -m pip install --quiet --disable-pip-version-check openpyxl >nul 2>&1

echo  [3/3] Building your Excel report...
echo.
%PY% "SID\tax-report.py"
if errorlevel 1 (
  echo.
  echo  [!] Something went wrong building the report. See the messages above.
  echo.
  pause
  exit /b 1
)

REM --- Open the newest report in the tax-reports folder ---
set "NEWEST="
for /f "delims=" %%F in ('dir /b /o-d /a-d "SID\tax-reports\sid-tax-report-*.xlsx" 2^>nul') do (
  if not defined NEWEST set "NEWEST=SID\tax-reports\%%F"
)

echo.
if defined NEWEST (
  echo  Opening your report:  !NEWEST!
  start "" "!NEWEST!"
) else (
  echo  [i] Report built, but couldn't find the file to open automatically.
  echo      Look inside the folder:  SID\tax-reports\
)

echo.
echo  ------------------------------------------------------------
echo   All done. Your report is in the SID\tax-reports\ folder.
echo   It lives ONLY on this computer - nothing was uploaded.
echo   Filter the 'UK Tax Year' or 'Month' column, then read the
echo   total row for your realised profit for the visible rows.
echo  ------------------------------------------------------------
echo.
pause
endlocal
