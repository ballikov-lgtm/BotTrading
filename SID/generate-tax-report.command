#!/bin/bash
# ============================================================================
#  SID - Generate Tax Report (Mac)
#
#  Double-click this file. It builds an Excel spreadsheet of all your closed
#  SID trades on YOUR computer. Nothing is uploaded anywhere. Hand the Excel
#  to your accountant.
#
#  First time only: macOS may block a double-clicked script. If it does,
#  right-click this file -> Open -> Open. After that, double-click works.
# ============================================================================

echo ""
echo " ============================================================"
echo "  SID - Build my tax report (all my closed trades in Excel)"
echo " ============================================================"
echo ""

# --- Move to the repo root (this script lives in SID/, so go up one level) ---
cd "$(dirname "$0")/.." || {
  echo " [!] Could not find the strategy folder. Stopping."
  echo ""
  read -n 1 -s -r -p "Press any key to close this window..."
  exit 1
}

# --- Find a working Python 3 (python3 -> python) ---
PY=""
if command -v python3 >/dev/null 2>&1; then
  PY="python3"
elif command -v python >/dev/null 2>&1; then
  PY="python"
fi

if [ -z "$PY" ]; then
  echo " [!] Python 3 does not seem to be installed on this Mac."
  echo ""
  echo "     Please install Python 3 from:  https://www.python.org/downloads/"
  echo "     Then double-click this file again."
  echo ""
  read -n 1 -s -r -p "Press any key to close this window..."
  exit 1
fi

echo " [1/3] Getting your latest trades from your online copy..."
if git pull origin main; then
  echo "     Done."
  echo ""
else
  echo ""
  echo "     [i] Couldn't refresh the latest trades from online - that's OK."
  echo "         Generating the report from what's already on this computer."
  echo ""
fi

echo " [2/3] Making sure the spreadsheet library is ready..."
$PY -m pip install --quiet --disable-pip-version-check openpyxl >/dev/null 2>&1

echo " [3/3] Building your Excel report..."
echo ""
if ! $PY "SID/tax-report.py"; then
  echo ""
  echo " [!] Something went wrong building the report. See the messages above."
  echo ""
  read -n 1 -s -r -p "Press any key to close this window..."
  exit 1
fi

# --- Open the newest report in the tax-reports folder ---
NEWEST="$(ls -t SID/tax-reports/sid-tax-report-*.xlsx 2>/dev/null | head -n 1)"

echo ""
if [ -n "$NEWEST" ]; then
  echo " Opening your report:  $NEWEST"
  open "$NEWEST"
else
  echo " [i] Report built, but couldn't find the file to open automatically."
  echo "     Look inside the folder:  SID/tax-reports/"
fi

echo ""
echo " ------------------------------------------------------------"
echo "  All done. Your report is in the SID/tax-reports/ folder."
echo "  It lives ONLY on this computer - nothing was uploaded."
echo "  Filter the 'UK Tax Year' or 'Month' column, then read the"
echo "  total row for your realised profit for the visible rows."
echo " ------------------------------------------------------------"
echo ""
read -n 1 -s -r -p "Press any key to close this window..."
echo ""
