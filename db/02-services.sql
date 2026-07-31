-- ---------------------------------------------------------------------------
-- 02-services.sql — the four worker services + the notification service.
--
-- Each owns its own schema. No service reads another's tables; anything they
-- need from each other travels over HTTP.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- THE SHARED IDEMPOTENCY PATTERN
-- ===========================================================================
-- Every one of the four services gets an identical `idempotency_records`
-- table. This is what satisfies requirement 5: "never do a step twice -- even
-- after a retry or a slow/lost reply from a service."
--
-- The flow inside a service, for every do/undo operation:
--
--   1. INSERT the key with status='IN_PROGRESS'.
--        - duplicate key error?  -> SELECT the existing row:
--            status='COMPLETED'   -> return the stored response_json (200)
--            status='IN_PROGRESS' -> another instance is mid-flight, return 409
--                                    and let the coordinator retry
--   2. Do the real work AND flip the record to 'COMPLETED' in the SAME
--      transaction, so it is impossible to have done the work without
--      recording that we did.
--
-- Why status matters: if we only stored completed operations, two concurrent
-- requests with the same key would both find nothing and both execute. The
-- IN_PROGRESS marker closes that window.
--
-- The PRIMARY KEY is the idempotency key itself -- no surrogate id. In InnoDB
-- the PK is a clustered index (rows physically ordered by it), so lookup by
-- key is a single seek with no secondary-index hop.
-- ===========================================================================


-- ===========================================================================
-- ORDER SERVICE
-- ===========================================================================
USE svc_order;

