-- ============================================================
-- UCCs tool — Turso schema
-- One row per equipment line item (mirrors raw UCC export)
-- ============================================================

CREATE TABLE IF NOT EXISTS ucc_facts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identity / linkage
    buyer_id            TEXT,           -- messy: not a clean filing key, but closest entity id
    easi_company_id     TEXT,           -- EASI system id (not Salesforce), ~58% populated
    company             TEXT NOT NULL,
    customer_number     TEXT,
    dbs_name            TEXT,

    -- Filing
    filing_date         TEXT NOT NULL,  -- ISO date string (YYYY-MM-DD)
    ucc_status          TEXT,           -- SALE / LEASE / REFINANCE / WHOLESALE / RENTAL

    -- Equipment
    manufacturer        TEXT,
    is_cat              INTEGER GENERATED ALWAYS AS (manufacturer = 'CAT') STORED,
    equipment_description TEXT,
    serial              TEXT,
    model               TEXT,
    mfg_year            TEXT,
    new_used            TEXT,           -- N / U
    equip_or_attach     TEXT,           -- E / A
    equipment_value     REAL,

    -- Buyer contact / location
    first_name          TEXT,
    last_name            TEXT,
    phone               TEXT,
    address1            TEXT,
    address2            TEXT,
    city                TEXT,
    zip                 TEXT,
    county              TEXT,
    lat                 REAL,
    lon                 REAL,

    -- Sales assignment
    user_assignment      TEXT,
    user_assignment_mgr  TEXT,
    salesmen1            TEXT,

    -- Load bookkeeping
    load_batch          TEXT,           -- e.g. '2026-07' — identifies which monthly refresh added/touched this row
    row_hash            TEXT,           -- hash of mutable fields, for incremental upsert change-detection
    updated_at          TEXT,

    UNIQUE(serial, filing_date)  -- one row per physical unit per sale event; manufacturer is
                                 -- redundant with serial, and same-day new->used resale of the
                                 -- same serial is treated as effectively impossible
);

CREATE INDEX IF NOT EXISTS idx_ucc_company     ON ucc_facts(company);
CREATE INDEX IF NOT EXISTS idx_ucc_filing_date  ON ucc_facts(filing_date);
CREATE INDEX IF NOT EXISTS idx_ucc_county       ON ucc_facts(county);
CREATE INDEX IF NOT EXISTS idx_ucc_manufacturer ON ucc_facts(manufacturer);
CREATE INDEX IF NOT EXISTS idx_ucc_buyer_id     ON ucc_facts(buyer_id);

-- ============================================================
-- Company rollup view — powers the single-record "deep dive"
-- Grouped by company (buyer_id is too messy to group on reliably)
-- ============================================================

CREATE VIEW IF NOT EXISTS ucc_company_summary AS
SELECT
    company,
    COUNT(*)                                  AS total_filings,
    SUM(is_cat)                               AS cat_filings,
    ROUND(100.0 * SUM(is_cat) / COUNT(*), 1)  AS pins_pct,          -- CAT records / total records
    SUM(equipment_value)                      AS total_equipment_value,
    MIN(filing_date)                          AS first_filing_date,
    MAX(filing_date)                          AS most_recent_filing_date,
    COUNT(DISTINCT manufacturer)              AS distinct_manufacturers,
    COUNT(DISTINCT county)                    AS distinct_counties,
    -- most recent salesperson assignment (simple heuristic, take from latest filing row via subquery if needed)
    NULL                                       AS latest_salesperson  -- placeholder; fill via app-layer query if needed
FROM ucc_facts
GROUP BY company;

-- ============================================================
-- Notes
-- ============================================================
-- - is_cat is a generated column so PINS%-style rollups (CAT / total) are cheap and consistent
--   with the PINS dashboard's "MANUFACTURER = 'CAT'" rule (exact match — BOBCAT/SCATTRAK/TIGERCAT
--   contain "CAT" as a substring but are NOT Caterpillar; confirmed against the raw export).
-- - load_batch supports the recurring monthly refresh: new export rows get stamped with the
--   batch label, making it possible to identify/audit/re-run a given month's load without
--   re-processing the whole table.
-- - No amendment/lineage fields exist in the source, so none are modeled here. "Deep dive"
--   history is expressed via ucc_company_summary + a company-filtered query against ucc_facts,
--   not a formal filing lineage.
