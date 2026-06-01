# University of Findlay — Post-Migration QA Runbook

## Pre-requisites

```bash
npm install
```

Node 20+, ts-node, Playwright browsers installed (`npx playwright install chromium`).

---

## Step 0 — Add today's input CSV

Place the sitemap CSV in a date-stamped folder. The scripts auto-discover the latest one.

```
input/
└── 2026-05-27/
    └── final_findlay_edu_live_urls.csv   ← one URL per row, header = "url"
```

All reports are written to `reports/YYYY-MM-DD/` using the input folder date automatically.

---

## Reports generated (9 total)

| # | Report file | Script | What it checks |
|---|-------------|--------|----------------|
| 1 | `404-validation-YYYY-MM-DD.html` | check-404 | HTTP status of every URL |
| 2 | `404-validation-YYYY-MM-DD.xlsx` | check-404 | Same — Excel with per-status sheets |
| 3 | `blank-cta-YYYY-MM-DD.html` | check-cta | Blank/inaccessible buttons, links, inputs |
| 4 | `UOF_QA_Content_Audit_YYYY-MM-DD.xlsx` | check-links | Internal broken links — 6-sheet Excel |
| 5 | `404-browser-YYYY-MM-DD.html` | pw-audit | Browser (Chromium) 404 check — bypasses CDN |
| 6 | `404-browser-YYYY-MM-DD.xlsx` | pw-audit | Same — Excel |
| 7 | `internal-links-browser-YYYY-MM-DD.html` | pw-audit | Browser-crawled internal broken links |
| 8 | `UOF_QA_Links_Browser_YYYY-MM-DD.xlsx` | pw-audit | Same — Excel |
| 9 | `ux-spacing-audit-YYYY-MM-DD.html` | ux-audit | Spacing / visual layout issues |

---

## Run order (go-live day)

Run in this order — faster checks first, browser checks last.

### 1. HTTP 404 Check *(~2 min, 954 URLs)*

```bash
npm run check-404
```

Fast version (20 parallel workers):
```bash
npm run check-404:fast
```

**Output:** `reports/2026-05-27/404-validation-2026-05-27.html` + `.xlsx`

---

### 2. Blank CTA / Accessibility Check *(~5–10 min)*

```bash
npm run check-cta
```

Fast version:
```bash
npm run check-cta:fast
```

**Output:** `reports/2026-05-27/blank-cta-2026-05-27.html`

Flags:
- Buttons / links with no visible text and no aria-label
- `<a>` tags with no `href` attribute
- Icon-only links without an accessible name

---

### 3. Internal Links Check *(~10–20 min)*

```bash
npm run check-links
```

Fast version:
```bash
npm run check-links:fast
```

**Output:** `reports/2026-05-27/UOF_QA_Content_Audit_2026-05-27.xlsx`

6 sheets:
- Sheet 1: Summary
- Sheet 2: Broken Internal Links
- Sheet 3: External Links
- Sheet 4: Redirect Chains
- Sheet 5: No-Href Anchors (accessibility)
- Sheet 6: Dev Action List

---

### 4. Browser-Based 404 + Link Audit *(~30–60 min, uses real Chromium)*

```bash
npm run pw-audit:fast
```

Standard (5 workers):
```bash
npm run pw-audit
```

Increase concurrency for speed:
```bash
CONCURRENCY=8 npm run pw-audit
```

**Output:**
- `reports/2026-05-27/404-browser-2026-05-27.html` + `.xlsx`
- `reports/2026-05-27/internal-links-browser-2026-05-27.html`
- `reports/2026-05-27/UOF_QA_Links_Browser_2026-05-27.xlsx`

Use this when the HTTP check gets blocked by Cloudflare / WP Engine (429/403).

---

### 5. UX Spacing Audit *(~60–90 min, visual layout checks)*

```bash
npm run ux-audit
```

Fast version (5 parallel):
```bash
npm run ux-audit:fast
```

**Output:** `reports/2026-05-27/ux-spacing-audit-2026-05-27.html`

---

## Run everything in one go

```bash
npm run check-404:fast && \
npm run check-cta:fast && \
npm run check-links:fast && \
CONCURRENCY=8 npm run pw-audit && \
npm run ux-audit:fast
```

All reports land in `reports/2026-05-27/` automatically.

---

## Special: Faculty URL re-check

If dev says faculty pages are fixed, verify with:

```bash
CONCURRENCY=8 npm run pw-audit -- --input input/faculty-recheck.csv
```

Then copy the output to a dedicated file to avoid overwriting the main browser report:

```bash
cp reports/2026-05-27/404-browser-2026-05-27.html reports/2026-05-27/faculty-404-2026-05-27.html
cp reports/2026-05-27/404-browser-2026-05-27.xlsx reports/2026-05-27/faculty-404-2026-05-27.xlsx
```

---

## Key thresholds (what to flag as blockers)

| Check | Blocker threshold |
|-------|-------------------|
| 404 HTTP | Any 404 on a top-level page (/, /academics/, /admissions-aid/) |
| 404 Browser | Same — browser confirms no CDN false positives |
| Blank CTA | Any button/link with no accessible name on homepage or nav |
| Internal Links | Broken links on pages in the top navigation |
| Faculty pages | Any faculty URL still 404 after dev confirms fix |

---

## File locations

```
input/
└── 2026-05-27/final_findlay_edu_live_urls.csv   ← prod URL list (954 URLs)

input/faculty-recheck.csv                         ← 342 faculty URLs for targeted recheck

reports/2026-05-27/                               ← all today's reports land here
```
