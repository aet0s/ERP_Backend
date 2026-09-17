/**
 * tenantManager.js — Production-grade Database-Per-Company MySQL connection pool manager.
 *
 * Features:
 * - Real MySQL connection pooling via mysql2/promise `createPool()`.
 * - LRU eviction for tenant pools with in-flight query protection.
 * - Enforces hard cap ceiling (MAX_ACTIVE_TENANT_POOLS, default 10).
 * - Queueing with configurable timeout (TENANT_POOL_QUEUE_TIMEOUT_MS, default 5000ms) when ceiling reached.
 */

'use strict';

const mysql = require('mysql2/promise');

const tenantPools = new Map(); // dbName -> PoolEntry { pool, dbName, lastUsed, activeQueries }
const poolQueue = []; // [{ dbName, resolve, reject, timeoutTimer }]

function getMaxPoolCeiling() {
  const max = parseInt(process.env.MAX_ACTIVE_TENANT_POOLS || '10', 10);
  return Number.isFinite(max) && max > 0 ? max : 10;
}

function getQueueTimeoutMs() {
  const timeout = parseInt(process.env.TENANT_POOL_QUEUE_TIMEOUT_MS || '5000', 10);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 5000;
}

function parseTenantConfig(dbName) {
  const url = process.env.MASTER_DATABASE_URL || 'mysql://root:@localhost:3306/erp_master';
  let host = 'localhost', port = 3306, user = 'root', password = '';
  try {
    const u = new URL(url);
    host     = u.hostname || host;
    port     = parseInt(u.port || port, 10);
    user     = u.username || user;
    password = u.password || password;
  } catch (_) {}

  return {
    host               : process.env.MYSQL_HOST     || host,
    port               : parseInt(process.env.MYSQL_PORT || port, 10),
    user               : process.env.MYSQL_USER     || user,
    password           : process.env.MYSQL_PASSWORD || password,
    database           : dbName,
    waitForConnections : true,
    connectionLimit    : 10,
    queueLimit         : 0,
    multipleStatements : false,
    dateStrings        : true,
  };
}

/**
 * Format raw mysql2 result to { rows, rowCount, insertId, affectedRows }
 */
function fmt(res) {
  if (!res) return { rows: [], rowCount: 0, insertId: null, affectedRows: 0 };
  if (res.rows && Array.isArray(res.rows)) return res;

  const payload = Array.isArray(res) ? res[0] : res;
  if (Array.isArray(payload)) {
    return { rows: payload, rowCount: payload.length, insertId: null, affectedRows: 0 };
  }
  if (payload && typeof payload === 'object') {
    return {
      rows        : [],
      rowCount    : payload.affectedRows || 0,
      insertId    : payload.insertId     || null,
      affectedRows: payload.affectedRows || 0,
    };
  }
  return { rows: [], rowCount: 0, insertId: null, affectedRows: 0 };
}

function processQueue() {
  if (poolQueue.length === 0) return;

  const maxCeiling = getMaxPoolCeiling();

  // If map size is under ceiling or we can evict an idle pool
  while (poolQueue.length > 0) {
    if (tenantPools.size < maxCeiling || hasIdleEvictablePool()) {
      const nextReq = poolQueue.shift();
      clearTimeout(nextReq.timeoutTimer);
      try {
        const poolObj = getOrCreateTenantPoolSync(nextReq.dbName);
        nextReq.resolve(poolObj);
      } catch (err) {
        nextReq.reject(err);
      }
    } else {
      break; // Ceiling still full and all active pools busy
    }
  }
}

function hasIdleEvictablePool() {
  for (const entry of tenantPools.values()) {
    if (entry.activeQueries === 0) return true;
  }
  return false;
}

function evictLruIdlePool() {
  let oldestEntry = null;
  for (const entry of tenantPools.values()) {
    if (entry.activeQueries === 0) {
      if (!oldestEntry || entry.lastUsed < oldestEntry.lastUsed) {
        oldestEntry = entry;
      }
    }
  }

  if (oldestEntry) {
    tenantPools.delete(oldestEntry.dbName);
    oldestEntry.pool.end().catch(() => {});
    return true;
  }
  return false;
}

