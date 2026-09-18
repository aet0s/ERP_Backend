// ERP Backend Server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { masterPool, queryMaster } = require('./db/masterDb');
const logger = require('./lib/logger');
const { sendAlert } = require('./lib/alerts');
const { requireActiveSubscription } = require('./middleware/subscription');
const { attachReturnRequestSocket } = require('./lib/returnRequestSocket');

// Environment Secret Validation — Fail Fast if Required Secrets Missing
if (!process.env.JWT_SECRET) {
  console.error('FATAL ERROR: JWT_SECRET environment variable is not set!');
  process.exit(1);
}
if (!process.env.SUPER_ADMIN_SECRET) {
  console.error('FATAL ERROR: SUPER_ADMIN_SECRET environment variable is not set!');
  process.exit(1);
}

const cookieParser = require('cookie-parser');
const app = express();
const PORT = process.env.PORT || 4000;
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://erp-gamma-beryl.vercel.app",
  "https://lams.solarman.in",
  "http://lams.solarman.in",
  ...(process.env.CLIENT_URL ? [process.env.CLIENT_URL] : []),
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : [])
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      allowedOrigins.includes(origin) ||
      origin.endsWith('.vercel.app') ||
      origin.includes('solarman.in')
    ) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-platform-token', 'X-Requested-With', 'Accept', 'Origin']
}));
app.use(cookieParser());

// Support subpath routing (e.g. https://lams.solarman.in/erp) if reverse proxy does not strip prefix
app.use((req, res, next) => {
  if (req.url.startsWith('/erp/') || req.url === '/erp') {
    req.url = req.url.replace(/^\/erp/, '') || '/';
  }
  next();
});

// Webhook endpoint (MUST be mounted before global body parsers to preserve raw unparsed body)
app.use('/api/webhooks', require('./routes/webhooks'));

app.use(bodyParser.json({ limit: '2mb' }));

// Public Health Check Endpoints (Root URL, /health, /api/health)
const { healthCheckHandler } = require('./routes/health');
app.get('/', healthCheckHandler);
app.get('/health', healthCheckHandler);
app.get('/api/health', healthCheckHandler);

// -- Route groups --
app.use('/auth', require('./routes/auth'));
app.use('/api/billing', require('./routes/billing'));
app.use('/admin', require('./routes/admin'));

// Apply subscription enforcement middleware (read-only lock on expired trials/unpaid plans)
app.use(requireActiveSubscription);

app.use('/api', require('./routes/catalog'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api', require('./routes/procurementRedesign'));
app.use('/api', require('./routes/api'));
app.use('/api/manufacturing', require('./routes/manufacturing'));
app.use('/api/packaging', require('./routes/packaging'));
app.use('/api', require('./routes/locations'));
app.use('/api', require('./routes/productionRuns'));
app.use('/api', require('./routes/productionOrders'));
app.use('/api', require('./routes/returnRequests'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/users', require('./routes/users'));
app.use('/reports', require('./routes/reports'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/ai-analytics', require('./routes/aiAnalytics'));

// Platform Super Admin routes (isolated from company auth)
app.use('/platform-admin/auth', require('./routes/platformAdminAuth'));

// Dynamic Role Permissions API
app.use('/api/permissions', require('./routes/permissions'));

// Universal & Legacy Portal routes
app.use('/api', require('./routes/portalAuth'));
app.use('/portal/api', require('./routes/portalAuth'));
app.use('/portal', require('./routes/portalAuth'));
app.use('/vendor-portal/api', require('./routes/vendorPortal'));
app.use('/customer-portal/api', require('./routes/customerPortal'));

// Centralized Error Handler
app.use((err, req, res, next) => {
  const companyId = req.user?.company_id || req.user?.workspace_id || 'anonymous';
  const errMsg = (err && err.message) ? err.message : String(err || 'Internal server error');
  const errStack = (err && err.stack) ? err.stack : '';
  console.error('5xx Exception Details:', err);
  logger.error(`5xx Exception on ${req.method} ${req.path}`, {
    company_id: companyId,
    route: req.path,
    method: req.method,
    error: errMsg,
    stack: errStack
  });

  sendAlert(`5xx Internal Server Error on ${req.method} ${req.path}`, {
    company_id: companyId,
    route: req.path,
    error: errMsg
  });

  return res.status(500).json({
    error: process.env.NODE_ENV === 'development' ? errMsg : 'Internal Server Error'
  });
});

(async () => {
  try {
    // 1. Verify master database schema; automatically import & heal if missing or incomplete
    const { ensureMasterDb } = require('./db/ensureMasterDb');
    await ensureMasterDb();

    // 2. Run pending tenant migrations across active companies
    const { getTenantPool } = require('./db/tenantManager');
    const { runTenantMigrations } = require('./db/migrationRunner');
    const companies = await queryMaster("SELECT id, company_name, database_name FROM companies WHERE status != 'deleted'");
    for (const company of companies.rows) {
      try {
        const tenantPool = getTenantPool(company.database_name);
        await runTenantMigrations(tenantPool);
      } catch (tErr) {
        console.warn(`Tenant migration failed for [${company.company_name}]:`, tErr.message);
      }
    }
  } catch (err) {
    console.error('Fatal startup error during database verification:', err.message);
  }

  const server = app.listen(PORT, () => {
    console.log(`ERP backend (Database-Per-Company) listening on port ${PORT}`);
    // Start automated database backup cron scheduler
    const { startBackupScheduler } = require('./lib/backupScheduler');
    startBackupScheduler();
  });
  attachReturnRequestSocket(server);
})();
