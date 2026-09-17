'use strict';

const crypto = require('crypto');

/**
 * auditCrypto.js — Cryptographic Hash-Chaining & Tamper-Proof Verification for Audit Logs.
 */

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

function normalizeMetadata(metadata) {
  if (!metadata) return '{}';
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return JSON.stringify(parsed);
    } catch {
      return metadata;
    }
  }
  return JSON.stringify(metadata);
}

function computeAuditHash({ id, prev_hash, user_id, action, entity_type, entity_id, metadata, created_at, company_id }) {
  const metaStr = normalizeMetadata(metadata);
  const timeEpoch = created_at ? Math.floor(new Date(created_at).getTime() / 1000) : Math.floor(Date.now() / 1000);

  const payload = [
    id || '',
    prev_hash || GENESIS_HASH,
    company_id || '',
    user_id || '',
    action || '',
    entity_type || '',
    entity_id || '',
    metaStr,
    timeEpoch
  ].join('|');

  return crypto.createHash('sha256').update(payload).digest('hex');
}

function generateAuditId() {
  const timestamp = Date.now().toString(36).padStart(10, '0');
  const rand = crypto.randomBytes(8).toString('hex');
  return `aud_${timestamp}_${rand}`;
}

/**
 * Log a tamper-proof event into Master DB (Platform Super Admin Audit)
 */
async function logMasterAudit(queryMaster, { company_id = null, user_id = null, action, metadata = {} }) {
  try {
    await queryMaster('ALTER TABLE master_audit_log ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64) NULL').catch(() => {});
    await queryMaster('ALTER TABLE master_audit_log ADD COLUMN IF NOT EXISTS hash VARCHAR(64) NULL').catch(() => {});

    // Ensure legacy rows are chained
    await backfillMasterAuditHashes(queryMaster);

    // Fetch previous hash
    const latestRes = await queryMaster('SELECT id, hash FROM master_audit_log WHERE hash IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1');
    const prev_hash = latestRes.rows[0]?.hash || GENESIS_HASH;

    const id = generateAuditId();
    const now = new Date();
    const metaStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

    const hash = computeAuditHash({
      id,
      prev_hash,
      company_id,
      user_id,
      action,
      metadata: metaStr,
      created_at: now
    });

    await queryMaster(
      `INSERT INTO master_audit_log (id, company_id, user_id, action, metadata, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, company_id, user_id, action, metaStr, prev_hash, hash, now]
    );

    return { id, hash, prev_hash };
  } catch (err) {
    console.warn('Failed to write master audit log:', err.message);
    return null;
  }
}

/**
 * Log a tamper-proof event into Tenant DB (Workspace Audit)
 */
async function logTenantAudit(tenantDb, { user_id = null, action, entity_type = null, entity_id = null, metadata = {} }) {
  try {
    await tenantDb.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64) NULL').catch(() => {});
    await tenantDb.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS hash VARCHAR(64) NULL').catch(() => {});

    // Ensure legacy rows are chained
    await backfillTenantAuditHashes(tenantDb);

    const latestRes = await tenantDb.query('SELECT id, hash FROM audit_log WHERE hash IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1');
    const prev_hash = latestRes.rows[0]?.hash || GENESIS_HASH;

    const id = generateAuditId();
    const now = new Date();
    const metaStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

    const hash = computeAuditHash({
      id,
      prev_hash,
      user_id,
      action,
      entity_type,
      entity_id,
      metadata: metaStr,
      created_at: now
    });

    await tenantDb.query(
      `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, user_id, action, entity_type, entity_id, metaStr, prev_hash, hash, now]
    );

    return { id, hash, prev_hash };
  } catch (err) {
    console.warn('Failed to write tenant audit log:', err.message);
    return null;
  }
}

/**
 * Backfill legacy unhashed rows for Master DB (only for legacy rows where hash is NULL)
 */
async function backfillMasterAuditHashes(queryMaster) {
  try {
    await queryMaster('ALTER TABLE master_audit_log ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64) NULL').catch(() => {});
    await queryMaster('ALTER TABLE master_audit_log ADD COLUMN IF NOT EXISTS hash VARCHAR(64) NULL').catch(() => {});

    const rowsRes = await queryMaster('SELECT id, company_id, user_id, action, metadata, prev_hash, hash, created_at FROM master_audit_log ORDER BY created_at ASC, id ASC');
    const rows = rowsRes.rows;

    let prevHash = GENESIS_HASH;
    for (const row of rows) {
      if (!row.hash) {
        const calculated = computeAuditHash({
          id: row.id,
          prev_hash: prevHash,
          company_id: row.company_id,
          user_id: row.user_id,
          action: row.action,
          metadata: row.metadata,
          created_at: row.created_at
        });
        await queryMaster('UPDATE master_audit_log SET prev_hash = ?, hash = ? WHERE id = ?', [prevHash, calculated, row.id]);
        prevHash = calculated;
      } else {
        prevHash = row.hash;
      }
    }
  } catch (err) {
    console.warn('backfillMasterAuditHashes warning:', err.message);
  }
}

