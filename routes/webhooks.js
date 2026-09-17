const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { queryMaster } = require('../db/masterDb');
const { verifyWebhookSignature } = require('../lib/billingProvider');
const logger = require('../lib/logger');
const { sendAlert } = require('../lib/alerts');

router.post('/billing', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'] || req.headers['x-razorpay-signature'] || req.headers['x-signature'];
  const rawBody = typeof req.body === 'string' ? req.body : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));

  const isValid = verifyWebhookSignature(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  if (!isValid && process.env.NODE_ENV === 'production') {
    sendAlert('Webhook Signature Verification Failure', { ip: req.ip, headers: req.headers });
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  let event;
  try {
    event = typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid payload JSON' });
  }

  const eventId = event.id || event.event_id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const eventType = event.type || event.event || 'payment_succeeded';
  const provider = event.provider || 'stripe';

  // Check idempotency in master_webhook_events
  try {
    const existing = await queryMaster('SELECT id FROM master_webhook_events WHERE event_id = ?', [eventId]);
    if (existing.rowCount > 0) {
      logger.info(`Webhook event [${eventId}] already processed. Skipping duplicate.`, { eventId, eventType });
      return res.json({ received: true, duplicate: true });
    }

    // Record webhook event in master DB
    const id = crypto.randomUUID();
    await queryMaster(
      `INSERT INTO master_webhook_events (id, event_id, provider, event_type, payload)
       VALUES (?, ?, ?, ?, ?)`,
      [id, eventId, provider, eventType, JSON.stringify(event)]
    );

    const dataObj = event.data?.object || event.payload || {};
    const companyId = dataObj.client_reference_id || dataObj.metadata?.company_id;

    logger.info(`Processing webhook event [${eventType}]`, { eventId, companyId });

    if (companyId) {
      if (eventType === 'payment_succeeded' || eventType === 'invoice.payment_succeeded') {
        const periodEnd = dataObj.current_period_end
          ? new Date(dataObj.current_period_end * 1000)
          : new Date(Date.now() + 30 * 86400000);
        await queryMaster(
          `UPDATE companies
           SET subscription_status = 'active',
               plan = COALESCE(?, plan),
               subscription_id = COALESCE(?, subscription_id),
               current_period_end = ?
           WHERE id = ?`,
          [dataObj.plan?.id || 'pro', dataObj.subscription || dataObj.id, periodEnd, companyId]
        );
      } else if (eventType === 'payment_failed' || eventType === 'invoice.payment_failed') {
        await queryMaster(
          `UPDATE companies
           SET subscription_status = 'past_due',
               graceful_read_only_until = DATE_ADD(NOW(), INTERVAL 7 DAY)
           WHERE id = ?`,
          [companyId]
        );
        sendAlert('Payment Failed for Workspace', { companyId, eventType });
      } else if (eventType === 'subscription_canceled' || eventType === 'customer.subscription.deleted') {
        await queryMaster(
          `UPDATE companies
           SET subscription_status = 'canceled',
               canceled_at = NOW()
           WHERE id = ?`,
          [companyId]
        );
      } else if (eventType === 'trial_will_end') {
        logger.info(`Trial ending soon for company [${companyId}]`, { companyId });
      }
    }

    return res.json({ received: true });
  } catch (err) {
    logger.error(`Webhook processing error for event [${eventId}]`, { error: err.message });
    return res.status(500).json({ error: 'Failed to process webhook event' });
  }
});

module.exports = router;
