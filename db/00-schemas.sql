-- ---------------------------------------------------------------------------
-- 00-schemas.sql
--
-- Six logical databases, one MySQL server. In MySQL "database" and "schema"
-- are the same thing (CREATE DATABASE == CREATE SCHEMA), so one schema per
-- service IS one database per service.
--
-- Each service connects only to its own schema and can never read another's
-- tables. Running them on one server is a deployment convenience -- splitting
-- to separate servers later is a connection-string change, nothing more.
--
-- CHARACTER SET = which characters can be stored and how they're encoded.
-- COLLATE       = the rules for comparing and sorting them.
--
-- utf8mb4, never utf8: MySQL's charset literally named "utf8" is NOT UTF-8.
-- It caps at 3 bytes per character, so it silently cannot store emoji or much
-- of CJK. It is deprecated and aliased to utf8mb3. utf8mb4 is the real thing.
--
-- utf8mb4_0900_ai_ci  ->  utf8mb4 charset
--                         Unicode Collation Algorithm v9.0.0
--                         ai = accent insensitive ('e' == 'é')
--                         ci = case insensitive   ('a' == 'A')
--
-- This is already MySQL 8's default; stating it explicitly is documentation,
-- so behaviour doesn't drift if a server is configured differently. Case
-- insensitivity is mildly helpful here: a CSV with inconsistent casing still
-- dedupes to one order rather than two.
-- ---------------------------------------------------------------------------

CREATE DATABASE IF NOT EXISTS saga
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS svc_order
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS svc_inventory
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS svc_payment
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS svc_shipping
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE DATABASE IF NOT EXISTS svc_notification
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- One app user with access to all six.
--
-- 'saga'@'%'  ->  user 'saga', connecting from any host. The '%' wildcard is
-- required because each service runs in its own container, so connections
-- arrive from a container IP rather than localhost.
--
-- No FLUSH PRIVILEGES needed: CREATE USER / GRANT / REVOKE update both the
-- on-disk grant tables and MySQL's in-memory cache. FLUSH is only required
-- after editing the mysql.* tables directly with raw INSERT/UPDATE, which is
-- an old practice that survives in tutorials as copy-paste habit.
--
-- TRADEOFF (documented in README): in production each service would get its
-- own credentials scoped to its own schema, making "a service cannot read
-- another service's data" enforced rather than merely intended. One shared
-- user is used here so `docker compose up` needs no manual setup.
-- ---------------------------------------------------------------------------
CREATE USER IF NOT EXISTS 'saga'@'%' IDENTIFIED BY 'saga';

GRANT ALL PRIVILEGES ON saga.*             TO 'saga'@'%';
GRANT ALL PRIVILEGES ON svc_order.*        TO 'saga'@'%';
GRANT ALL PRIVILEGES ON svc_inventory.*    TO 'saga'@'%';
GRANT ALL PRIVILEGES ON svc_payment.*      TO 'saga'@'%';
GRANT ALL PRIVILEGES ON svc_shipping.*     TO 'saga'@'%';
GRANT ALL PRIVILEGES ON svc_notification.* TO 'saga'@'%';
