from __future__ import annotations

import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
report_json = ROOT / "reports" / "qa-report.json"
out_html = ROOT / "reports" / "qa-issues-detail.html"

if not report_json.exists():
    raise SystemExit(f"Missing input: {report_json}")

data = json.loads(report_json.read_text(encoding="utf-8"))
issues = data.get("issues", [])
generated = data.get("generatedAt", "")

rows = []
for idx, issue in enumerate(issues, start=1):
    url = html.escape(str(issue.get("url", "")))
    issue_type = html.escape(str(issue.get("type", "")))
    severity = html.escape(str(issue.get("severity", "")))
    browser = html.escape(str(issue.get("browser", "")))
    viewport = html.escape(str(issue.get("viewport", "")))
    message = html.escape(str(issue.get("message", "")))
    selector = html.escape(str(issue.get("selector", "")))
    screenshot_path = str(issue.get("screenshotPath", "") or "").strip()
    screenshot = html.escape(screenshot_path)
    file_url = Path(screenshot_path).resolve().as_uri() if screenshot_path else ""
    screenshot_link = f'<a href="{file_url}" target="_blank">open</a>' if file_url else ""
    screenshot_img = f'<img src="{file_url}" alt="issue screenshot" loading="lazy" style="max-width:220px;max-height:140px;border:1px solid #334155;border-radius:4px" />' if file_url else ""

    rows.append(
        f"<tr data-severity='{severity.lower()}' data-type='{issue_type.lower()}' data-url='{url.lower()}'>"
        f"<td>{idx}</td>"
        f"<td>{severity}</td>"
        f"<td>{issue_type}</td>"
        f"<td>{browser}</td>"
        f"<td>{viewport}</td>"
        f"<td>{url}</td>"
        f"<td>{message}</td>"
        f"<td>{selector}</td>"
        f"<td>{screenshot}</td>"
        f"<td>{screenshot_link}</td>"
        f"<td>{screenshot_img}</td>"
        "</tr>"
    )

html_doc = f"""<!doctype html>
<html>
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>QA Issues Detail</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 16px; background: #0f172a; color: #e2e8f0; }}
    h1 {{ margin: 0 0 8px; }}
    .meta {{ color: #94a3b8; margin-bottom: 12px; }}
    .controls {{ display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }}
    input, select {{ padding: 8px; border-radius: 6px; border: 1px solid #334155; background: #111827; color: #e2e8f0; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
    th, td {{ border: 1px solid #334155; padding: 6px; text-align: left; vertical-align: top; }}
    th {{ position: sticky; top: 0; background: #1e293b; }}
    tr.critical {{ background: #3f1d1d; }}
    tr.warning {{ background: #3b2a1b; }}
    tr.info {{ background: #1e293b; }}
    a {{ color: #93c5fd; }}
  </style>
</head>
<body>
  <h1>QA Issues Detail Report</h1>
  <div class=\"meta\">Generated: {html.escape(generated)} | Total issues: {len(issues)}</div>

  <div class=\"controls\">
    <input id=\"q\" placeholder=\"Search URL/message/type\" />
    <select id=\"sev\">
      <option value=\"\">All severities</option>
      <option value=\"critical\">critical</option>
      <option value=\"warning\">warning</option>
      <option value=\"info\">info</option>
    </select>
    <select id=\"typ\">
      <option value=\"\">All types</option>
    </select>
  </div>

  <table id=\"t\">
    <thead>
      <tr>
        <th>#</th><th>Severity</th><th>Type</th><th>Browser</th><th>Viewport</th><th>URL</th><th>Message</th><th>Selector</th><th>Screenshot Path</th><th>Screenshot</th><th>Preview</th>
      </tr>
    </thead>
    <tbody>
      {''.join(rows)}
    </tbody>
  </table>

  <script>
    const q = document.getElementById('q');
    const sev = document.getElementById('sev');
    const typ = document.getElementById('typ');
    const rows = [...document.querySelectorAll('#t tbody tr')];

    const typeSet = new Set();
    rows.forEach(r => typeSet.add(r.children[2].textContent.toLowerCase()));
    [...typeSet].sort().forEach(v => {{
      const o = document.createElement('option');
      o.value = v; o.textContent = v; typ.appendChild(o);
    }});

    rows.forEach(r => r.classList.add(r.children[1].textContent.toLowerCase()));

    function apply() {{
      const qq = q.value.toLowerCase();
      const ss = sev.value;
      const tt = typ.value;
      rows.forEach(r => {{
        const text = r.textContent.toLowerCase();
        const okQ = !qq || text.includes(qq);
        const okS = !ss || r.children[1].textContent.toLowerCase() === ss;
        const okT = !tt || r.children[2].textContent.toLowerCase() === tt;
        r.style.display = (okQ && okS && okT) ? '' : 'none';
      }});
    }}

    q.addEventListener('input', apply);
    sev.addEventListener('change', apply);
    typ.addEventListener('change', apply);
  </script>
</body>
</html>
"""

out_html.write_text(html_doc, encoding="utf-8")
print(out_html)
