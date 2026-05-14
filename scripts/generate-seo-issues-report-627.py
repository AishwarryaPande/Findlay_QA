import csv
import json
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_FILE = ROOT / "uof-urls-627.csv"
OUTPUT_FILE = ROOT / "reports" / "seo-issues-report-627.csv"

PATTERNS = [
    "unlighthouse-627-chunks/chunk-*/ci-result.json",
    "unlighthouse-627-retry/retry-*/ci-result.json",
]


def load_expected_urls(path: Path) -> list[str]:
    return [
        line.strip()
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines()
        if line.strip()
    ]


def to_path(url: str) -> str:
    parsed = urlparse(url)
    p = parsed.path or "/"
    if not p.startswith("/"):
        p = "/" + p
    if parsed.query:
        p = f"{p}?{parsed.query}"
    return p


def lookup_variants(path: str) -> list[str]:
    out = [path]
    if "?" in path:
        p, q = path.split("?", 1)
        if p != "/":
            out.append(f"{p.rstrip('/')}?{q}" if p.endswith("/") else f"{p + '/'}?{q}")
    else:
        if path != "/":
            out.append(path.rstrip("/") if path.endswith("/") else path + "/")

    deduped: list[str] = []
    seen = set()
    for v in out:
        if v not in seen:
            seen.add(v)
            deduped.append(v)
    return deduped


def build_merged_map(root: Path) -> dict[str, dict]:
    merged: dict[str, dict] = {}
    reports_root = root / "reports"

    for pattern in PATTERNS:
        for result_file in sorted(reports_root.glob(pattern)):
            try:
                data = json.loads(result_file.read_text(encoding="utf-8", errors="ignore"))
            except Exception:
                continue
            if not isinstance(data, list):
                continue

            for row in data:
                if not isinstance(row, dict):
                    continue
                path = row.get("path")
                if not path or path in merged:
                    continue
                merged[path] = row

    return merged


def main() -> None:
    expected_urls = load_expected_urls(EXPECTED_FILE)
    merged_by_path = build_merged_map(ROOT)

    issue_rows: list[dict[str, str]] = []

    for url in expected_urls:
        derived_path = to_path(url)

        matched = None
        matched_path = None
        for candidate in lookup_variants(derived_path):
            if candidate in merged_by_path:
                matched = merged_by_path[candidate]
                matched_path = candidate
                break

        if matched is None:
            issue_rows.append(
                {
                    "url": url,
                    "path": derived_path,
                    "seo_score": "",
                    "issue_type": "NOT_SCANNED",
                    "issue_severity": "high",
                }
            )
            continue

        try:
            seo = float(matched.get("seo"))
        except Exception:
            seo = None

        if seo is None or seo < 0.6:
            issue_rows.append(
                {
                    "url": url,
                    "path": matched_path or derived_path,
                    "seo_score": "" if seo is None else f"{seo:.3f}",
                    "issue_type": "SEO_LOW",
                    "issue_severity": "high",
                }
            )
        elif seo < 0.8:
            issue_rows.append(
                {
                    "url": url,
                    "path": matched_path or derived_path,
                    "seo_score": f"{seo:.3f}",
                    "issue_type": "SEO_NEEDS_IMPROVEMENT",
                    "issue_severity": "medium",
                }
            )

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_FILE.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["url", "path", "seo_score", "issue_type", "issue_severity"],
        )
        writer.writeheader()
        writer.writerows(issue_rows)

    print(f"EXPECTED_URL_COUNT={len(expected_urls)}")
    print(f"MERGED_SCANNED_PATH_COUNT={len(merged_by_path)}")
    print(f"ISSUE_ROW_COUNT={len(issue_rows)}")
    print(f"CSV_PATH={OUTPUT_FILE}")


if __name__ == "__main__":
    main()