function getOrCreateTenantPoolSync(dbName) {
  // If already in map, update lastUsed and return
  if (tenantPools.has(dbName)) {
    const entry = tenantPools.get(dbName);
    entry.lastUsed = Date.now();
    return wrapTenantPool(entry);
  }

  const maxCeiling = getMaxPoolCeiling();

  // Evict LRU idle pool if ceiling reached
  if (tenantPools.size >= maxCeiling) {
    const evicted = evictLruIdlePool();
    if (!evicted) {
      throw new Error(`TENANT_POOL_CEILING_BUSY: All ${maxCeiling} active tenant pools are busy`);
    }
  }

  // Create new mysql2 pool
  const config = parseTenantConfig(dbName);
  const mysqlPool = mysql.createPool(config);

  const entry = {
    dbName,
    pool: mysqlPool,
    lastUsed: Date.now(),
    activeQueries: 0
  };

  tenantPools.set(dbName, entry);
  return wrapTenantPool(entry);
}

function wrapTenantPool(entry) {
  return {
    databaseName: entry.dbName,
    query: async (sql, params) => {
      entry.lastUsed = Date.now();
      entry.activeQueries++;
      try {
        const res = await entry.pool.query(sql, params);
        return fmt(res);
      } finally {
        entry.activeQueries = Math.max(0, entry.activeQueries - 1);
        entry.lastUsed = Date.now();
        processQueue();
      }
    },
    connect: async () => {
      entry.lastUsed = Date.now();
      entry.activeQueries++;
      const conn = await entry.pool.getConnection();
      let released = false;

      const releaseConn = () => {
        if (!released) {
          released = true;
          entry.activeQueries = Math.max(0, entry.activeQueries - 1);
          entry.lastUsed = Date.now();
          conn.release();
          processQueue();
        }
      };

      return {
        query: async (sql, params) => {
          entry.lastUsed = Date.now();
          const res = await conn.query(sql, params);
          return fmt(res);
        },
        release: async () => {
          releaseConn();
        },
        end: async () => {
          releaseConn();
        }
      };
    },
    end: async () => {
      await closeTenantPool(entry.dbName);
    }
  };
}

function getTenantPool(dbName) {
  if (!dbName || typeof dbName !== 'string') {
    throw new Error('getTenantPool: dbName is required');
  }

  if (tenantPools.has(dbName)) {
    const entry = tenantPools.get(dbName);
    entry.lastUsed = Date.now();
    return wrapTenantPool(entry);
  }

  const maxCeiling = getMaxPoolCeiling();

  if (tenantPools.size < maxCeiling || hasIdleEvictablePool()) {
    return getOrCreateTenantPoolSync(dbName);
  }

  // Otherwise, synchronously return a proxy wrapper that queues connection acquiring when invoked
  return {
    query: async (sql, params) => {
      const poolObj = await waitForPoolSlot(dbName);
      return poolObj.query(sql, params);
    },
    connect: async () => {
      const poolObj = await waitForPoolSlot(dbName);
      return poolObj.connect();
    },
    end: async () => {
      await closeTenantPool(dbName);
    }
  };
}

function waitForPoolSlot(dbName) {
  return new Promise((resolve, reject) => {
    const timeoutMs = getQueueTimeoutMs();
    const timeoutTimer = setTimeout(() => {
      // Remove from queue
      const idx = poolQueue.findIndex((item) => item.timeoutTimer === timeoutTimer);
      if (idx !== -1) poolQueue.splice(idx, 1);
      const err = new Error(`Tenant pool queue timeout (${timeoutMs}ms) reached for database ${dbName}`);
      err.status = 503;
      reject(err);
    }, timeoutMs);

    poolQueue.push({ dbName, resolve, reject, timeoutTimer });
  });
}

function getTenantConnectionString(dbName) {
  const c = parseTenantConfig(dbName);
  return `mysql://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`;
}

async function closeTenantPool(dbName) {
  if (tenantPools.has(dbName)) {
    const entry = tenantPools.get(dbName);
    tenantPools.delete(dbName);
    await entry.pool.end().catch(() => {});
    processQueue();
  }
}

async function closeAllTenantPools() {
  const entries = Array.from(tenantPools.values());
  tenantPools.clear();
  for (const entry of entries) {
    await entry.pool.end().catch(() => {});
  }
  poolQueue.forEach((q) => {
    clearTimeout(q.timeoutTimer);
    q.reject(new Error('All tenant pools closed'));
  });
  poolQueue.length = 0;
}

function getActivePoolsCount() {
  return tenantPools.size;
}

module.exports = {
  getTenantPool,
  getTenantConnectionString,
  closeTenantPool,
  closeAllTenantPools,
  getActivePoolsCount,
  tenantPools
};
