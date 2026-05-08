#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const csvArg = process.argv[2];
const inputCsv = csvArg
  ? path.resolve(process.cwd(), csvArg)
  : path.join(projectRoot, 'wp-urls-public.csv');
const outputTxt = path.join(projectRoot, 'content-audit-urls.txt');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out;
}

function extractUrlFromRow(columns) {
  for (const col of columns) {
    const value = String(col || '').trim();
    if (/^https?:\/\//i.test(value)) {
      return value;
    }
  }
  return null;
}

if (!fs.existsSync(inputCsv)) {
  console.error(`❌ Missing file: ${inputCsv}`);
  console.error('Provide CSV path as argument, e.g. node scripts/prepare-content-audit-input.js /path/to/wp-urls-public.csv');
  process.exit(1);
}

const lines = fs.readFileSync(inputCsv, 'utf8').split(/\r?\n/).filter(Boolean);
const urls = [];

for (const line of lines) {
  const cols = parseCsvLine(line);
  const url = extractUrlFromRow(cols);
  if (url) urls.push(url.trim());
}

fs.writeFileSync(outputTxt, `${urls.join('\n')}\n`, 'utf8');
console.log(`✅ Created ${outputTxt}`);
console.log(`ℹ️ Source CSV: ${inputCsv}`);
console.log(`ℹ️ Total URLs written: ${urls.length}`);
