import fs from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';
import { resetRuntimeState } from './reporter';

/**
 * Prepare runtime/report folders before test execution.
 */
async function globalSetup(_config: FullConfig): Promise<void> {
  const dirs = ['reports', 'screenshots', 'test-results'];
  for (const dir of dirs) {
    const absolute = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(absolute)) fs.mkdirSync(absolute, { recursive: true });
  }
  resetRuntimeState();
}

export default globalSetup;
