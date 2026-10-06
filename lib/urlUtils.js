/**
 * URL Utilities for ERP Backend
 * Dynamically resolves the active frontend URL across development and live production environments.
 */

function getFrontendBaseUrl(req) {
  // 1. If explicit FRONTEND_URL is set in environment and points to a remote/production domain, prioritize it
  if (process.env.FRONTEND_URL) {
    const configured = process.env.FRONTEND_URL.trim().replace(/\/+$/, '');
    if (!configured.includes('localhost') && !configured.includes('127.0.0.1')) {
      return configured;
    }
  }

  // 2. Inspect incoming request headers (Origin / Referer / Host)
  if (req && req.headers) {
    // 2a. Origin header (sent by browsers on CORS / API fetch/axios POST requests)
    const origin = req.headers.origin;
    if (origin && typeof origin === 'string' && origin !== 'null') {
      const clean = origin.trim().replace(/\/+$/, '');
      if (clean.startsWith('http://') || clean.startsWith('https://')) {
        return clean;
      }
    }

    // 2b. Referer header (sent on GET requests and page navigation)
    const referer = req.headers.referer;
    if (referer && typeof referer === 'string') {
      try {
        const parsed = new URL(referer);
        if (parsed.origin && parsed.origin !== 'null') {
          return parsed.origin.replace(/\/+$/, '');
        }
      } catch (_) {}
    }

    // 2c. X-Forwarded-Host or Host header (reverse proxies, Cloudflare, cPanel, Nginx)
    const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host;
    if (forwardedHost && typeof forwardedHost === 'string') {
      const hostOnly = forwardedHost.split(',')[0].trim();
      const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
      if (hostOnly.includes('solarman.in') || hostOnly.includes('vercel.app')) {
        return `https://${hostOnly}`;
      }
      if (!hostOnly.includes('localhost') && !hostOnly.includes('127.0.0.1')) {
        return `${proto}://${hostOnly}`;
      }
    }
  }

  // 3. Fallback to FRONTEND_URL or CLIENT_URL if configured
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL.trim().replace(/\/+$/, '');
  }
  if (process.env.CLIENT_URL) {
    return process.env.CLIENT_URL.trim().replace(/\/+$/, '');
  }

  // 4. If running in production mode, default to canonical production domain
  if (process.env.NODE_ENV === 'production') {
    return 'https://erp.solarman.in';
  }

  // 5. Default local dev server
  return 'http://localhost:5173';
}

module.exports = {
  getFrontendBaseUrl
};
