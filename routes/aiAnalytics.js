'use strict';

/**
 * routes/aiAnalytics.js
 * NVIDIA Nemotron AI Analytics & Future Business Predictions API
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { computePredictiveAnalytics } = require('../lib/predictiveAnalytics');
const { generateExecutiveInsights, answerBusinessQuestion } = require('../lib/nemotronClient');
const { queryMaster } = require('../db/masterDb');

const fs = require('fs');
const path = require('path');

// Ensure directory for persistent analytics cache exists
const AI_CACHE_DIR = path.join(__dirname, '..', 'logs', 'ai_cache');
if (!fs.existsSync(AI_CACHE_DIR)) {
  try {
    fs.mkdirSync(AI_CACHE_DIR, { recursive: true });
  } catch {}
}

function getCacheFilePath(companyId, horizon) {
  const safeCompany = String(companyId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(AI_CACHE_DIR, `ai_snapshot_${safeCompany}_${horizon}.json`);
}

function loadPersistedSnapshot(companyId, horizon) {
  try {
    const file = getCacheFilePath(companyId, horizon);
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.warn('[AI Analytics] Could not read disk cache:', err.message);
  }
  return null;
}

function savePersistedSnapshot(companyId, horizon, payload) {
  try {
    const file = getCacheFilePath(companyId, horizon);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.warn('[AI Analytics] Could not save disk cache:', err.message);
  }
}

// In-memory cache map for instantaneous in-process responses
const analyticsCache = new Map();

/**
 * GET /api/ai-analytics/overview
 * Returns 30-day historical telemetry, statistical regression forecasts, stockout projections, and AI strategic insights.
 * 
 * Rules:
 * - On normal page visit (refresh !== 'true'): Returns previously loaded/persisted snapshot WITHOUT calling the AI API.
 * - Only when user explicitly clicks "Regenerate" (refresh === 'true') or when no previous data exists: Runs the live AI API.
 */
router.get('/overview', requireAuth, requirePermission('ai_analytics', 'view'), async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id || 'default';
  const horizon = Math.min(90, Math.max(14, parseInt(req.query.horizon || '30', 10)));
  const forceRefresh = req.query.refresh === 'true';

  const cacheKey = `${companyId}_${horizon}`;
  let cachedPayload = analyticsCache.get(cacheKey);

  // If not in memory, load from persistent disk storage
  if (!cachedPayload) {
    cachedPayload = loadPersistedSnapshot(companyId, horizon);
    if (cachedPayload) {
      analyticsCache.set(cacheKey, cachedPayload);
    }
  }

  // If user did NOT click "Regenerate" and previously generated data exists -> return it immediately
  if (!forceRefresh && cachedPayload) {
    return res.json(cachedPayload);
  }

  try {
    // 1. Run mathematical predictive projections across multi-table tenant data
    const analytics = await computePredictiveAnalytics(req.tenantDb, horizon);

    // 2. Fetch workspace metadata for branding & context
    let companyName = 'ERP Workspace';
    try {
      const cRes = await queryMaster('SELECT company_name FROM companies WHERE id = ?', [companyId]);
      if (cRes.rows && cRes.rows[0]) companyName = cRes.rows[0].company_name;
    } catch {}

    // 3. Generate Executive AI synthesis & strategic outlook via live model API
    const aiInsights = await generateExecutiveInsights(
      analytics.summaryMetrics,
      analytics.historicalSeries,
      analytics.forecastMetrics
    );

    const payload = {
      companyName,
      horizonDays: horizon,
      generatedAt: new Date().toISOString(),
      summaryMetrics: analytics.summaryMetrics,
      forecastMetrics: analytics.forecastMetrics,
      historicalSeries: analytics.historicalSeries,
      forecastSeries: analytics.forecastSeries,
      customerPredictions: analytics.customerPredictions,
      weeklyWaterfall: analytics.weeklyWaterfall,
      procurementPriceForecast: analytics.procurementPriceForecast,
      productMarginForecast: analytics.productMarginForecast,
      productionBottleneckForecast: analytics.productionBottleneckForecast,
      expenseBreakdown: analytics.expenseBreakdown,
      aiInsights
    };

    // Store in both memory and persistent disk cache
    analyticsCache.set(cacheKey, payload);
    savePersistedSnapshot(companyId, horizon, payload);

    return res.json(payload);
  } catch (err) {
    console.error('ai-analytics overview error:', err);
    // If external API fails during refresh, fall back to previously cached snapshot if available
    if (cachedPayload) {
      console.warn('[AI Analytics] API request failed; serving previously cached snapshot.');
      return res.json(cachedPayload);
    }
    return res.status(500).json({ error: 'Failed to compute AI analytics: ' + err.message });
  }
});

/**
 * POST /api/ai-analytics/ask
 * Natural Language ERP Business Copilot (Ask Nemotron)
 */
router.post('/ask', requireAuth, requirePermission('ai_analytics', 'view'), async (req, res) => {
  const { question } = req.body;
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }

  const companyId = req.user.company_id || req.user.workspace_id || 'default';

  try {
    // Fetch live business context snapshot
    const analytics = await computePredictiveAnalytics(req.tenantDb, 30);

    let companyName = 'ERP Workspace';
    try {
      const cRes = await queryMaster('SELECT company_name FROM companies WHERE id = ?', [companyId]);
      if (cRes.rows && cRes.rows[0]) companyName = cRes.rows[0].company_name;
    } catch {}

    const contextData = {
      companyName,
      pastRevenue: analytics.summaryMetrics.pastRevenue,
      projectedRevenue: analytics.forecastMetrics.projectedRevenueNext30,
      cashInHand: analytics.summaryMetrics.cashInHand,
      receivables: analytics.summaryMetrics.receivables,
      payables: analytics.summaryMetrics.payablesDue,
      stockoutAlerts: analytics.forecastMetrics.stockoutAlerts,
      shiftEfficiency: analytics.summaryMetrics.shiftEfficiencyPct
    };

    const aiAnswer = await answerBusinessQuestion(question.trim(), contextData);

    return res.json({
      question: question.trim(),
      ...aiAnswer,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('ai-analytics ask error:', err);
    return res.status(500).json({ error: 'Failed to answer business question: ' + err.message });
  }
});

/**
 * POST /api/ai-analytics/refresh
 * Explicit cache invalidation
 */
router.post('/refresh', requireAuth, requirePermission('ai_analytics', 'view'), async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id || 'default';
  for (const key of analyticsCache.keys()) {
    if (key.startsWith(companyId)) {
      analyticsCache.delete(key);
    }
  }
  return res.json({ success: true, message: 'Predictions cache cleared' });
});

module.exports = router;
