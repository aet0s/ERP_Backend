'use strict';

/**
 * routes/health.js
 * Comprehensive backend health check, uptime probe & diagnostic endpoint.
 * Publicly accessible at:
 * - GET / (hitting root backend URL directly)
 * - GET /health
 * - GET /api/health
 */

const express = require('express');
const router = express.Router();
const { queryMaster, getMasterConfig } = require('../db/masterDb');
const packageJson = require('../package.json');

/**
 * Formats seconds into human-readable duration (e.g. "2d 4h 12m 30s")
 */
function formatUptime(totalSeconds) {
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor((totalSeconds / 60) % 60);
  const h = Math.floor((totalSeconds / 3600) % 24);
  const d = Math.floor(totalSeconds / 86400);

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * Health check handler returning JSON status of server, database, memory, and runtime.
 */
async function healthCheckHandler(req, res) {
  const startTime = Date.now();
  const uptimeSeconds = Math.floor(process.uptime());
  const mem = process.memoryUsage();
  const masterConfig = getMasterConfig();

  let dbStatus = 'connected';
  let dbLatencyMs = 0;
  let dbTime = null;
  let activeCompanies = 0;
  let dbError = null;

  try {
    const t0 = Date.now();
    const dbRes = await queryMaster('SELECT 1 AS alive, NOW() AS db_time');
    dbLatencyMs = Date.now() - t0;
    dbTime = dbRes.rows[0]?.db_time || null;

    const companyRes = await queryMaster("SELECT COUNT(*) AS active_count FROM companies WHERE status != 'deleted'");
    activeCompanies = Number(companyRes.rows[0]?.active_count || 0);
  } catch (err) {
    dbStatus = 'unreachable';
    dbError = err.message;
  }

  const isHealthy = dbStatus === 'connected';
  const statusCode = isHealthy ? 200 : 503;

  const payload = {
    status: isHealthy ? 'healthy' : 'degraded',
    service: 'ERP Enterprise Backend API',
    version: packageJson.version || '0.1.0',
    environment: process.env.NODE_ENV || 'production',
    timestamp: new Date().toISOString(),
    uptime: {
      seconds: uptimeSeconds,
      formatted: formatUptime(uptimeSeconds)
    },
    database: {
      status: dbStatus,
      target: masterConfig.database || 'erp_master',
      latency_ms: dbLatencyMs,
      db_time: dbTime,
      active_companies: activeCompanies,
      ...(dbError ? { error: dbError } : {})
    },
    memory: {
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      rss_mb: Math.round(mem.rss / 1024 / 1024)
    },
    system: {
      node_version: process.version,
      platform: process.platform
    },
    response_time_ms: Date.now() - startTime
  };

  return res.status(statusCode).json(payload);
}

// Router mounts
router.get('/', healthCheckHandler);
router.get('/health', healthCheckHandler);
router.get('/api/health', healthCheckHandler);

module.exports = {
  healthRouter: router,
  healthCheckHandler
};
