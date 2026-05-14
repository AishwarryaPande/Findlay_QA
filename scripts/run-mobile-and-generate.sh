#!/usr/bin/env bash
# Run mobile responsiveness for Chrome Mobile + Safari Mobile on 30 sample URLs,
# merge with existing data, then generate the final report.
set -e

URLS_FILE="/tmp/cross-browser-sample-30.txt"
BACKUP_ALL="/tmp/chromium-all-backup.ndjson"
CROSS_BROWSER_RESULTS="/tmp/cross-browser-results.ndjson"
MOBILE_RESULTS="/tmp/mobile-results.ndjson"
MERGED_FILE="/tmp/qa-all-browsers-merged.ndjson"
RUNTIME="/Users/aishwarryapande/qa-checks-post-migration/.qa-runtime/issues.ndjson"

echo "=== Step 1: Save cross-browser results ==="
cp "$RUNTIME" "$CROSS_BROWSER_RESULTS"
python3 -c "
import json
with open('$CROSS_BROWSER_RESULTS') as f:
    lines = [l for l in f if l.strip()]
from collections import Counter
browsers = Counter()
for l in lines:
    try: browsers[json.loads(l).get('browser','')] += 1
    except: pass
print(f'Cross-browser issues: {len(lines)}')
for b,c in sorted(browsers.items()): print(f'  {b}: {c}')
"

echo ""
echo "=== Step 2: Run Chrome Mobile + Safari Mobile responsiveness ==="
URLS_FILE="$URLS_FILE" npx playwright test tests/responsiveness.spec.ts \
  --project "chromium-mobile" \
  --project "webkit-mobile" \
  --retries=0 \
  --workers=8

cp "$RUNTIME" "$MOBILE_RESULTS"
python3 -c "
import json
with open('$MOBILE_RESULTS') as f:
    lines = [l for l in f if l.strip()]
from collections import Counter
browsers = Counter()
for l in lines:
    try: browsers[json.loads(l).get('browser','')] += 1
    except: pass
print(f'Mobile responsiveness issues: {len(lines)}')
for b,c in sorted(browsers.items()): print(f'  {b}: {c}')
"

echo ""
echo "=== Step 3: Merge all data sources ==="
python3 - <<'PYEOF'
import json
from pathlib import Path

sources = [
    "/tmp/chromium-all-backup.ndjson",
    "/tmp/cross-browser-results.ndjson",
    "/tmp/mobile-results.ndjson",
]

seen = set()
merged = []
for src in sources:
    p = Path(src)
    if not p.exists():
        print(f"  Skipping (not found): {src}")
        continue
    count = 0
    with open(p) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                d = json.loads(line)
                key = (d.get('browser',''), d.get('viewport',''), d.get('url',''), d.get('type',''), d.get('message','')[:80])
                if key not in seen:
                    seen.add(key)
                    merged.append(d)
                    count += 1
            except: pass
    print(f"  {src}: +{count} unique issues")

with open("/tmp/qa-all-browsers-merged.ndjson", "w") as f:
    for i in merged:
        f.write(json.dumps(i) + "\n")

from collections import Counter
browsers = Counter(i.get('browser','') for i in merged)
print(f"\nTotal merged: {len(merged)}")
for b,c in sorted(browsers.items()):
    print(f"  {b}: {c}")
PYEOF

echo ""
echo "=== Step 4: Write merged data to runtime file ==="
cp "$MERGED_FILE" "$RUNTIME"

echo ""
echo "=== Step 5: Generate final report ==="
python3 /Users/aishwarryapande/qa-checks-post-migration/scripts/generate-final-report.py
