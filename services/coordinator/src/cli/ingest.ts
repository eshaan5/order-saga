/**
 * Standalone CSV loader.
 *
 *   npm run ingest -w @saga/coordinator                 # default file
 *   npm run ingest -w @saga/coordinator -- path/to.csv  # explicit file
 *
 * Safe to run twice: UNIQUE(order_id) + INSERT IGNORE means the second run
 * inserts nothing and reports every row as skipped.
 */

import { resolve } from 'node:path';
import { createLogger, createPool } from '@saga/shared';
import { config } from '../config';
import { ingestOrders } from '../ingest';

const logger = createLogger('ingest');
const pool = createPool('saga');

const fileArg = process.argv[2];
const filePath = fileArg
  ? resolve(process.cwd(), fileArg)
  : resolve(__dirname, '../../../../data/orders_bulk.csv');

async function main(): Promise<void> {
  const result = await ingestOrders(pool, filePath, logger, {
    batchSize: config.ingestBatchSize,
  });
  await pool.end();

  if (result.rowsSkipped > 0 && result.rowsInserted === 0) {
    logger.info('nothing new — this file was already loaded');
  }
}

main().catch((err) => {
  logger.error('ingest failed', { error: err });
  process.exit(1);
});
