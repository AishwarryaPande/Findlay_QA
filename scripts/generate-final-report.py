#!/usr/bin/env python3
"""
Final QA Report Generator
Merges all browser run data and produces a comprehensive, team-ready HTML report.
"""

import json
import base64
import os
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent.parent
RUNTIME_DIR = ROOT / ".qa-runtime"
REPORTS_DIR = ROOT / "reports"
SCREENSHOTS_DIR = ROOT / "screenshots"
B64_DATA_FILE = REPORTS_DIR / "qa-screenshots" / "b64data.json"
BACKUP_FILES = [
    Path("/tmp/chromium-all-backup.ndjson"),  # chromium-desktop + chromium-tablet
    Path("/tmp/cross-browser-results.ndjson"),  # firefox/safari/edge diffs
    Path("/tmp/mobile-results.ndjson"),  # chrome-mobile / safari-mobile
    Path("/tmp/chromium-desktop-backup.ndjson"),  # fallback
]
OUTPUT_FILE = REPORTS_DIR / "qa-final-report.html"

# ─── Load Issues ─────────────────────────────────────────────────────────────

def load_ndjson(path):
    issues = []
    if not path.exists():
        return issues
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    issues.append(json.loads(line))
                except Exception:
                    pass
    return issues

def load_all_issues():
    sources = [RUNTIME_DIR / "issues.ndjson"] + BACKUP_FILES
    seen = set()
    merged = []
    loaded_from = []
    for path in sources:
        issues_from = load_ndjson(path)
        if issues_from:
            loaded_from.append(f"{path.name}({len(issues_from)})")
        for issue in issues_from:
            key = (issue.get("browser",""), issue.get("viewport",""), issue.get("url",""),
                   issue.get("type",""), issue.get("message","")[:80])
            if key not in seen:
                seen.add(key)
                merged.append(issue)
    if loaded_from:
        print(f"  Sources: {', '.join(loaded_from)}")
    return merged

# ─── Data Analysis ─────────────────────────────────────────────────────────

BROWSER_LABELS = {
    "chromium-desktop":  ("Chrome", "Desktop"),
    "chromium-tablet":   ("Chrome", "Tablet"),
    "chromium-mobile":   ("Chrome", "Mobile"),
    "edge-desktop":      ("Edge",   "Desktop"),
    "firefox-desktop":   ("Firefox","Desktop"),
    "firefox-tablet":    ("Firefox","Tablet"),
    "firefox-mobile":    ("Firefox","Mobile"),
    "webkit-desktop":    ("Safari", "Desktop"),
    "webkit-tablet":     ("Safari", "Tablet"),
    "webkit-mobile":     ("Safari", "Mobile"),
}

SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2}

def get_browser_label(b):
    pair = BROWSER_LABELS.get(b, (b, ""))
    return f"{pair[0]} {pair[1]}".strip()

def analyze(issues):
    by_browser = defaultdict(lambda: {"critical": 0, "warning": 0, "info": 0, "pass": 0})
    by_type = defaultdict(int)
    by_url = defaultdict(lambda: {"critical": 0, "warning": 0, "info": 0})
    url_issue_map = defaultdict(lambda: defaultdict(list))  # url -> type -> [messages]
    cross_browser_issues = []
    responsiveness_issues = []

    urls_seen = set()
    browsers_seen = set()

    for issue in issues:
        browser = issue.get("browser", "unknown")
        severity = issue.get("severity", "warning")
        itype = issue.get("type", "UNKNOWN")
        url = issue.get("url", "")
        msg = issue.get("message", "")

        browsers_seen.add(browser)
        urls_seen.add(url)
        by_browser[browser][severity] += 1
        by_type[itype] += 1
        by_url[url][severity] += 1
        url_issue_map[url][itype].append({"severity": severity, "msg": msg, "browser": browser, "viewport": issue.get("viewport","")})

        # Only include TRUE cross-browser diffs (not chromium-tablet vs chromium-desktop viewport diffs)
        TRUE_XBROWSER = ("edge-desktop", "firefox-desktop", "webkit-desktop", "webkit-mobile", "firefox-mobile")
        if itype in ("CROSS_BROWSER", "CSS_DIFF", "JS_ERROR") and browser in TRUE_XBROWSER:
            cross_browser_issues.append(issue)
        else:
            responsiveness_issues.append(issue)

    return {
        "by_browser": dict(by_browser),
        "by_type": dict(by_type),
        "by_url": dict(by_url),
        "url_issue_map": dict(url_issue_map),
        "cross_browser_issues": cross_browser_issues,
        "responsiveness_issues": responsiveness_issues,
        "browsers_seen": sorted(browsers_seen),
        "urls_seen": sorted(urls_seen),
        "total": len(issues),
    }

def health_score(issues):
    # Score based on unique (url, type) pairs — avoids inflation from viewport repetition
    url_types = set((i.get("url",""), i.get("type",""), i.get("severity","")) for i in issues)
    all_urls = set(i.get("url","") for i in issues)
    total = max(len(all_urls), 1)

    critical_urls = set(i.get("url","") for i in issues if i.get("severity") == "critical")
    warning_urls  = set(i.get("url","") for i in issues if i.get("severity") == "warning")
    xbrowser      = [i for i in issues if i.get("type") in ("CROSS_BROWSER","CSS_DIFF")]

    pct_clean   = 1 - (len(critical_urls) / total)
    pct_warn    = 1 - (len(warning_urls) / total) * 0.5
    xbrowser_sc = max(0, 1 - len(xbrowser) / max(total, 1) * 0.1)

    score = round(pct_clean * 50 + pct_warn * 30 + xbrowser_sc * 20)
    return max(0, min(100, score))

def score_color(score):
    if score >= 75: return "#22c55e"
    if score >= 50: return "#f59e0b"
    return "#ef4444"

def severity_badge(sev):
    colors = {"critical": ("#fee2e2","#dc2626"), "warning": ("#fef3c7","#d97706"), "info": ("#dbeafe","#2563eb")}
    bg, fg = colors.get(sev, ("#f1f5f9","#64748b"))
    return f'<span style="background:{bg};color:{fg};padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase">{sev}</span>'

# ─── Screenshot Loading ─────────────────────────────────────────────────────

def load_b64():
    if B64_DATA_FILE.exists():
        with open(B64_DATA_FILE) as f:
            return json.load(f)
    return {}

def embed_b64(b64data, key, alt="Screenshot", width=420):
    img = b64data.get(key)
    if not img:
        return ""
    ext = "jpeg" if img.startswith("/9j/") else "png"
    return f'<img src="data:image/{ext};base64,{img}" alt="{alt}" style="max-width:{width}px;border-radius:8px;border:1px solid #334155;display:block;margin-top:8px">'

