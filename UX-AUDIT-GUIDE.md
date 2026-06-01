# UX Spacing Audit — Developer Guide

> Scripts: `scripts/check-spacing.ts` and `scripts/ux-spacing-audit.ts`
> Use this guide to run the spacing audit locally against a local WordPress instance or staging URL.

---

## What These Scripts Do

| Script | Purpose |
|---|---|
| `check-spacing.ts` | Broad pass — flags all elements site-wide with margin/padding over threshold. Lower thresholds, includes header/nav/footer. |
| `ux-spacing-audit.ts` | QA-reviewed audit — main content only, higher thresholds, separates **global CSS issues** (theme-level, one fix) from **page-specific issues**. This is the primary report. |

Both scripts:
- Use **Playwright (real Chromium)** — renders the page exactly as a browser would
- Take annotated **full-page screenshots** highlighting problem areas
- Output a self-contained **HTML report** in `reports/YYYY-MM-DD/`

---

## Prerequisites

```bash
# Install dependencies (only needed once)
npm install

# Install Playwright browsers (only needed once)
npx playwright install chromium
```

Node 18+ and `ts-node` are required.

---

## Step 1 — Prepare Your Input CSV

The scripts read URLs from a CSV file placed in:

```
input/
  YYYY-MM-DD/
    your-urls.csv
```

**CSV format** — one URL per line, with an optional header:

```
url
http://localhost:10014/
http://localhost:10014/about/
http://localhost:10014/admissions-aid/
http://localhost:10014/academics/
```

> **Local WordPress:** Replace `https://findlayedu.wpenginepowered.com` with your local URL (e.g. `http://localhost:10014` for Local by Flywheel).
>
> **Quick way to generate a local URL list** using WP-CLI:
> ```bash
> wp post list --post_type=page --post_status=publish --fields=ID --format=ids | \
>   xargs -n1 -I{} wp post list --post__in={} --fields=guid --format=csv | \
>   grep -v guid > input/2026-05-22/local-pages.csv
> ```
> Or use the sitemap: `http://localhost:10014/sitemap.xml`

---

## Step 2 — Run the Audit

### Full UX Audit (recommended)

```bash
npm run ux-audit
```

This runs `ux-spacing-audit.ts` — main content only, global vs page-specific breakdown.

### Broader Spacing Check

```bash
npm run check-spacing
```

Checks all elements including nav/header/footer.

### Speed it up with more concurrent browsers

```bash
# UX audit with 5 concurrent Chromium instances
npm run ux-audit:fast

# Or set concurrency manually
CONCURRENCY=5 npm run ux-audit
```

> Default is 3 concurrent browsers. Don't go above 5–6 on a local machine.

---

## Environment Variables (optional tuning)

All thresholds can be overridden via environment variables:

| Variable | Default (`ux-audit`) | Default (`check-spacing`) | Meaning |
|---|---|---|---|
| `CONCURRENCY` | `3` | `3` | Parallel browser instances |
| `WARN_PX` | `120` | `80` | Vertical spacing warning threshold (px) |
| `CRIT_PX` | `250` | `150` | Vertical spacing critical threshold (px) |
| `H_WARN_PX` | `80` | _(not used)_ | Horizontal padding warning threshold |
| `EMPTY_PX` | `60` | `100` | Empty spacer div height to flag |
| `GLOBAL_THRESHOLD` | `0.35` | _(not used)_ | % of pages a pattern must appear on to be "global" |

Example:

```bash
WARN_PX=80 CRIT_PX=160 CONCURRENCY=4 npm run ux-audit
```

---

## Step 3 — View the Report

Reports are saved to:

```
reports/
  YYYY-MM-DD/
    ux-spacing-audit-YYYY-MM-DD.html   ← main UX audit report
    spacing-issues-YYYY-MM-DD.html     ← broader check-spacing report
```

Just open the `.html` file in any browser — it is fully self-contained (screenshots embedded as base64).

---

## Understanding the UX Audit Report

The UX audit report (`ux-spacing-audit`) splits findings into two sections:

### Priority 1 — Global CSS Issues
Patterns appearing on **35%+ of pages** — these are theme-level CSS rules.
**One fix in the theme CSS resolves it everywhere.**

Example finding:
```
section.wp-block-group  |  padding-top  |  200px  |  affects 312 pages
→ Fix: .wp-block-group { padding-top: 80px; }
```

### Priority 2 — Page-Specific Issues
Issues unique to individual pages — content editor added inline spacing or a block override.
Each page card has an annotated screenshot showing exactly where the issue is.

---

## Checklist for Local Testing

- [ ] Local WordPress site is running and accessible
- [ ] Input CSV created in `input/YYYY-MM-DD/` with local URLs
- [ ] `npm install` done
- [ ] `npx playwright install chromium` done
- [ ] Run `npm run ux-audit`
- [ ] Open `reports/YYYY-MM-DD/ux-spacing-audit-YYYY-MM-DD.html`

---

## Troubleshooting

**"No YYYY-MM-DD folders found in input/"**
→ Create the folder structure: `input/2026-05-22/` and place your CSV inside it.

**"Executable doesn't exist" or Playwright browser error**
→ Run `npx playwright install chromium`

**Pages loading blank / wrong content**
→ Check the URL in your CSV. For Local by Flywheel, the URL might be `http://findlay.local` or `http://localhost:10014` — check your Local app for the exact address.

**Report is slow to open in browser**
→ The report embeds screenshots. For large runs (1000+ pages) it can be 50–100MB. Use Chrome for best performance.

**Want to test just a handful of pages first?**
→ Create a small CSV with 5–10 URLs and run normally. Good for verifying thresholds before a full run.
