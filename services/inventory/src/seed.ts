/**
 * Seed svc_inventory from data/sample_inventory.csv.
 *
 *   npm run seed -w @saga/inventory
 *
 * Idempotent: re-running resets stock to the file's values rather than adding
 * to them, so you can reseed between bulk runs without drift.
 */

import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'csv-parse';
import { createPool, createLogger } from '@saga/shared';

const logger = createLogger('inventory-seed');
const pool = createPool('svc_inventory');

const csvPath = resolve(__dirname, '../../../data/sample_inventory.csv');

async function main(): Promise<void> {
  const parser = createReadStream(csvPath).pipe(
    parse({
      columns: true,
      // The provided CSVs use CRLF line endings. `trim` strips the stray \r
      // that would otherwise glue itself to the last column of every row.
      trim: true,
      skip_empty_lines: true,
    }),
  );

  let count = 0;
  for await (const row of parser) {
    const sku = String(row.sku);
    const qty = Number(row.available_qty);

    // ON DUPLICATE KEY UPDATE makes reseeding a reset, not an increment.
    await pool.execute(
      `INSERT INTO inventory (sku, available_qty, reserved_qty)
       VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE available_qty = VALUES(available_qty), reserved_qty = 0`,
      [sku, qty],
    );
    count++;
  }

  logger.info('inventory seeded', { skus: count, source: csvPath });
  await pool.end();
}

main().catch((err) => {
  logger.error('seed failed', { error: err });
  process.exit(1);
});