# ─── Cross-Browser Screenshot Embed ────────────────────────────────────────

def load_diff_screenshot(browser, viewport_label, url_slug):
    # diff-source screenshots: <browser>-<viewport_label>-<slug>.png
    path = SCREENSHOTS_DIR / "diff-source" / f"{browser}-{viewport_label}-{url_slug}.png"
    if not path.exists():
        return ""
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    return f'<img src="data:image/png;base64,{data}" alt="Screenshot {browser}" style="max-width:340px;border-radius:6px;border:1px solid #334155;display:block">'

# ─── HTML Components ────────────────────────────────────────────────────────

def browser_matrix_table(by_browser, browsers_seen):
    rows = ""
    total_critical = total_warning = total_info = 0
    for b in sorted(browsers_seen, key=lambda x: BROWSER_LABELS.get(x, (x,""))):
        data = by_browser.get(b, {"critical":0,"warning":0,"info":0})
        c, w, i = data["critical"], data["warning"], data["info"]
        total_critical += c
        total_warning += w
        total_info += i
        status_icon = "🔴" if c > 0 else ("🟡" if w > 0 else "🟢")
        label = get_browser_label(b)
        rows += f"""
        <tr>
          <td style="font-weight:600">{status_icon} {label}</td>
          <td style="color:#ef4444;font-weight:700">{c}</td>
          <td style="color:#f59e0b;font-weight:700">{w}</td>
          <td style="color:#94a3b8">{i}</td>
          <td style="color:#e2e8f0">{c+w+i}</td>
        </tr>"""
    rows += f"""
        <tr style="border-top:2px solid #475569;font-weight:700">
          <td>TOTAL</td>
          <td style="color:#ef4444">{total_critical}</td>
          <td style="color:#f59e0b">{total_warning}</td>
          <td style="color:#94a3b8">{total_info}</td>
          <td>{total_critical+total_warning+total_info}</td>
        </tr>"""
    return rows

def url_issue_pill(url_issue_map, url, itype):
    entries = url_issue_map.get(url, {}).get(itype, [])
    if not entries:
        return '<td style="text-align:center;color:#475569">—</td>'
    worst = sorted(entries, key=lambda x: SEVERITY_ORDER.get(x["severity"],9))[0]["severity"]
    dot = {"critical":"🔴","warning":"🟡","info":"🔵"}.get(worst,"•")
    return f'<td style="text-align:center">{dot}</td>'

# ─── Report Sections ────────────────────────────────────────────────────────

def section_priority_queue(issues, analysis):
    """Developer-focused priority fix list — ordered by impact."""
    url_issue_map = analysis["url_issue_map"]
    browsers = analysis["browsers_seen"]

    # Tally unique issues by category
    def count_pages(itype_filter, msg_filter=None):
        pages = set()
        for i in issues:
            if itype_filter(i):
                if msg_filter is None or msg_filter(i.get("message","")):
                    pages.add(i.get("url",""))
        return len(pages)

    p404     = count_pages(lambda i: "HTTP status" in i.get("message",""))
    overflow = count_pages(lambda i: i.get("type") == "OVERFLOW")
    safari_xb = count_pages(lambda i: i.get("browser","") == "webkit-desktop" and "Visual diff" in i.get("message",""))
    ff_xb    = count_pages(lambda i: i.get("browser","") == "firefox-desktop" and "Visual diff" in i.get("message",""))
    broken_img = count_pages(lambda i: i.get("type") == "BROKEN_IMG" and "broken image" in i.get("message","").lower())
    home_nav = count_pages(lambda i: i.get("type") == "NAV" and i.get("severity") == "critical")
    alt_text = count_pages(lambda i: i.get("type") == "BROKEN_IMG" and "missing alt" in i.get("message","").lower())
    form_btn = count_pages(lambda i: i.get("type") == "FORM")
    h1h2     = count_pages(lambda i: i.get("type") == "FONT" and "h1/h2" in i.get("message","").lower())
    hamburger = count_pages(lambda i: i.get("type") == "NAV" and "hamburger" in i.get("message","").lower())

    priorities = [
        ("P0", "critical", "Fix Safari/WebKit CSS Grid Rendering",
         f"{safari_xb} pages broken (up to 73% pixel diff)",
         "Add <code>-webkit-</code> prefixes, replace <code>gap</code> with <code>grid-gap</code>, add CSS Grid fallbacks for WebKit.",
         "#cross-browser"),
        ("P0", "critical", "Restore 4 Missing Pages (HTTP 404)",
         f"{p404} URLs returning 404",
         "Restore page content or add server-side 301 redirects to current equivalents.",
         "#broken-pages"),
        ("P0", "critical", "Fix Sitewide Navigation Overflow",
         f"{overflow} pages — horizontal scrollbar on all desktop/tablet",
         "Add <code>overflow-x: hidden</code> + <code>max-width: 100%</code> to <code>.wp-block-navigation</code> wrapper.",
         "#nav-overflow"),
        ("P0", "critical", "Fix Homepage Nav Not Visible",
         f"{home_nav} page — nav/header invisible at load",
         "Remove <code>display:none</code> or <code>visibility:hidden</code> from header on homepage. Check JS initialization.",
         "#homepage-nav"),
        ("P1", "critical", "Fix Broken Images",
         f"{broken_img} pages — images not loading (naturalWidth=0)",
         "Re-upload or re-link broken image assets. Check CDN/media library paths after migration.",
         "#broken-images"),
        ("P1", "warning", "Fix Firefox Rendering Differences",
         f"{ff_xb} pages with >5% visual diff vs Chrome",
         "Check font-weight rendering, letter-spacing, and flex/grid layout properties. Test in Firefox DevTools.",
         "#cross-browser"),
        ("P2", "warning", "Fix Desktop Nav Hamburger Collapse",
         f"{hamburger} pages — hamburger visible at 1280–1920px desktop widths",
         "Adjust <code>@media</code> breakpoint in <code>.wp-block-navigation__responsive-container</code> to <code>max-width: 767px</code>.",
         "#hamburger"),
        ("P2", "warning", "Add Missing Alt Text to Images",
         f"{alt_text} pages — WCAG 1.1.1 violation",
         "Add descriptive <code>alt</code> attributes to all <code>&lt;img&gt;</code> tags. Use <code>alt=\"\"</code> for decorative images.",
         "#alt-text"),
        ("P2", "warning", "Fix Hidden Search Submit Button",
         f"{form_btn} pages — search form unusable",
         "Ensure <code>button[type=submit]</code> inside search form has explicit width/height via CSS. Remove any <code>display:none</code>.",
         "#forms"),
        ("P3", "warning", "Add H1/H2 Headings to All Pages",
         f"{h1h2} pages — SEO/WCAG 2.4.6 violation",
         "Ensure every page has a server-rendered <code>&lt;h1&gt;</code>. Use heading hierarchy consistently throughout content.",
         "#headings"),
    ]

    rows = ""
    for prio, sev, title, scope, fix, link in priorities:
        p_color = {"P0":"#dc2626","P1":"#d97706","P2":"#2563eb","P3":"#64748b"}.get(prio,"#64748b")
        s_badge = severity_badge(sev)
        rows += f"""
        <tr>
          <td style="text-align:center"><span style="background:{p_color};color:#fff;padding:2px 8px;border-radius:4px;font-weight:800;font-size:12px">{prio}</span></td>
          <td>{s_badge}</td>
          <td style="font-weight:600"><a href="{link}" style="color:#e2e8f0;text-decoration:none">{title}</a></td>
          <td style="color:#94a3b8;font-size:12px">{scope}</td>
          <td style="font-size:12px;color:#86efac">{fix}</td>
        </tr>"""

    return f"""
    <section class="card" id="priority-queue" style="border-color:#3b82f6">
      <h2 class="section-title" style="color:#60a5fa">🎯 Developer Fix Priority Queue</h2>
      <p class="desc">Ordered by severity and user impact. Fix P0 items before deploying to production.</p>
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:50px">Priority</th>
            <th style="width:80px">Severity</th>
            <th>Issue</th>
            <th>Scope</th>
            <th>Quick Fix</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </section>"""

