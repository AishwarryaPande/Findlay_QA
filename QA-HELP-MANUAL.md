# UOF QA Checks — How to Run

This folder has everything you need to run QA checks on the University of Findlay website. There are 5 checks in total. You can run them all at once or one by one.

---

## First time? Do this once

**Check Node.js is installed**

Open Terminal and run:
```bash
node --version
```
You should see something like `v20.x.x`. If you get "command not found", download Node from nodejs.org (get the LTS version) and install it before doing anything else.

**Get the project onto your machine**

Download the folder from Google Drive — it'll come as a ZIP. Unzip it and put it somewhere sensible (Desktop is fine).

**Make the run script executable** — Google Drive strips this permission:
```bash
chmod +x ~/Desktop/qa-checks-post-migration/qa-run.sh
```

**Install dependencies:**
```bash
cd ~/Desktop/qa-checks-post-migration
npm install
```

**Install the browser used for checks 4 and 5:**
```bash
npx playwright install chromium
```

That's it for setup. You won't need to do any of this again.

---

## Running the checks

```bash
./qa-run.sh
```

It'll ask you one question — prod or staging:

```
Which environment are you testing?
  [1] Production  — www.findlay.edu           (May 27 CSV)
  [2] Staging     — findlayedu.wpenginepowered.com  (May 25 CSV)

Enter 1 or 2:
```

Type `1` if you're checking the live site, `2` for staging/pre-prod. The script handles everything from there — picks the right URLs, creates today's report folder, runs all 5 checks, and opens the reports when done.

Reports land in `reports/2026-05-29/` (or whatever today's date is).

---

## What the 5 checks do

**Check 1 — HTTP 404**
Hits every URL and records the response. Fast, takes about 2 minutes.

On prod you'll see some `429 Too Many Requests` — that's just Cloudflare throttling us, not real failures. Check 4 (browser) will give you the accurate count.

**Check 2 — Blank CTAs / Accessibility**
Goes through every button, link and form input on every page looking for things users can't actually read or click. The red ones (blank buttons, no text at all) need fixing. The orange ones (generic text like "click here") are lower priority.

**Check 3 — Internal Links**
Crawls every page and checks that internal links go somewhere. If you see `Pages crawled: 0`, the CDN is blocking the HTTP crawler — just skip this and use Check 4's results instead.

**Check 4 — Browser 404 + Links**
Same as checks 1 and 3 but uses a real Chromium browser, so Cloudflare can't block it. This is the one to trust on prod. Takes around 30 minutes.

**Check 5 — UX Spacing**
Opens every page at 1440px wide and looks for big gaps and empty spacers. Red = gap over 250px (user-visible, worth fixing). Yellow = gap over 120px (worth a look). Takes about 30 minutes.

---

## What the reports look like

After the script finishes, a folder opens with these files:

```
404-validation-2026-05-29.html / .xlsx       ← Check 1
blank-cta-2026-05-29.html                    ← Check 2
UOF_QA_Content_Audit_2026-05-29.xlsx         ← Check 3
404-browser-2026-05-29.html / .xlsx          ← Check 4
internal-links-browser-2026-05-29.html       ← Check 4
UOF_QA_Links_Browser_2026-05-29.xlsx         ← Check 4
ux-spacing-audit-2026-05-29.html             ← Check 5
```

Open the `.html` files in Chrome. Open `.xlsx` in Excel or Google Sheets.

---

## Faculty page re-check

If dev says they've fixed the faculty pages, run:

```bash
CONCURRENCY=8 npm run pw-audit -- --input input/faculty-recheck.csv
```

Then immediately copy the output before it gets overwritten by the next full run:

```bash
TODAY=$(date +%Y-%m-%d)
cp reports/$TODAY/404-browser-$TODAY.html reports/$TODAY/faculty-recheck-$TODAY.html
cp reports/$TODAY/404-browser-$TODAY.xlsx reports/$TODAY/faculty-recheck-$TODAY.xlsx
```

`input/faculty-recheck.csv` has 342 faculty URLs. As of 27 May, 340 are live and 2 are still 404:
- `www.findlay.edu/faculty/angela-rumbaugh/`
- `www.findlay.edu/faculty/madelynn-jean-greenslade/`

---

## Running a single check

If you just want to re-run one check without going through the full script:

```bash
npm run check-404:fast
npm run check-cta:fast
npm run check-links:fast
CONCURRENCY=8 npm run pw-audit
npm run ux-audit:fast
```

Make sure `input/` has a folder named with today's date and the right CSV inside it, otherwise the output will have the wrong date. The `qa-run.sh` script sets this up automatically — if you're running checks manually you need to do it yourself:

```bash
mkdir -p input/2026-05-29
cp input/2026-05-27/final_findlay_edu_live_urls.csv input/2026-05-29/   # prod
# or
cp input/2026-05-25/findlayedu_sitemap_urls_25_may.csv input/2026-05-29/ # staging
```

---

## Things that look like errors but aren't

**429 in the 404 check** — Cloudflare rate-limiting our HTTP requests. Run Check 4 to get the real picture.

**Pages crawled: 0 in the links check** — same issue, CDN blocking HTTP. Use Check 4.

**permission denied: ./qa-run.sh** — run `chmod +x qa-run.sh` and try again.

---

## Baseline from go-live (27 May, prod)

| | |
|---|---|
| Pages live | 952 / 954 |
| Genuine 404s | 2 (`/about/.../service-grant/` and `/about/.../serve/`) |
| Broken internal links | 0 |
| Blank buttons/CTAs | 0 |
| UX spacing issues | 17 across 11 pages |
| Faculty pages live | 340 / 342 |
