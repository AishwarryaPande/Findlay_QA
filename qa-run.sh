#!/usr/bin/env bash
# University of Findlay — QA Run Script
# Usage: ./qa-run.sh
# Asks for environment, wires up the correct CSV, runs all 5 checks, opens reports.

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
TODAY=$(date +%Y-%m-%d)

PROD_CSV="$ROOT/input/2026-05-27/final_findlay_edu_live_urls.csv"
STAGING_CSV="$ROOT/input/2026-05-25/findlayedu_sitemap_urls_25_may.csv"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   University of Findlay — QA Checks                      ║"
echo "║   Date: $TODAY                                       ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Which environment are you testing?"
echo "  [1] Production  — www.findlay.edu           (May 27 CSV)"
echo "  [2] Staging     — findlayedu.wpenginepowered.com  (May 25 CSV)"
echo ""
read -rp "Enter 1 or 2: " ENV_CHOICE

case "$ENV_CHOICE" in
  1)
    ENV_LABEL="Production"
    SOURCE_CSV="$PROD_CSV"
    DOMAIN="www.findlay.edu"
    ;;
  2)
    ENV_LABEL="Staging"
    SOURCE_CSV="$STAGING_CSV"
    DOMAIN="findlayedu.wpenginepowered.com"
    ;;
  *)
    echo "❌ Invalid choice. Please enter 1 or 2."
    exit 1
    ;;
esac

if [ ! -f "$SOURCE_CSV" ]; then
  echo "❌ CSV not found: $SOURCE_CSV"
  exit 1
fi

echo ""
echo "✅ Environment : $ENV_LABEL ($DOMAIN)"
echo "✅ Report date : $TODAY"
echo "✅ Source CSV  : $(basename "$SOURCE_CSV") ($(( $(wc -l < "$SOURCE_CSV") - 1 )) URLs)"
echo ""
read -rp "Press Enter to start all 5 checks, or Ctrl+C to cancel..."

# ── Wire up today's dated input folder ──────────────────────────────────────
INPUT_DIR="$ROOT/input/$TODAY"
mkdir -p "$INPUT_DIR"
cp "$SOURCE_CSV" "$INPUT_DIR/urls.csv"
echo ""
echo "📁 Input ready : $INPUT_DIR/urls.csv"
echo ""

# ── Run checks ───────────────────────────────────────────────────────────────
cd "$ROOT"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Check 1/5 — HTTP 404 Validation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npm run check-404:fast

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Check 2/5 — Blank CTA / Accessibility"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npm run check-cta:fast

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Check 3/5 — Internal Links"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npm run check-links:fast

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Check 4/5 — Browser 404 + Internal Links (Chromium)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
CONCURRENCY=8 npm run pw-audit

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Check 5/5 — UX Spacing Audit"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npm run ux-audit:fast

# ── Done ─────────────────────────────────────────────────────────────────────
REPORT_DIR="$ROOT/reports/$TODAY"
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅ All checks complete!                                  ║"
echo "║  Reports saved to: reports/$TODAY/              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Files generated:"
ls -lh "$REPORT_DIR" 2>/dev/null || echo "  (no files found — check for errors above)"

# Open reports folder on Mac
if command -v open &>/dev/null; then
  open "$REPORT_DIR"
fi