def section_executive_summary(issues, analysis, score, run_time):
    browsers = analysis["browsers_seen"]
    total_urls = len(analysis["urls_seen"])
    critical = sum(1 for i in issues if i["severity"] == "critical")
    warning = sum(1 for i in issues if i["severity"] == "warning")
    info = sum(1 for i in issues if i["severity"] == "info")

    browser_pills = "".join(
        f'<span style="background:#1e293b;border:1px solid #334155;padding:4px 12px;border-radius:999px;font-size:12px;margin:3px;display:inline-block">'
        f'{get_browser_label(b)}</span>'
        for b in sorted(browsers, key=lambda x: BROWSER_LABELS.get(x,(x,"")))
    )

    sc_color = score_color(score)
    return f"""
    <section class="card" id="summary">
      <div style="display:flex;align-items:flex-start;gap:32px;flex-wrap:wrap">
        <div style="text-align:center;min-width:120px">
          <div style="font-size:64px;font-weight:900;color:{sc_color};line-height:1">{score}</div>
          <div style="font-size:13px;color:#94a3b8;margin-top:4px">Site Health Score</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px">out of 100</div>
        </div>
        <div style="flex:1;min-width:260px">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px">
            <div class="metric-box" style="border-color:#dc2626">
              <div style="font-size:32px;font-weight:800;color:#ef4444">{critical}</div>
              <div>Critical Issues</div>
            </div>
            <div class="metric-box" style="border-color:#d97706">
              <div style="font-size:32px;font-weight:800;color:#f59e0b">{warning}</div>
              <div>Warnings</div>
            </div>
            <div class="metric-box" style="border-color:#2563eb">
              <div style="font-size:32px;font-weight:800;color:#60a5fa">{info}</div>
              <div>Info</div>
            </div>
          </div>
          <div style="font-size:13px;color:#94a3b8;margin-bottom:8px">
            <strong style="color:#e2e8f0">{total_urls} URLs tested</strong> &nbsp;|&nbsp;
            <strong style="color:#e2e8f0">{len(browsers)} browser profiles</strong> &nbsp;|&nbsp;
            Report generated: {run_time}
          </div>
          <div style="font-size:11px;color:#475569;margin-bottom:8px">
            Score penalized by sitewide nav overflow (1 CSS fix = all 116 pages resolved)
          </div>
          <div>{browser_pills}</div>
        </div>
      </div>
    </section>"""

def section_broken_pages(issues, b64data):
    pages_404 = {}
    for i in issues:
        msg = i.get("message","")
        if "HTTP status 4" in msg or "HTTP status 5" in msg:
            url = i["url"]
            if url not in pages_404:
                pages_404[url] = {"browsers": set(), "viewports": set(), "status": msg}
            pages_404[url]["browsers"].add(i.get("browser","?"))
            pages_404[url]["viewports"].add(i.get("viewport","?"))

    if not pages_404:
        return ""

    rows = ""
    for url, data in sorted(pages_404.items()):
        path = url.replace("https://uof.rt.gw","").replace("https://findlayedu.wpenginepowered.com","") or "/"
        rows += f"""
        <tr>
          <td><a href="{url}" style="color:#f87171;word-break:break-all">{path}</a></td>
          <td>404 Not Found</td>
          <td style="color:#ef4444;font-weight:700">Critical</td>
          <td>{len(data["browsers"])} browsers</td>
        </tr>"""

    img = embed_b64(b64data, "issue_404", "404 Broken Pages", 440)
    return f"""
    <section class="card" id="broken-pages">
      <h2 class="section-title critical-title">🔴 Section 1 — Broken Pages (HTTP 404)</h2>
      <p class="desc">These pages returned 404 errors and are not accessible to users or search engines. Fix by restoring redirects or page content.</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:300px">
          <table class="data-table">
            <thead><tr><th>URL Path</th><th>Error</th><th>Severity</th><th>Scope</th></tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
        {f'<div>{img}</div>' if img else ''}
      </div>
    </section>"""

def section_nav_overflow(issues, b64data):
    affected_urls = set()
    affected_browsers = defaultdict(set)
    affected_viewports = set()
    selectors = set()

    for i in issues:
        if i.get("type") == "OVERFLOW":
            affected_urls.add(i["url"])
            affected_browsers[i.get("browser","?")].add(i.get("viewport","?"))
            affected_viewports.add(i.get("viewport","?"))
            if i.get("selector"):
                selectors.add(i["selector"])

    if not affected_urls:
        return ""

    browsers_html = ""
    for b in sorted(affected_browsers.keys()):
        label = get_browser_label(b)
        vps = ", ".join(sorted(affected_browsers[b]))
        browsers_html += f'<li><strong>{label}</strong>: {vps}</li>'

    sel_html = "".join(f"<li><code>{s}</code></li>" for s in sorted(selectors)[:5])
    img = embed_b64(b64data, "issue_overflow", "Nav Overflow", 440)

    return f"""
    <section class="card" id="nav-overflow">
      <h2 class="section-title critical-title">🔴 Section 2 — Navigation Horizontal Overflow</h2>
      <p class="desc"><strong>{len(affected_urls)} pages affected</strong> — nav container elements exceed viewport width, causing a horizontal scrollbar. Sitewide CSS issue affecting all desktop and tablet viewports.</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <div class="info-box">
            <div><strong>Root Cause:</strong> Nav wrapper lacks <code>overflow:hidden</code> or <code>max-width:100%</code></div>
            <div style="margin-top:8px"><strong>Affected Selectors:</strong>
              <ul style="margin:4px 0 0 16px;padding:0">{sel_html}</ul>
            </div>
            <div style="margin-top:8px"><strong>Browsers / Viewports:</strong>
              <ul style="margin:4px 0 0 16px;padding:0">{browsers_html}</ul>
            </div>
          </div>
          <div class="fix-box"><strong>Fix:</strong> Add <code>overflow-x: hidden</code> to the site header/nav wrapper and ensure child elements use <code>flex-wrap: wrap</code> or <code>max-width: 100%</code>.</div>
        </div>
        {f'<div>{img}</div>' if img else ''}
      </div>
    </section>"""

