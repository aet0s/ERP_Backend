const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { queryMaster } = require('../db/masterDb');
const { createCheckoutSession, createPortalSession } = require('../lib/billingProvider');

// Get subscription billing status
router.get('/', requireAuth, requirePermission('billing', 'view'), async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id;
  try {
    const compRes = await queryMaster(
      `SELECT id, company_name, plan, subscription_status, subscription_id, current_period_end, trial_ends_at, canceled_at, created_at
       FROM companies
       WHERE id = ?`,
      [companyId]
    );

    if (compRes.rowCount === 0) return res.status(404).json({ error: 'Company not found' });

    const comp = compRes.rows[0];
    const now = Date.now();
    const trialEnd = comp.trial_ends_at ? new Date(comp.trial_ends_at).getTime() : now;
    const daysLeft = Math.max(0, Math.ceil((trialEnd - now) / 86400000));

    return res.json({
      plan: comp.plan || 'starter',
      subscription_status: comp.subscription_status || 'trialing',
      subscription_id: comp.subscription_id || null,
      current_period_end: comp.current_period_end || null,
      trial_ends_at: comp.trial_ends_at || null,
      trial_days_remaining: daysLeft,
      is_read_only: ['trial_expired', 'past_due', 'canceled', 'read_only'].includes(comp.subscription_status)
    });
  } catch (err) {
    console.error('get billing info error', err);
    return res.status(500).json({ error: 'Failed to fetch billing details' });
  }
});

// Generate checkout URL for plan upgrade
router.post('/checkout', requireAuth, requirePermission('billing', 'create'), async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id;
  const { plan = 'pro' } = req.body;

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey || stripeKey.startsWith('sk_test_placeholder')) {
      const periodEnd = new Date(Date.now() + 30 * 86400000);
      await queryMaster(
        `UPDATE companies
         SET subscription_status = 'active',
             plan = ?,
             current_period_end = ?
         WHERE id = ?`,
        [plan, periodEnd, companyId]
      );
      return res.json({
        simulated: true,
        url: null,
        message: `Successfully upgraded workspace plan to ${plan.toUpperCase()}!`,
        plan,
        subscription_status: 'active'
      });
    }

    const session = await createCheckoutSession({
      companyId,
      companyEmail: req.user.email,
      plan
    });
    return res.json(session);
  } catch (err) {
    console.error('checkout error', err);
    return res.status(500).json({ error: 'Failed to generate checkout session' });
  }
});

// Generate customer billing portal URL
router.post('/portal', requireAuth, requirePermission('billing', 'edit'), async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id;
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey || stripeKey.startsWith('sk_test_placeholder')) {
      return res.json({
        simulated: true,
        url: null,
        message: 'Billing Portal: Subscription is active (Pro Plan, $29/mo).'
      });
    }

    const compRes = await queryMaster('SELECT subscription_id FROM companies WHERE id = ?', [companyId]);
    const customerId = compRes.rows[0]?.subscription_id || null;
    const session = await createPortalSession({ companyId, customerId });
    return res.json(session);
  } catch (err) {
    console.error('portal error', err);
    return res.status(500).json({ error: 'Failed to generate billing portal session' });
  }
});

module.exports = router;
