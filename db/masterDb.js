/**
 * masterDb.js — MySQL connection pool manager for erp_master.
 * Uses mysql2/promise createPool().
 */

'use strict';

const mysql = require('mysql2/promise');

function getMasterConfig() {
  const masterUrl = process.env.MASTER_DATABASE_URL || 'mysql://root:@localhost:3306/erp_master';
  try {
    const url = new URL(masterUrl);
    const parsedDb = url.pathname.replace(/^\//, '');
    const finalDb = process.env.MASTER_DB_NAME || parsedDb || 'erp_master';
    return {
      host: url.hostname || process.env.MYSQL_HOST || 'localhost',
      port: parseInt(url.port || process.env.MYSQL_PORT || '3306', 10),
      user: url.username || process.env.MYSQL_USER || 'root',
      password: url.password || process.env.MYSQL_PASSWORD || '',
      database: finalDb,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      multipleStatements: false,
      dateStrings: true
    };
  } catch (err) {
    return {
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT || '3306', 10),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MASTER_DB_NAME || 'erp_master',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      multipleStatements: false,
      dateStrings: true
    };
  }
}

function getAdminConfig() {
  const adminUrl = process.env.MASTER_DATABASE_ADMIN_URL || 'mysql://root:@localhost:3306/mysql';
  try {
    const url = new URL(adminUrl);
    return {
      host: url.hostname || process.env.MYSQL_HOST || 'localhost',
      port: parseInt(url.port || process.env.MYSQL_PORT || '3306', 10),
      user: url.username || process.env.MYSQL_USER || 'root',
      password: url.password || process.env.MYSQL_PASSWORD || '',
      database: url.pathname.replace(/^\//, '') || 'mysql',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      multipleStatements: true,
      dateStrings: true
    };
  } catch (err) {
    return {
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT || '3306', 10),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: 'mysql',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      multipleStatements: true,
      dateStrings: true
    };
  }
}

function formatQueryResult(res) {
  if (!res) return { rows: [], rowCount: 0, insertId: null, affectedRows: 0 };
  if (res.rows && Array.isArray(res.rows)) return res;

  const rows = Array.isArray(res) ? res[0] : res;
  if (Array.isArray(rows)) {
    return {
      rows,
      rowCount: rows.length,
      insertId: null,
      affectedRows: 0
    };
  } else if (rows && typeof rows === 'object') {
    return {
      rows: [],
      rowCount: rows.affectedRows || 0,
      insertId: rows.insertId || null,
      affectedRows: rows.affectedRows || 0
    };
  }
  return { rows: [], rowCount: 0, insertId: null, affectedRows: 0 };
}

let _masterMysqlPool = null;
function getMasterMysqlPool() {
  if (!_masterMysqlPool) {
    _masterMysqlPool = mysql.createPool(getMasterConfig());
  }
  return _masterMysqlPool;
}

let _adminMysqlPool = null;
function getAdminMysqlPool() {
  if (!_adminMysqlPool) {
    _adminMysqlPool = mysql.createPool(getAdminConfig());
  }
  return _adminMysqlPool;
}

async function queryMaster(text, params) {
  const p = getMasterMysqlPool();
  const res = await p.query(text, params);
  return formatQueryResult(res);
}

const masterPool = {
  query: queryMaster,
  connect: async () => {
    const p = getMasterMysqlPool();
    const conn = await p.getConnection();
    let released = false;
    return {
      query: async (text, params) => {
        const res = await conn.query(text, params);
        return formatQueryResult(res);
      },
      release: async () => {
        if (!released) {
          released = true;
          conn.release();
        }
      },
      end: async () => {
        if (!released) {
          released = true;
          conn.release();
        }
      }
    };
  },
  getConnection: async () => {
    return await masterPool.connect();
  },
  end: async () => {
    if (_masterMysqlPool) {
      await _masterMysqlPool.end().catch(() => {});
      _masterMysqlPool = null;
    }
  }
};

function getAdminPool() {
  const p = getAdminMysqlPool();
  return {
    query: async (text, params) => {
      const res = await p.query(text, params);
      return formatQueryResult(res);
    },
    connect: async () => {
      const conn = await p.getConnection();
      let released = false;
      return {
        query: async (text, params) => {
          const res = await conn.query(text, params);
          return formatQueryResult(res);
        },
        release: async () => {
          if (!released) {
            released = true;
            conn.release();
          }
        },
        end: async () => {
          if (!released) {
            released = true;
            conn.release();
          }
        }
      };
    },
    end: async () => {
      if (_adminMysqlPool) {
        await _adminMysqlPool.end().catch(() => {});
        _adminMysqlPool = null;
      }
    }
  };
}

module.exports = {
  masterPool,
  queryMaster,
  getAdminPool,
  getMasterConfig,
  masterConnectionString: process.env.MASTER_DATABASE_URL || 'mysql://root:@localhost:3306/erp_master',
  adminConnectionString: process.env.MASTER_DATABASE_ADMIN_URL || 'mysql://root:@localhost:3306/mysql'
};