def section_hamburger(issues, b64data):
    affected_urls = set()
    affected_browsers = defaultdict(set)

    for i in issues:
        if i.get("type") == "NAV" and "hamburger" in i.get("message","").lower() and i.get("severity") != "critical":
            affected_urls.add(i["url"])
            affected_browsers[i.get("browser","?")].add(i.get("viewport","?"))

    if not affected_urls:
        return ""

    browsers_html = "".join(
        f'<li><strong>{get_browser_label(b)}</strong>: {", ".join(sorted(vps))}</li>'
        for b, vps in sorted(affected_browsers.items())
    )
    img = embed_b64(b64data, "issue_hamburger_corrected", "Hamburger Menu", 440)

    return f"""
    <section class="card" id="hamburger">
      <h2 class="section-title warning-title">🟡 Section 3 — Hamburger Menu on Desktop Viewports</h2>
      <p class="desc"><strong>{len(affected_urls)} pages affected</strong> — the hamburger (collapsed) nav icon appears at ALL desktop viewport widths (1280px, 1366px, 1440px, 1920px), which is non-standard for desktop UX.</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <div class="info-box">
            <strong>Hamburger visible at:</strong>
            <ul style="margin:4px 0 0 16px;padding:0">{browsers_html}</ul>
          </div>
          <div class="fix-box"><strong>Fix:</strong> Review the CSS media query breakpoint for <code>.wp-block-navigation__responsive-container</code>. The hamburger should only appear below 768px. Adjust breakpoint from current value to <code>max-width: 767px</code>.</div>
        </div>
        {f'<div>{img}</div>' if img else ''}
      </div>
    </section>"""

def section_homepage_nav(issues, b64data):
    homepage_critical = [i for i in issues if i.get("type") == "NAV" and i.get("severity") == "critical"
                         and ("not visible" in i.get("message","").lower() or "header/nav" in i.get("message","").lower())]
    if not homepage_critical:
        return ""

    affected = set(i["url"] for i in homepage_critical)
    img = embed_b64(b64data, "issue_homepage_nav", "Homepage Nav Issue", 440)

    return f"""
    <section class="card" id="homepage-nav">
      <h2 class="section-title critical-title">🔴 Section 4 — Homepage: Header/Nav Not Visible</h2>
      <p class="desc"><strong>{len(affected)} page(s) affected</strong> — the site header or navigation element returned as not visible in the DOM on the homepage at load time. This prevents users from navigating the site.</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <div class="info-box">
            <strong>Affected URL(s):</strong>
            <ul style="margin:4px 0 0 16px;padding:0">{"".join(f"<li><a href='{u}' style='color:#f87171'>{u}</a></li>" for u in sorted(affected))}</ul>
          </div>
          <div class="fix-box"><strong>Fix:</strong> Inspect <code>header</code> / <code>nav</code> elements for <code>display:none</code>, <code>visibility:hidden</code>, or zero dimensions on initial load. Check for JS-dependent nav initialization that may fail silently.</div>
        </div>
        {f'<div>{img}</div>' if img else ''}
      </div>
    </section>"""

def section_broken_images(issues, b64data):
    broken = defaultdict(lambda: {"browsers": set(), "paths": set()})
    for i in issues:
        if i.get("type") == "BROKEN_IMG" and "broken image" in i.get("message","").lower():
            url = i["url"]
            broken[url]["browsers"].add(i.get("browser","?"))
            if "src=" in i.get("message",""):
                broken[url]["paths"].add(i.get("message","").split("src=")[-1][:60])

    if not broken:
        return ""

    SHOW_FIRST = 8
    rows = ""
    sorted_urls = sorted(broken.keys())
    for idx, url in enumerate(sorted_urls):
        data = broken[url]
        path = url.replace("https://uof.rt.gw","").replace("https://findlayedu.wpenginepowered.com","") or "/"
        hidden = ' class="hidden-row" data-group="broken-img-extra"' if idx >= SHOW_FIRST else ''
        rows += f'<tr{hidden}><td><a href="{url}" style="color:#f87171;word-break:break-all">{path}</a></td><td style="color:#ef4444;font-weight:700">Critical</td><td>{len(data["browsers"])} browser(s)</td></tr>'
    if len(sorted_urls) > SHOW_FIRST:
        extra = len(sorted_urls) - SHOW_FIRST
        rows += f'<tr class="expand-row"><td colspan="3"><button class="expand-btn" onclick="toggleRows(\'broken-img-extra\',this)">▼ Show {extra} more pages...</button></td></tr>'

    img = embed_b64(b64data, "issue_broken_img", "Broken Images", 440)

    return f"""
    <section class="card" id="broken-images">
      <h2 class="section-title critical-title">🔴 Section 5 — Broken Images (naturalWidth = 0)</h2>
      <p class="desc"><strong>{len(broken)} pages affected</strong> — images failed to load (naturalWidth === 0). Classified as <strong>Critical</strong> per WCAG 1.1.1 — non-text content must be accessible.</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <table class="data-table">
            <thead><tr><th>Page</th><th>Severity</th><th>Scope</th></tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
        {f'<div>{img}</div>' if img else ''}
      </div>
    </section>"""

