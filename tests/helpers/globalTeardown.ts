import type { FullConfig } from '@playwright/test';
import { generateReports } from './reporter';

/**
 * Finalize report generation after all tests complete.
 */
async function globalTeardown(_config: FullConfig): Promise<void> {
  generateReports();
}

export default globalTeardown;
