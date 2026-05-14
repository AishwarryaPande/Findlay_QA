import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_URLS_FILE = path.resolve(process.cwd(), 'content-audit-urls.txt');

function resolveUrlsFilePath(): string {
  const envPath = process.env.URLS_FILE?.trim();
  if (!envPath) return DEFAULT_URLS_FILE;
  return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
}

function resolveMaxUrls(): number | null {
  const raw = process.env.MAX_URLS?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/**
 * Normalize URL for stable dedupe/comparison.
 */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    return parsed.toString().replace(/\s+/g, '');
  } catch {
    return null;
  }
}

/**
 * Parse, clean, and deduplicate URL lines.
 */
export function cleanAndDedupeUrls(lines: string[]): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    const normalized = normalizeUrl(line);
    if (!normalized) continue;
    seen.add(normalized);
  }
  return [...seen];
}

/**
 * Load URLs from file to avoid hardcoding large URL payloads in source.
 */
export function loadUrlsFromFile(filePath: string = DEFAULT_URLS_FILE): string[] {
  if (!fs.existsSync(filePath)) {
    return ['https://findlayedu.wpenginepowered.com/'];
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const deduped = cleanAndDedupeUrls(lines);
  const maxUrls = resolveMaxUrls();
  return maxUrls ? deduped.slice(0, maxUrls) : deduped;
}

/**
 * Typed URL constant used by all tests.
 */
export const TEST_URLS: readonly string[] = loadUrlsFromFile(resolveUrlsFilePath());