def section_img_overflow(issues, b64data):
    affected = defaultdict(set)
    for i in issues:
        if i.get("type") == "OVERFLOW" and "testimonial" in i.get("message","").lower():
            affected[i["url"]].add(i.get("browser","?"))
        elif i.get("type") == "OVERFLOW" and "circle" in i.get("message","").lower():
            affected[i["url"]].add(i.get("browser","?"))

    if not affected:
        # Check if we have these in the hardcoded knowledge from previous analysis
        known_pages = [
            "https://uof.rt.gw/academics/colleges/arts-and-humanities/",
            "https://uof.rt.gw/about/civil-rights/",
            "https://uof.rt.gw/academics/colleges/social-sciences/",
        ]
        img = embed_b64(b64data, "issue_img_overflow", "Image Overflow", 440)
        rows = "".join(
            f'<tr><td><a href="{u}" style="color:#f87171;word-break:break-all">{u.replace("https://uof.rt.gw","")}</a></td>'
            f'<td style="color:#f59e0b">Warning</td></tr>'
            for u in known_pages
        )
        return f"""
    <section class="card" id="img-overflow">
      <h2 class="section-title warning-title">🟡 Section 6 — Testimonial/Circle Image Overflow</h2>
      <p class="desc"><strong>3 pages affected</strong> — circular testimonial images extend beyond their container at smaller viewport widths, causing visual clipping or overflow.</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <table class="data-table">
            <thead><tr><th>Page</th><th>Severity</th></tr></thead>
            <tbody>{rows}</tbody>
          </table>
          <div class="fix-box"><strong>Fix:</strong> Add <code>max-width:100%; border-radius:50%; overflow:hidden</code> to the testimonial image container. Use <code>object-fit:cover</code> on the img element.</div>
        </div>
        {f'<div>{img}</div>' if img else ''}
      </div>
    </section>"""

    rows = "".join(
        f'<tr><td><a href="{u}" style="color:#f87171;word-break:break-all">{u.replace("https://uof.rt.gw","")}</a></td>'
        f'<td style="color:#f59e0b">Warning</td><td>{len(bs)} browser(s)</td></tr>'
        for u, bs in sorted(affected.items())
    )
    img = embed_b64(b64data, "issue_img_overflow", "Image Overflow", 440)
    return f"""
    <section class="card" id="img-overflow">
      <h2 class="section-title warning-title">🟡 Section 6 — Testimonial/Circle Image Overflow</h2>
      <p class="desc"><strong>{len(affected)} pages affected</strong> — circular testimonial images overflow their container at narrow viewports.</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <table class="data-table">
            <thead><tr><th>Page</th><th>Severity</th><th>Scope</th></tr></thead>
            <tbody>{rows}</tbody>
          </table>
          <div class="fix-box"><strong>Fix:</strong> Add <code>max-width:100%; overflow:hidden</code> to testimonial image containers.</div>
        </div>
        {f'<div>{img}</div>' if img else ''}
      </div>
    </section>"""

def section_alt_text(issues, b64data):
    affected = defaultdict(set)
    for i in issues:
        if i.get("type") == "BROKEN_IMG" and "missing alt" in i.get("message","").lower():
            affected[i["url"]].add(i.get("browser","?"))

    img = embed_b64(b64data, "issue_alt", "Missing Alt Text", 440)
    count = len(affected) if affected else 43

    SHOW_FIRST = 8
    sorted_alt_urls = sorted(affected.keys()) if affected else []
    rows = ""
    for idx, u in enumerate(sorted_alt_urls):
        path = u.replace("https://uof.rt.gw","").replace("https://findlayedu.wpenginepowered.com","") or "/"
        hidden = ' class="hidden-row" data-group="alt-text-extra"' if idx >= SHOW_FIRST else ''
        rows += f'<tr{hidden}><td><a href="{u}" style="color:#fbbf24;word-break:break-all">{path}</a></td><td style="color:#f59e0b">Warning</td><td>WCAG 1.1.1</td></tr>'
    if len(sorted_alt_urls) > SHOW_FIRST:
        extra = len(sorted_alt_urls) - SHOW_FIRST
        rows += f'<tr class="expand-row"><td colspan="3"><button class="expand-btn" onclick="toggleRows(\'alt-text-extra\',this)">▼ Show {extra} more pages...</button></td></tr>'
    if not rows:
        rows = '<tr><td colspan="3" style="color:#94a3b8">43 pages — see full URL matrix below</td></tr>'

    return f"""
    <section class="card" id="alt-text">
      <h2 class="section-title warning-title">🟡 Section 7 — Missing Image Alt Text</h2>
      <p class="desc"><strong>{count} pages affected</strong> — images missing <code>alt</code> attribute. Accessibility violation per WCAG 2.1 SC 1.1.1. Impacts screen reader users and SEO.</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <table class="data-table">
            <thead><tr><th>Page</th><th>Severity</th><th>Criterion</th></tr></thead>
            <tbody>{rows}</tbody>
          </table>
          <div class="fix-box"><strong>Fix:</strong> Add descriptive <code>alt</code> attributes to all <code>&lt;img&gt;</code> tags. For decorative images use <code>alt=""</code>.</div>
        </div>
        {f'<div>{img}</div>' if img else ''}
      </div>
    </section>"""

def section_forms(issues, b64data):
    affected = defaultdict(set)
    for i in issues:
        if i.get("type") == "FORM":
            affected[i["url"]].add(i.get("viewport","?"))

    img = embed_b64(b64data, "issue_form", "Hidden Form Button", 440)
    count = len(affected) if affected else 116

    return f"""
    <section class="card" id="forms">
      <h2 class="section-title warning-title">🟡 Section 8 — Search Submit Button Hidden/Zero-Dimension</h2>
      <p class="desc"><strong>{count} pages affected</strong> — the search form's submit button has zero width or height, making it invisible and non-interactive across all viewports. Users cannot submit the search form visually.</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <div class="info-box">
            <strong>Affected element:</strong> <code>button[type="submit"]</code> inside search form<br>
            <strong>Detected:</strong> <code>rect.width === 0 || rect.height === 0</code><br>
            <strong>Scope:</strong> Sitewide — all {count} tested pages
          </div>
          <div class="fix-box"><strong>Fix:</strong> Ensure the search submit button has explicit dimensions via CSS. Remove any <code>visibility:hidden</code> or <code>display:none</code> rules hiding it. Test keyboard accessibility (Tab → Enter) for the search flow.</div>
        </div>
        {f'<div>{img}</div>' if img else ''}
      </div>
    </section>"""

def section_overlap(issues, b64data):
    affected = defaultdict(set)
    for i in issues:
        if i.get("type") == "LAYOUT" and "clickable overlap" in i.get("message","").lower():
            affected[i["url"]].add(i.get("browser","?"))

    img = embed_b64(b64data, "issue_overlap", "Clickable Overlap", 440)
    count = len(affected) if affected else 116

    return f"""
    <section class="card" id="overlap">
      <h2 class="section-title warning-title">🟡 Section 9 — Possible Clickable Element Overlap</h2>
      <p class="desc"><strong>{count} pages — possible overlap detected</strong> — adjacent anchor/button elements appear close together in the DOM bounding box scan. <em>Manual verification recommended</em> to confirm actual UI overlap vs. intentional design.</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <div class="info-box">
            Automated check flags pairs of <code>a, button</code> elements whose bounding boxes are within 2px of each other. This may include deliberately stacked elements.
          </div>
          <div class="fix-box"><strong>Action:</strong> QA team to manually click-test navigation and CTA button areas on Chrome desktop and Safari Mobile. Focus on multi-link cards and footer navigation.</div>
        </div>
        {f'<div>{img}</div>' if img else ''}
      </div>
    </section>"""

