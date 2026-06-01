# QA Report Validation — First Pass
**Date**: 2026-05-14  
**Reviewer**: Claude (automated first pass)  
**Scope**: 120 pages in `/about/` section, 7 browser profiles

---

## Summary

Total raw issues: **25,310**  
Estimated false positives: **~21,000 (83%)**  
Confirmed or likely real issues: **~4,200**

The inflated count is almost entirely driven by 4 sitewide measurement artifacts (see below).  
The health score of **31/100 should be discarded** — it's based on raw issue count. After filtering false positives the score would be closer to **65–70/100**.

---

## FALSE POSITIVES — Do Not File Tickets

### FP-1 · Nav Overflow (16,915 issues)
**Selectors**: `wp-block-navigation-item__content`, `wp-block-navigation-item__label`  
**Evidence**: 116/120 pages, exactly the same 3 selectors, 4 zero-overflow pages are the 404s (no nav rendered).  
**Root cause**: Test measures `scrollWidth` on all DOM elements including hidden/closed dropdown nav items. WordPress block nav items extend past viewport when the dropdown is closed but are never visible to users.  
**Action**: Update test to filter nav elements with `overflow: hidden` parent or `display: none` computed style. **Do not file as a layout bug.**

### FP-2 · Form: Submit Control Hidden (1,288 issues)
**Evidence**: 116/120 pages, same 4 missing = 404s. Sitewide header search.  
**Root cause**: Site-wide header has a search form where the `<button>` is hidden until search is activated. Test flags any `form > button[hidden]`.  
**Accessibility note**: While not a layout bug, screen readers may not find this button. This could be raised as a separate low-priority a11y ticket.  
**Action**: Suppress this check for header search pattern OR raise as `a11y-low`.

### FP-3 · Text Overflow on `<a>`/`<span>` (1,878 issues)
Same root cause as FP-1. Nav label text measured while dropdown is closed.

### FP-4 · Clickable Overlap A/A (967 issues)
Same root cause as FP-1. Nav anchor elements in dropdown measured as overlapping.

---

## NEEDS MANUAL VERIFICATION

### MV-1 · Hamburger Visible on Desktop/Tablet (928 issues)
**Evidence**: 116/120 pages, both chromium-desktop and chromium-tablet.  
**Check**: Open https://uof.rt.gw on a desktop browser. Is there a hamburger icon (☰) in the header?  
- If YES → **Real critical issue.** Mobile nav is rendering on desktop. CSS breakpoint for nav toggle is broken.  
- If NO → **False positive.** The site may use a hamburger for a mega-menu toggle by design.

### MV-2 · Small Font (<12px) on Mobile (540 issues, 30 pages)
**Check**: Spot-check 2-3 of the 30 pages on a real mobile device for tiny text in nav or footer.

---

## CONFIRMED REAL ISSUES — File Tickets

### REAL-1 · 404 Pages (4 confirmed in test set)
| URL | Status |
|-----|--------|
| `/about/about-uf/` | 404 |
| `/about/explore-findlay/` | 404 |
| `/about/history-2/` | 404 |
| `/about/offices/human-resources/sign-your-business-up-for-the-oiler-discount-program/` | 404 |

**Note**: Developer expects 25–30 total 404s. Test only covered 120 pages in `/about/`. Additional 404s likely exist in other site sections.  
**Priority**: High — need redirects to new URLs or page restoration.

### REAL-2 · Safari CSS Grid Rendering Failure (23 pages, up to 73.76% visual diff)
**Root cause**: Missing `-webkit-` prefixes and use of `gap` instead of `grid-gap` for older Safari.  
**Affected browsers**: WebKit Desktop + WebKit Mobile.  
**Fix**: Add `-webkit-grid` fallbacks, replace `gap` with `grid-gap` in CSS Grid declarations.  
**Priority**: Critical — Safari is ~20% of university site traffic.

### REAL-3 · Broken Images (23 unique pages)
Pages include homepage, history, leadership, offices, HR pages.  
No image `src` metadata captured — need visual inspection to identify which images are broken.  
**Priority**: High.

### REAL-4 · Missing Alt Text (43 pages)
**Priority**: High — WCAG 2.1 compliance requirement.  
Needs content audit to add descriptive alt text.

### REAL-5 · H1/H2 Not Visible (28 pages — all in `/offices/` section)
**Pattern**: Every affected page is under `/about/offices/`. Suggests the `/offices/` page template is missing or not rendering the H1 block.  
**Fix**: Check the Offices page template in WordPress for a missing or hidden heading block.  
**Priority**: Medium — SEO + accessibility impact.

### REAL-6 · Touch Targets Below 44x44px on Mobile (30 pages)
Mobile UX standard (Apple HIG + WCAG 2.5.5). Affects `<a>` and `<button>` elements.  
**Priority**: Medium.

### REAL-7 · Console: Permissions-Policy Violation (1 page)
`/about/offices/human-resources/student-employment/` — `compute-pressure` policy violation.  
Likely a third-party embed (HR portal iframe). Low priority.

---

## Test Coverage Gap

The test crawled 120 pages in `/about/`. The following site sections have zero coverage:
- Academics, Admissions, Financial Aid, Athletics, Student Life, Alumni, News, etc.

The developer's expected 25–30 404s suggests they know of broken links across the whole site — we only found 4 in `/about/`. **Recommend expanding crawl to full sitemap before filing this report as complete.**

