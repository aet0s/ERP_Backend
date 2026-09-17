const { queryMaster } = require('../db/masterDb');

async function requireActiveSubscription(req, res, next) {
  const companyId = req.user?.company_id || req.user?.workspace_id;
  if (!companyId) return next();

  try {
    const compRes = await queryMaster(
      `SELECT id, status, plan, subscription_status, trial_ends_at, current_period_end, graceful_read_only_until
       FROM companies
       WHERE id = ?`,
      [companyId]
    );

    if (compRes.rowCount === 0) return next();

    const company = compRes.rows[0];
    const now = new Date();

    // Check administrative status overrides
    if (company.status === 'paused' || company.subscription_status === 'paused') {
      return res.status(403).json({
        error: 'Workspace subscription is paused by platform administrator.',
        subscription_status: 'paused',
        locked: true
      });
    }

    if (company.status === 'suspended' || company.subscription_status === 'stopped') {
      return res.status(403).json({
        error: 'Workspace is suspended by platform administrator.',
        subscription_status: 'suspended',
        locked: true
      });
    }

    if (company.status === 'cancelled' || company.subscription_status === 'canceled') {
      return res.status(403).json({
        error: 'Workspace subscription has been cancelled.',
        subscription_status: 'canceled',
        locked: true
      });
    }

    // Load global grace buffer days from platform settings
    let graceBufferDays = 7;
    try {
      const settingsRes = await queryMaster('SELECT payment_grace_period_days FROM platform_settings LIMIT 1');
      if (settingsRes.rowCount > 0 && settingsRes.rows[0].payment_grace_period_days !== undefined && settingsRes.rows[0].payment_grace_period_days !== null) {
        graceBufferDays = parseInt(settingsRes.rows[0].payment_grace_period_days, 10) || 7;
      }
    } catch { /* fallback to 7 days */ }

    let effectiveStatus = company.subscription_status || (company.plan === 'trial' ? 'trialing' : 'active');
    const expiryDate = company.current_period_end ? new Date(company.current_period_end) : (company.trial_ends_at ? new Date(company.trial_ends_at) : null);

    if (expiryDate && expiryDate < now) {
      const graceCutoff = new Date(expiryDate.getTime() + graceBufferDays * 86400000);
      if (now <= graceCutoff) {
        // Within grace buffer period! Portal remains operational with grace notice
        const daysLeft = Math.max(1, Math.ceil((graceCutoff.getTime() - now.getTime()) / 86400000));
        req.inGracePeriod = true;
        req.graceDaysRemaining = daysLeft;
        res.setHeader('X-Payment-Grace-Period', `true; days_remaining=${daysLeft}`);
      } else {
        // Grace period expired! Block operations
        effectiveStatus = 'past_due_locked';
        req.isReadOnly = true;

        const isWriteMethod = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method.toUpperCase());
        const isExemptRoute = req.path.startsWith('/auth') ||
          req.path.startsWith('/users/accept-invite') ||
          req.path.includes('/billing') ||
          req.path.includes('/subscribe');

        if (isWriteMethod && !isExemptRoute) {
          return res.status(402).json({
            error: `Payment buffer of ${graceBufferDays} days expired. Portal operations are locked until payment is completed.`,
            subscription_status: effectiveStatus,
            grace_period_expired: true,
            buffer_days_configured: graceBufferDays,
            action_required: 'Please renew or complete subscription payment to unlock portal operations.'
          });
        }
      }
    }

    req.subscriptionStatus = effectiveStatus;
    next();
  } catch (err) {
    console.error('Subscription enforcement middleware error:', err);
    next();
  }
}

module.exports = { requireActiveSubscription };