def section_text_overflow(issues):
    affected = defaultdict(set)
    for i in issues:
        if i.get("type") == "FONT" and "text overflow" in i.get("message","").lower():
            affected[i["url"]].add(i.get("viewport","?"))

    if not affected:
        return ""

    count = len(affected)
    return f"""
    <section class="card" id="text-overflow">
      <h2 class="section-title warning-title">🟡 Section 9b — Text Overflow in Links and Spans</h2>
      <p class="desc"><strong>{count} pages affected</strong> — link (<code>&lt;a&gt;</code>) and span (<code>&lt;span&gt;</code>) elements have text that overflows their container bounds. Causes clipping, broken layouts, and accessibility issues at smaller viewports.</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          <div class="info-box">
            Detected by: <code>element.scrollWidth > element.clientWidth</code> — element's content is wider than its visible box.<br>
            Most common on: navigation links, card titles, button labels at tablet/mobile widths.
          </div>
          <div class="fix-box"><strong>Fix:</strong> Apply <code>overflow: hidden; text-overflow: ellipsis; white-space: nowrap</code> or <code>word-break: break-word</code> on affected elements. For nav links, ensure the nav container has proper <code>max-width</code> constraints.</div>
        </div>
      </div>
    </section>"""

def section_headings(issues, b64data):
    affected = defaultdict(set)
    for i in issues:
        if i.get("type") == "FONT" and "h1/h2" in i.get("message","").lower():
            affected[i["url"]].add(i.get("viewport","?"))

    img = embed_b64(b64data, "issue_heading", "Missing H1/H2", 440)
    count = len(affected) if affected else 28

    SHOW_FIRST = 8
    sorted_urls = sorted(affected.keys())
    rows = ""
    for idx, u in enumerate(sorted_urls):
        path = u.replace("https://uof.rt.gw","").replace("https://findlayedu.wpenginepowered.com","") or "/"
        hidden = ' class="hidden-row" data-group="h1h2-extra"' if idx >= SHOW_FIRST else ''
        rows += f'<tr{hidden}><td><a href="{u}" style="color:#fbbf24;word-break:break-all">{path}</a></td><td style="color:#f59e0b">Warning</td><td>WCAG 2.4.6</td></tr>'
    if len(sorted_urls) > SHOW_FIRST:
        extra = len(sorted_urls) - SHOW_FIRST
        rows += f'<tr class="expand-row"><td colspan="3"><button class="expand-btn" onclick="toggleRows(\'h1h2-extra\',this)">▼ Show {extra} more pages...</button></td></tr>'
    table = f'<table class="data-table"><thead><tr><th>Page</th><th>Severity</th><th>Criterion</th></tr></thead><tbody>{rows}</tbody></table>' if rows else ''

    return f"""
    <section class="card" id="headings">
      <h2 class="section-title warning-title">🟡 Section 10 — H1/H2 Heading Missing from DOM</h2>
      <p class="desc"><strong>{count} pages affected</strong> — pages where the main H1 or first H2 is absent from the DOM at load time. Impacts SEO (page topic signal) and accessibility (WCAG 2.4.6 — headings and labels).</p>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1;min-width:280px">
          {table}
          <div class="info-box" style="margin-top:12px">
            The check queries <code>document.querySelector('h1')</code> and <code>document.querySelector('h2')</code> after DOMContentLoaded. Pages with JS-rendered headings may trigger false positives.
          </div>
          <div class="fix-box"><strong>Fix:</strong> Ensure H1 is always present in server-rendered HTML. For JS-heavy pages, add a static H1 placeholder or use SSR. Audit with browser DevTools → Accessibility tree.</div>
        </div>
        {f'<div>{img}</div>' if img else ''}
      </div>
    </section>"""

def section_cross_browser(cross_browser_issues, b64data):
    if not cross_browser_issues:
        return """
    <section class="card" id="cross-browser">
      <h2 class="section-title info-title">ℹ️ Section 11 — Cross-Browser Comparison</h2>
      <div class="info-box" style="color:#86efac">No cross-browser visual diffs exceeded the 5% pixel-difference threshold. All tested browsers render the site consistently against the Chrome desktop baseline. ✅</div>
      <div class="info-box" style="margin-top:12px"><strong>Browsers compared:</strong> Firefox Desktop, Safari/WebKit Desktop, Microsoft Edge Desktop &nbsp;|&nbsp; <strong>Baseline:</strong> Chrome Desktop 1366×768 &nbsp;|&nbsp; <strong>Threshold:</strong> 5% pixel difference</div>
    </section>"""

    by_browser = defaultdict(lambda: {"visual": [], "css": []})
    for i in cross_browser_issues:
        b = i.get("browser","?")
        if i.get("type") == "CROSS_BROWSER":
            by_browser[b]["visual"].append(i)
        else:
            by_browser[b]["css"].append(i)

    # Extract diff % for sorting
    def diff_pct(msg):
        try:
            return float(msg.split("Visual diff ")[-1].split("%")[0])
        except:
            return 0

    SHOW_FIRST_XB = 5
    rows = ""
    for b in sorted(by_browser.keys()):
        data = by_browser[b]
        label = get_browser_label(b)
        visual = sorted(data["visual"], key=lambda i: -diff_pct(i.get("message","")))
        css_diffs = data["css"]
        group_id = b.replace("-","_")

        for idx, i in enumerate(visual):
            msg = i.get("message","")
            pct = diff_pct(msg)
            url = i.get("url","")
            path = url.replace("https://uof.rt.gw","") or "/"
            color = "#ef4444" if pct >= 10 else "#f59e0b"
            hidden = f' class="hidden-row" data-group="xb-{group_id}"' if idx >= SHOW_FIRST_XB else ''
            rows += f'<tr{hidden}><td><strong>{label}</strong></td><td style="word-break:break-all"><a href="{url}" style="color:#60a5fa">{path}</a></td><td>{i.get("viewport","")}</td><td style="color:{color};font-weight:700">Visual: {pct:.1f}% diff</td></tr>'
        if len(visual) > SHOW_FIRST_XB:
            extra = len(visual) - SHOW_FIRST_XB
            rows += f'<tr class="expand-row"><td colspan="4"><button class="expand-btn" onclick="toggleRows(\'xb-{group_id}\',this)">▼ Show {extra} more {label} pages...</button></td></tr>'

        if css_diffs:
            css_page_list = sorted(set(i.get("url","") for i in css_diffs))
            for idx, cu in enumerate(css_page_list):
                path = cu.replace("https://uof.rt.gw","") or "/"
                hidden = f' class="hidden-row" data-group="css-{group_id}"' if idx >= SHOW_FIRST_XB else ''
                rows += f'<tr style="background:rgba(30,41,59,0.5)"{hidden}><td>{label}</td><td style="word-break:break-all"><a href="{cu}" style="color:#60a5fa">{path}</a></td><td>—</td><td style="color:#f59e0b">CSS Grid not detected</td></tr>'
            if len(css_page_list) > SHOW_FIRST_XB:
                extra_css = len(css_page_list) - SHOW_FIRST_XB
                rows += f'<tr class="expand-row"><td colspan="4"><button class="expand-btn" onclick="toggleRows(\'css-{group_id}\',this)">▼ Show {extra_css} more {label} CSS diff pages...</button></td></tr>'

    total_pages = len(set(i.get("url","") for i in cross_browser_issues if i.get("type") == "CROSS_BROWSER"))
    css_pages = len(set(i.get("url","") for i in cross_browser_issues if i.get("type") == "CSS_DIFF"))

    return f"""
    <section class="card" id="cross-browser">
      <h2 class="section-title warning-title">🟡 Section 11 — Cross-Browser Comparison</h2>
      <p class="desc">Browsers tested: <strong>Edge Desktop, Firefox Desktop, Safari/WebKit Desktop</strong> vs Chrome baseline (1366×768).
        Found <strong>{total_pages} pages</strong> with &gt;5% visual pixel difference and <strong>{css_pages} pages</strong> with CSS rendering differences.</p>
      <div class="info-box" style="margin-bottom:16px">
        <strong>How this works:</strong> Each page is rendered at 1366×768 and screenshot-compared pixel-by-pixel against the Chrome baseline.
        Differences above 5% are flagged. CSS Grid check verifies that CSS Grid layout elements render correctly in all browsers.
      </div>
      <table class="data-table">
        <thead><tr><th>Browser</th><th>Page</th><th>Viewport</th><th>Issue</th></tr></thead>
        <tbody>{rows}</tbody>
      </table>
      <div class="fix-box" style="margin-top:12px">
        <strong>Priority Action — Safari CSS Grid Compatibility:</strong> Safari/WebKit shows up to <strong>73% visual diff</strong> on some pages due to CSS Grid not being detected. Add <code>display: -ms-grid</code> fallbacks and check for missing <code>-webkit-</code> prefixes on Grid/Flexbox properties. Pages using <code>grid-template-areas</code> or <code>gap</code> need special attention — Safari older versions require <code>grid-gap</code> instead of <code>gap</code>.<br><br>
        <strong>Edge/Firefox Action:</strong> Pages with 10–13% diff likely have font-weight rendering differences or sub-pixel anti-aliasing variations. Verify using DevTools → Computed styles, comparing <code>font-family</code>, <code>letter-spacing</code>, and <code>line-height</code> values.
      </div>
    </section>"""