CREATE TABLE IF NOT EXISTS orders (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id      VARCHAR(64)     NOT NULL,
  sku           VARCHAR(64)     NOT NULL,
  qty           INT             NOT NULL,
  amount        DECIMAL(12,2)   NOT NULL,
  status        ENUM('CREATED','CANCELLED') NOT NULL DEFAULT 'CREATED',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at  DATETIME(3)     NULL,
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                        ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- Second line of defence alongside the idempotency key: even a bug in key
  -- generation cannot produce two order records for one order_id.
  UNIQUE KEY uq_orders_order_id (order_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key VARCHAR(160) NOT NULL,
  operation       VARCHAR(32)  NOT NULL,
  order_id        VARCHAR(64)  NOT NULL,
  status          ENUM('IN_PROGRESS','COMPLETED') NOT NULL DEFAULT 'IN_PROGRESS',
  response_json   JSON         NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at    DATETIME(3)  NULL,
  PRIMARY KEY (idempotency_key),
  KEY idx_order (order_id)
) ENGINE=InnoDB;


-- ===========================================================================
-- INVENTORY SERVICE
-- ===========================================================================
USE svc_inventory;

-- Seeded from data/sample_inventory.csv (10 SKUs x 50,000 units).
CREATE TABLE IF NOT EXISTS inventory (
  sku           VARCHAR(64)  NOT NULL,
  available_qty INT          NOT NULL,
  reserved_qty  INT          NOT NULL DEFAULT 0,
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (sku)
) ENGINE=InnoDB;

-- Reserving is ONE atomic statement, never read-then-write:
--
--   UPDATE inventory
--   SET available_qty = available_qty - :qty,
--       reserved_qty  = reserved_qty  + :qty
--   WHERE sku = :sku AND available_qty >= :qty;
--
-- affectedRows = 0 means insufficient stock. Because the check (`>= :qty`)
-- and the decrement happen in the same statement, two concurrent orders can
-- never both pass the check and oversell. It's a compare-and-swap in SQL.
CREATE TABLE IF NOT EXISTS reservations (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id     VARCHAR(64)     NOT NULL,
  sku          VARCHAR(64)     NOT NULL,
  qty          INT             NOT NULL,
  status       ENUM('RESERVED','RELEASED') NOT NULL DEFAULT 'RESERVED',
  reserved_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  released_at  DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reservations_order_id (order_id),
  KEY idx_sku_status (sku, status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key VARCHAR(160) NOT NULL,
  operation       VARCHAR(32)  NOT NULL,
  order_id        VARCHAR(64)  NOT NULL,
  status          ENUM('IN_PROGRESS','COMPLETED') NOT NULL DEFAULT 'IN_PROGRESS',
  response_json   JSON         NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at    DATETIME(3)  NULL,
  PRIMARY KEY (idempotency_key),
  KEY idx_order (order_id)
) ENGINE=InnoDB;


-- ===========================================================================
-- PAYMENT SERVICE
-- ===========================================================================
USE svc_payment;

-- NOTE: a real payment system would be an append-only ledger -- a CHARGE row
-- and later a separate REFUND row, never a mutated status -- because you must
-- be able to prove what happened and when. A status flip is used here for
-- clarity; the timestamps preserve enough history for the audit trail.
CREATE TABLE IF NOT EXISTS payments (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id     VARCHAR(64)     NOT NULL,
  amount       DECIMAL(12,2)   NOT NULL,
  status       ENUM('CHARGED','REFUNDED') NOT NULL DEFAULT 'CHARGED',
  charged_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  refunded_at  DATETIME(3)     NULL,
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                       ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_order_id (order_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key VARCHAR(160) NOT NULL,
  operation       VARCHAR(32)  NOT NULL,
  order_id        VARCHAR(64)  NOT NULL,
  status          ENUM('IN_PROGRESS','COMPLETED') NOT NULL DEFAULT 'IN_PROGRESS',
  response_json   JSON         NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at    DATETIME(3)  NULL,
  PRIMARY KEY (idempotency_key),
  KEY idx_order (order_id)
) ENGINE=InnoDB;


-- ===========================================================================
-- SHIPPING SERVICE
-- ===========================================================================
USE svc_shipping;

CREATE TABLE IF NOT EXISTS shipments (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id      VARCHAR(64)     NOT NULL,
  tracking_no   VARCHAR(64)     NULL,
  status        ENUM('CREATED','CANCELLED') NOT NULL DEFAULT 'CREATED',
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at  DATETIME(3)     NULL,
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                        ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_shipments_order_id (order_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key VARCHAR(160) NOT NULL,
  operation       VARCHAR(32)  NOT NULL,
  order_id        VARCHAR(64)  NOT NULL,
  status          ENUM('IN_PROGRESS','COMPLETED') NOT NULL DEFAULT 'IN_PROGRESS',
  response_json   JSON         NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at    DATETIME(3)  NULL,
  PRIMARY KEY (idempotency_key),
  KEY idx_order (order_id)
) ENGINE=InnoDB;


-- ===========================================================================
-- NOTIFICATION SERVICE
-- ===========================================================================
USE svc_notification;

-- Exactly one notification per shipped order, even though the job runs every
-- 15 minutes forever and multiple instances run at once.
--
-- The guarantee is UNIQUE(order_id) plus a claim-then-send flow:
--
--   1. INSERT IGNORE INTO notifications (order_id, status, claimed_by, claimed_at)
--        affectedRows = 1  -> I claimed it, I send it
--        affectedRows = 0  -> another instance owns it, skip
--   2. send (for this assignment: record that one was sent)
--   3. UPDATE ... SET status='SENT', sent_at=NOW(3)
--
-- Crash between 1 and 3 leaves a row stuck in CLAIMED. A recovery sweep
-- reclaims anything CLAIMED older than the stale threshold -- the same
-- claim/lease pattern as saga_orders, owned by notification instances instead
-- of coordinators. "Never missed" comes from the sweep; "never twice" comes
-- from the unique key.
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id    VARCHAR(64)     NOT NULL,
  status      ENUM('CLAIMED','SENT','FAILED') NOT NULL DEFAULT 'CLAIMED',
  claimed_by  VARCHAR(64)     NULL,
  claimed_at  DATETIME(3)     NULL,
  sent_at     DATETIME(3)     NULL,
  attempts    INT UNSIGNED    NOT NULL DEFAULT 0,
  last_error  TEXT            NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- THE exactly-once guarantee.
  UNIQUE KEY uq_notifications_order_id (order_id),
  -- Serves the stale-claim recovery sweep.
  KEY idx_status_claimed (status, claimed_at)
) ENGINE=InnoDB;
