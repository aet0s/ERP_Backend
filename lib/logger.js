const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LOG_FILE = path.join(LOG_DIR, 'app.log');

function logEvent(level, message, metadata = {}) {
  const sanitize = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const clean = { ...obj };
    const sensitive = ['password', 'database_password', 'secret', 'token', 'authorization'];
    for (const key of Object.keys(clean)) {
      if (sensitive.some((s) => key.toLowerCase().includes(s))) {
        clean[key] = '[REDACTED]';
      }
    }
    return clean;
  };

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    metadata: sanitize(metadata)
  };

  const line = JSON.stringify(payload) + '\n';
  console.log(`[${level.toUpperCase()}] ${message}`, metadata.company_id ? `(Company: ${metadata.company_id})` : '');

  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error('Failed to write to app.log:', err.message);
  });
}

module.exports = {
  info: (msg, meta) => logEvent('info', msg, meta),
  warn: (msg, meta) => logEvent('warn', msg, meta),
  error: (msg, meta) => logEvent('error', msg, meta),
  LOG_FILE
};
