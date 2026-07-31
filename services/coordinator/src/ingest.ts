/**
 * CSV ingestion.
 *
 * Two independent requirements pull in opposite directions, and the design
 * satisfies both:
 *
 *   "should not load the whole file into memory"  -> STREAM the read
 *   2,500 (or 50,000,000) rows must load quickly  -> BATCH the writes
 *
 * So: stream row by row, buffer a fixed number, flush them as one multi-row
 * INSERT, repeat. Memory stays flat whether the file is 83KB or 8GB, while
 * round trips drop by ~500x.
 *
 * WHY THE BATCH SIZE IS A CONSTANT AND NOT "THE WHOLE FILE":
 *   1. The batch size IS the memory ceiling. "Batch everything" re-introduces
 *      the exact problem streaming solves.
 *   2. MySQL rejects any statement over max_allowed_packet (64MB default).
 *   3. Prepared statements carry their parameter count in 16 bits, so 65,535
 *      placeholders is a hard cap. 6 columns x 500 rows = 3,000. Comfortable.
 *   4. Small batches commit progressively, so a crash loses one batch instead
 *      of rolling back the entire file.
 *   And the payoff curve is flat: 1 -> 500 removes 99.8% of round trips;
 *   500 -> 2,500 removes another 0.16%.
 */

import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import type { Pool } from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2/promise';
import type { Logger } from '@saga/shared';

export interface IngestResult {
  rowsRead: number;
  rowsInserted: number;
  rowsSkipped: number;
}

interface OrderRow {
  order_id: string;
  sku: string;
  qty: string;
  amount: string;
  fail_at: string;
  comp_fail_at: string;
}

const COLUMNS_PER_ROW = 7;

async function flush(pool: Pool, batch: unknown[][]): Promise<number> {
  if (batch.length === 0) return 0;

  // One multi-row INSERT: VALUES (?,?,?,?,?,?,?),(?,?,?,?,?,?,?),...
  const placeholders = batch.map(() => `(${'?,'.repeat(COLUMNS_PER_ROW - 1)}?)`).join(',');

  // INSERT IGNORE + UNIQUE(order_id) is what makes re-loading the same file a
  // no-op instead of a duplicate. The guarantee lives in the database, so it
  // holds even if two people run the ingest at the same time.
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT IGNORE INTO saga_orders
       (order_id, sku, qty, amount, fail_at, comp_fail_at, source_batch)
     VALUES ${placeholders}`,
    batch.flat(),
  );

  return result.affectedRows;
}

export async function ingestOrders(
  pool: Pool,
  filePath: string,
  logger: Logger,
  options: { batchSize: number; batchId?: string },
): Promise<IngestResult> {
  const batchId = options.batchId ?? `ingest-${Date.now()}`;
  const startedAt = Date.now();

  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      // The provided files use CRLF line endings. Without `trim`, every row's
      // last column arrives as "REFUND_PAYMENT\r" — which never equals
      // "REFUND_PAYMENT", so fault injection silently never fires and you get
      // 2,500 successful orders and a false sense of correctness.
      trim: true,
      skip_empty_lines: true,
    }),
  );

  let batch: unknown[][] = [];
  let rowsRead = 0;
  let rowsInserted = 0;

  for await (const raw of parser) {
    const row = raw as OrderRow;
    rowsRead++;

    batch.push([
      row.order_id,
      row.sku,
      Number(row.qty),
      // amount stays a STRING all the way into DECIMAL. Passing it through
      // Number() here would be the one place cents could quietly go missing.
      row.amount,
      row.fail_at || null,
      row.comp_fail_at || null,
      batchId,
    ]);

    if (batch.length >= options.batchSize) {
      rowsInserted += await flush(pool, batch);
      batch = []; // release the buffer — this is what keeps memory flat
    }
  }

  rowsInserted += await flush(pool, batch);

  const result: IngestResult = {
    rowsRead,
    rowsInserted,
    rowsSkipped: rowsRead - rowsInserted,
  };

  logger.info('ingest complete', {
    ...result,
    batchId,
    durationMs: Date.now() - startedAt,
    // rowsSkipped > 0 on a re-load is the CORRECT outcome, not an error:
    // it means UNIQUE(order_id) did its job.
    note: result.rowsSkipped > 0 ? 'skipped rows already existed (re-load is a no-op)' : undefined,
  });

  return result;
}