/**
 * Backfill legacy unhashed rows for Tenant DB (only for legacy rows where hash is NULL)
 */
async function backfillTenantAuditHashes(tenantDb) {
  try {
    await tenantDb.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash VARCHAR(64) NULL').catch(() => {});
    await tenantDb.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS hash VARCHAR(64) NULL').catch(() => {});

    const rowsRes = await tenantDb.query('SELECT id, user_id, action, entity_type, entity_id, metadata, prev_hash, hash, created_at FROM audit_log ORDER BY created_at ASC, id ASC');
    const rows = rowsRes.rows;

    let prevHash = GENESIS_HASH;
    for (const row of rows) {
      if (!row.hash) {
        const calculated = computeAuditHash({
          id: row.id,
          prev_hash: prevHash,
          user_id: row.user_id,
          action: row.action,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          metadata: row.metadata,
          created_at: row.created_at
        });
        await tenantDb.query('UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ?', [prevHash, calculated, row.id]);
        prevHash = calculated;
      } else {
        prevHash = row.hash;
      }
    }
  } catch (err) {
    console.warn('backfillTenantAuditHashes warning:', err.message);
  }
}

/**
 * Verify cryptographic hash chain for Master DB
 */
async function verifyMasterAuditChain(queryMaster) {
  try {
    await backfillMasterAuditHashes(queryMaster);

    const rowsRes = await queryMaster('SELECT id, company_id, user_id, action, metadata, prev_hash, hash, created_at FROM master_audit_log ORDER BY created_at ASC, id ASC');
    const rows = rowsRes.rows;

    let expectedPrevHash = GENESIS_HASH;
    let validCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.prev_hash && row.prev_hash !== expectedPrevHash) {
        return {
          valid: false,
          total: rows.length,
          verifiedCount: validCount,
          brokenAtId: row.id,
          reason: `Broken chain link at log entry ${row.id}. Expected previous hash ${expectedPrevHash}, got ${row.prev_hash}`
        };
      }

      const calculated = computeAuditHash(row);
      if (row.hash !== calculated) {
        return {
          valid: false,
          total: rows.length,
          verifiedCount: validCount,
          brokenAtId: row.id,
          reason: `Cryptographic payload mismatch at log entry ${row.id}. Content was altered.`
        };
      }

      expectedPrevHash = row.hash;
      validCount++;
    }

    return {
      valid: true,
      total: rows.length,
      verifiedCount: validCount,
      headHash: expectedPrevHash
    };
  } catch (err) {
    console.error('verifyMasterAuditChain error:', err);
    return { valid: false, error: err.message };
  }
}

/**
 * Verify cryptographic hash chain for Tenant DB
 */
async function verifyTenantAuditChain(tenantDb) {
  try {
    await backfillTenantAuditHashes(tenantDb);

    const rowsRes = await tenantDb.query('SELECT id, user_id, action, entity_type, entity_id, metadata, prev_hash, hash, created_at FROM audit_log ORDER BY created_at ASC, id ASC');
    const rows = rowsRes.rows;

    let expectedPrevHash = GENESIS_HASH;
    let validCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.prev_hash && row.prev_hash !== expectedPrevHash) {
        return {
          valid: false,
          total: rows.length,
          verifiedCount: validCount,
          brokenAtId: row.id,
          reason: `Broken chain link at log entry ${row.id}. Expected previous hash ${expectedPrevHash}, got ${row.prev_hash}`
        };
      }

      const calculated = computeAuditHash(row);
      if (row.hash !== calculated) {
        return {
          valid: false,
          total: rows.length,
          verifiedCount: validCount,
          brokenAtId: row.id,
          reason: `Cryptographic payload mismatch at log entry ${row.id}. Record was altered.`
        };
      }

      expectedPrevHash = row.hash;
      validCount++;
    }

    return {
      valid: true,
      total: rows.length,
      verifiedCount: validCount,
      headHash: expectedPrevHash
    };
  } catch (err) {
    console.error('verifyTenantAuditChain error:', err);
    return { valid: false, error: err.message };
  }
}

module.exports = {
  computeAuditHash,
  logMasterAudit,
  logTenantAudit,
  verifyMasterAuditChain,
  verifyTenantAuditChain,
  backfillMasterAuditHashes,
  backfillTenantAuditHashes,
  GENESIS_HASH
};