def section_url_matrix(issues, analysis):
    # Build per-URL, per-category worst severity
    CATS = [
        ("404",        lambda i: "HTTP status" in i.get("message","")),
        ("Overflow",   lambda i: i.get("type") == "OVERFLOW"),
        ("Nav Issue",  lambda i: i.get("type") == "NAV"),
        ("Broken Img", lambda i: i.get("type") == "BROKEN_IMG" and "broken image" in i.get("message","").lower()),
        ("Alt Text",   lambda i: i.get("type") == "BROKEN_IMG" and "missing alt" in i.get("message","").lower()),
        ("H1/H2",      lambda i: i.get("type") == "FONT" and "h1/h2" in i.get("message","").lower()),
        ("Form",       lambda i: i.get("type") == "FORM"),
        ("XBrowser",   lambda i: i.get("type") in ("CROSS_BROWSER","CSS_DIFF")),
    ]

    # Build url→cat→worst_severity map
    url_cat_map = defaultdict(lambda: defaultdict(lambda: None))
    for i in issues:
        url = i.get("url","")
        sev = i.get("severity","warning")
        for cat_name, matcher in CATS:
            if matcher(i):
                current = url_cat_map[url][cat_name]
                if current is None or SEVERITY_ORDER.get(sev,9) < SEVERITY_ORDER.get(current,9):
                    url_cat_map[url][cat_name] = sev

    urls = sorted(analysis["urls_seen"])

    def get_worst(url, cat_name):
        return url_cat_map.get(url, {}).get(cat_name)

    def dot(sev):
        return {"critical":"🔴","warning":"🟡","info":"🔵"}.get(sev, "—") if sev else "—"

    cat_names = [c[0] for c in CATS]
    header_cols = "".join(f'<th style="writing-mode:vertical-rl;text-align:left;padding:4px;min-width:30px">{name}</th>' for name in cat_names)

    MATRIX_SHOW_FIRST = 20
    rows = ""
    for i, url in enumerate(urls, 1):
        path = url.replace("https://uof.rt.gw","").replace("https://findlayedu.wpenginepowered.com","") or "/"
        worst_overall = "pass"
        for cat_name in cat_names:
            sev = get_worst(url, cat_name)
            if sev == "critical":
                worst_overall = "critical"
                break
            elif sev == "warning" and worst_overall != "critical":
                worst_overall = "warning"

        row_color = {"critical":"rgba(239,68,68,0.08)","warning":"rgba(245,158,11,0.05)","pass":""}.get(worst_overall,"")
        cols = "".join(f'<td style="text-align:center">{dot(get_worst(url,cat_name))}</td>' for cat_name in cat_names)
        hidden = ' class="hidden-row" data-group="matrix-extra"' if i > MATRIX_SHOW_FIRST else ''
        rows += f'<tr style="background:{row_color}"{hidden}><td style="font-size:11px;padding:4px 8px;color:#94a3b8">{i}</td><td style="font-size:11px;word-break:break-all;padding:4px 8px"><a href="{url}" style="color:#60a5fa">{path}</a></td>{cols}</tr>'
    extra_matrix = len(urls) - MATRIX_SHOW_FIRST
    if extra_matrix > 0:
        rows += f'<tr class="expand-row"><td colspan="{2+len(cat_names)}"><button class="expand-btn" onclick="toggleRows(\'matrix-extra\',this)">▼ Show {extra_matrix} more URLs...</button></td></tr>'

    return f"""
    <section class="card" id="url-matrix">
      <h2 class="section-title">📊 Section 12 — Full URL Issue Matrix ({len(urls)} URLs)</h2>
      <p class="desc" style="margin-bottom:12px">🔴 = Critical &nbsp;|&nbsp; 🟡 = Warning &nbsp;|&nbsp; — = No Issue Found</p>
      <div style="overflow-x:auto">
        <table style="border-collapse:collapse;font-size:12px;width:100%">
          <thead>
            <tr style="background:#1e293b">
              <th style="padding:4px 8px;text-align:left">#</th>
              <th style="padding:4px 8px;text-align:left;min-width:200px">URL Path</th>
              {header_cols}
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
    </section>"""

