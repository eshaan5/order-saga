-- ---------------------------------------------------------------------------
-- 01-saga.sql — the coordinator's own schema.
--
-- This is simultaneously three things:
--   1. the work queue      (claimed via SELECT ... FOR UPDATE SKIP LOCKED)
--   2. the saga state      (which orders are where in their lifecycle)
--   3. the audit trail     (requirement 8 — follow one order start to finish)
-- ---------------------------------------------------------------------------

USE saga;

-- ---------------------------------------------------------------------------
-- saga_orders — one row per CSV row. The unit of work.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga_orders (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Business key, straight from the CSV. UNIQUE below is what makes
  -- re-loading the same file a no-op instead of a duplicate.
  order_id          VARCHAR(64)     NOT NULL,

  sku               VARCHAR(64)     NOT NULL,
  qty               INT             NOT NULL,
  -- DECIMAL, never FLOAT. Money in binary floating point loses cents.
  -- Note: mysql2 returns this to Node as a *string* to protect the precision.
  amount            DECIMAL(12,2)   NOT NULL,

  -- Deliberate fault injection, carried from the CSV and passed to the
  -- services on each call so they can fail on purpose.
  fail_at           VARCHAR(32)     NULL,
  comp_fail_at      VARCHAR(32)     NULL,

  status            ENUM(
                      'PENDING',          -- ingested, not yet claimed
                      'IN_PROGRESS',      -- a coordinator holds the lease
                      'PLACED',           -- all four forward steps succeeded
                      'COMPENSATING',     -- a step failed, undoing the rest
                      'CANCELLED',        -- cleanly undone
                      'NEEDS_ATTENTION',  -- a compensation exhausted its retries
                      'SHIPPED'           -- set only by a human via the UI
                    ) NOT NULL DEFAULT 'PENDING',

  -- How many times a coordinator has picked this order up (not per-step
  -- retries — those live in saga_steps.attempts).
  attempt_count     INT UNSIGNED    NOT NULL DEFAULT 0,

  -- ---- claim + lease -------------------------------------------------------
  -- lease_owner is for humans ("which instance is stuck on this?") and doubles
  -- as a fencing token: writes are guarded WHERE lease_owner = me, so a zombie
  -- worker that wakes up after its lease expired updates zero rows.
  -- lease_expires_at is what actually provides correctness + crash recovery.
  lease_owner       VARCHAR(64)     NULL,
  lease_expires_at  DATETIME(3)     NULL,

  last_error        TEXT            NULL,
  source_batch      VARCHAR(64)     NULL,   -- which ingest run brought it in

  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                            ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),

  -- Requirement: "re-loading the same file does not create duplicate orders."
  -- Enforced by the database, not by app code, so it holds across N instances.
  UNIQUE KEY uq_saga_orders_order_id (order_id),

  -- Serves the claim query:
  --   WHERE status='PENDING' OR (status='IN_PROGRESS' AND lease_expires_at < NOW(3))
  -- Composite indexes read left to right, so `status` (exact match) comes
  -- first and `lease_expires_at` (range scan) second.
  KEY idx_claim (status, lease_expires_at),

  -- Serves the UI list: WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?
  KEY idx_status_id (status, id)
) ENGINE=InnoDB;


-- ---------------------------------------------------------------------------
-- saga_steps — one row per (order, step). THE SOURCE OF TRUTH for compensation.
--
-- Because the four steps run in parallel, when one fails we cannot infer which
-- others completed from ordering. We read it from here instead:
--   "compensate step X if and only if its FORWARD row is SUCCEEDED."
-- That is requirement 3's "only steps that actually finished are undone."
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga_steps (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id          VARCHAR(64)     NOT NULL,

  -- All eight operation names, matching the CSV's fail_at / comp_fail_at
  -- vocabulary exactly so the audit trail reads the same as the input data.
  step              ENUM(
                      'CREATE_ORDER',      'RESERVE_INVENTORY',
                      'CHARGE_PAYMENT',    'CREATE_SHIPMENT',
                      'CANCEL_ORDER',      'RELEASE_INVENTORY',
                      'REFUND_PAYMENT',    'CANCEL_SHIPMENT'
                    ) NOT NULL,

  kind              ENUM('FORWARD','COMPENSATION') NOT NULL,

  status            ENUM(
                      'PENDING',    -- row created, not started
                      'RUNNING',    -- in flight
                      'SUCCEEDED',
                      'FAILED',     -- retries exhausted
                      'SKIPPED'     -- compensation not needed (forward never succeeded)
                    ) NOT NULL DEFAULT 'PENDING',

  attempts          INT UNSIGNED    NOT NULL DEFAULT 0,

  -- Deterministic: "{order_id}:{step}". Identical on every retry — that is the
  -- entire reason a lost/slow reply can't cause a double charge.
  idempotency_key   VARCHAR(160)    NOT NULL,

  last_error        TEXT            NULL,
  started_at        DATETIME(3)     NULL,
  finished_at       DATETIME(3)     NULL,

  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                            ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),

  -- One row per step per order. Lets the coordinator use
  -- INSERT ... ON DUPLICATE KEY UPDATE to create-or-bump in one round trip,
  -- with no read-then-write race.
  UNIQUE KEY uq_order_step (order_id, step),

  KEY idx_order_kind (order_id, kind, status),

  CONSTRAINT fk_steps_order
    FOREIGN KEY (order_id) REFERENCES saga_orders (order_id)
    ON DELETE CASCADE
) ENGINE=InnoDB;


-- ---------------------------------------------------------------------------
-- saga_step_attempts — one row per individual try. Requirement 8's
-- "record what ran, when, whether it succeeded or failed, and any retries."
--
-- saga_steps.attempts tells you *how many* tries; this table tells you what
-- happened on each one, which is what makes a single order followable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saga_step_attempts (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id          VARCHAR(64)     NOT NULL,
  step              VARCHAR(32)     NOT NULL,
  attempt_no        INT UNSIGNED    NOT NULL,

  outcome           ENUM('SUCCEEDED','FAILED','TIMEOUT') NOT NULL,
  http_status       INT             NULL,
  error_message     TEXT            NULL,
  duration_ms       INT UNSIGNED    NULL,

  started_at        DATETIME(3)     NOT NULL,
  finished_at       DATETIME(3)     NOT NULL,

  PRIMARY KEY (id),
  KEY idx_order_step (order_id, step, attempt_no)
) ENGINE=InnoDB;