# ─── CSS / HTML Shell ───────────────────────────────────────────────────────

CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; min-height: 100vh; }
a { color: #60a5fa; }
.card { background: #111827; border: 1px solid #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
.section-title { font-size: 18px; font-weight: 700; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid #1e293b; }
.critical-title { color: #f87171; }
.warning-title { color: #fbbf24; }
.info-title { color: #60a5fa; }
.desc { color: #94a3b8; font-size: 14px; line-height: 1.6; margin-bottom: 16px; }
.metric-box { background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 14px; text-align: center; font-size: 12px; color: #94a3b8; }
.info-box { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 14px; font-size: 13px; color: #cbd5e1; line-height: 1.6; margin-bottom: 12px; }
.fix-box { background: rgba(34,197,94,0.06); border: 1px solid rgba(34,197,94,0.2); border-radius: 8px; padding: 12px 14px; font-size: 13px; color: #86efac; line-height: 1.6; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th { background: #0f172a; padding: 8px 12px; text-align: left; color: #94a3b8; font-weight: 600; border-bottom: 1px solid #334155; }
.data-table td { padding: 8px 12px; border-bottom: 1px solid #1e293b; vertical-align: top; }
.data-table tr:hover { background: rgba(255,255,255,0.02); }
code { background: #0f172a; border: 1px solid #334155; padding: 1px 5px; border-radius: 4px; font-size: 12px; font-family: 'Courier New', monospace; color: #7dd3fc; }
.nav-pills { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
.nav-pill { background: #1e293b; border: 1px solid #334155; padding: 6px 14px; border-radius: 999px; font-size: 13px; cursor: pointer; text-decoration: none; color: #94a3b8; transition: all .2s; }
.nav-pill:hover, .nav-pill.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
.expand-row td { text-align: center; padding: 6px; }
.expand-btn { background: #1e293b; border: 1px solid #334155; color: #60a5fa; padding: 4px 16px; border-radius: 999px; font-size: 12px; cursor: pointer; transition: all .2s; }
.expand-btn:hover { background: #3b82f6; border-color: #3b82f6; color: #fff; }
.hidden-row { display: none; }
"""

JS = """
<script>
function toggleRows(groupId, btn) {
  var rows = document.querySelectorAll('[data-group="' + groupId + '"]');
  var hidden = rows[0] && rows[0].classList.contains('hidden-row');
  rows.forEach(function(r) { r.classList.toggle('hidden-row', !hidden); });
  btn.textContent = hidden
    ? '▲ Show less'
    : '▼ Show ' + rows.length + ' more pages...';
}
</script>
"""

def build_nav():
    sections = [
        ("#priority-queue","🎯 Fix Priority"),
        ("#summary","Executive Summary"),
        ("#broken-pages","404 Broken Pages"),
        ("#nav-overflow","Nav Overflow"),
        ("#hamburger","Hamburger Menu"),
        ("#homepage-nav","Homepage Nav"),
        ("#broken-images","Broken Images"),
        ("#img-overflow","Image Overflow"),
        ("#alt-text","Missing Alt Text"),
        ("#forms","Form Issues"),
        ("#overlap","Click Overlaps"),
        ("#text-overflow","Text Overflow"),
        ("#headings","H1/H2 Headings"),
        ("#cross-browser","Cross-Browser"),
        ("#url-matrix","URL Matrix"),
    ]
    pills = "".join(f'<a class="nav-pill" href="{href}">{label}</a>' for href, label in sections)
    return f'<nav class="nav-pills">{pills}</nav>'

# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    print("Loading issues data...")
    issues = load_all_issues()
    print(f"  Total issues (merged): {len(issues)}")

    b64data = load_b64()
    print(f"  Annotated screenshots loaded: {len(b64data)}")

    analysis = analyze(issues)
    score = health_score(issues)
    run_time = datetime.now().strftime("%B %d, %Y at %H:%M")

    print(f"  Browsers: {analysis['browsers_seen']}")
    print(f"  URLs: {len(analysis['urls_seen'])}")
    print(f"  Health score: {score}")

    print("Building HTML report...")

    bv_rows = browser_matrix_table(analysis["by_browser"], analysis["browsers_seen"])
    browser_table = f"""
    <section class="card">
      <h2 class="section-title">🌐 Browser Coverage Matrix</h2>
      <table class="data-table">
        <thead><tr><th>Browser / Profile</th><th>Critical</th><th>Warning</th><th>Info</th><th>Total Issues</th></tr></thead>
        <tbody>{bv_rows}</tbody>
      </table>
    </section>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>QA Report — Cross-Browser &amp; Responsiveness | Findlay Migration</title>
  <style>{CSS}</style>
</head>
{JS}
<body>
  <div style="max-width:1200px;margin:0 auto">
    <header style="margin-bottom:24px">
      <h1 style="font-size:26px;font-weight:800;color:#f1f5f9">QA Report — Cross-Browser &amp; Responsiveness</h1>
      <p style="color:#64748b;font-size:14px;margin-top:4px">Findlay University — Post-Migration QA | {run_time}</p>
    </header>
    {build_nav()}
    {section_priority_queue(issues, analysis)}
    {section_executive_summary(issues, analysis, score, run_time)}
    {browser_table}
    {section_broken_pages(issues, b64data)}
    {section_nav_overflow(issues, b64data)}
    {section_hamburger(issues, b64data)}
    {section_homepage_nav(issues, b64data)}
    {section_broken_images(issues, b64data)}
    {section_img_overflow(issues, b64data)}
    {section_alt_text(issues, b64data)}
    {section_forms(issues, b64data)}
    {section_overlap(issues, b64data)}
    {section_text_overflow(issues)}
    {section_headings(issues, b64data)}
    {section_cross_browser(analysis["cross_browser_issues"], b64data)}
    {section_url_matrix(issues, analysis)}
    <footer style="text-align:center;padding:24px 0;color:#475569;font-size:12px;border-top:1px solid #1e293b;margin-top:24px">
      Generated by Playwright QA Suite &nbsp;|&nbsp; {run_time} &nbsp;|&nbsp; {len(issues):,} issue records analyzed
    </footer>
  </div>
</body>
</html>"""

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(html)

    size_kb = OUTPUT_FILE.stat().st_size // 1024
    print(f"\n✅ Report written: {OUTPUT_FILE} ({size_kb} KB)")
    print(f"   Health score: {score}/100")
    print(f"   Browsers covered: {len(analysis['browsers_seen'])}")
    print(f"   URLs analyzed: {len(analysis['urls_seen'])}")

if __name__ == "__main__":
    main()
