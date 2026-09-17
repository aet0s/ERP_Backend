const crypto = require('crypto');

const BILLING_PROVIDER = (process.env.BILLING_PROVIDER || 'stripe').toLowerCase();
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'rzp_secret_placeholder';

async function createCheckoutSession({ companyId, companyEmail, plan = 'pro', returnUrl }) {
  const base = process.env.FRONTEND_URL || 'http://localhost:5173';
  const successUrl = `${base}/settings?billing=success`;
  const cancelUrl = `${base}/settings?billing=cancel`;

  if (BILLING_PROVIDER === 'stripe' && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require('stripe')(STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        customer_email: companyEmail,
        client_reference_id: companyId,
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: `ERP Studio ${plan.toUpperCase()} Plan Subscription` },
              unit_amount: plan === 'enterprise' ? 9900 : 2900,
              recurring: { interval: 'month' }
            },
            quantity: 1
          }
        ],
        mode: 'subscription',
        success_url: successUrl,
        cancel_url: cancelUrl
      });
      return { url: session.url, provider: 'stripe' };
    } catch (err) {
      console.warn('Stripe checkout fallback to simulated portal:', err.message);
    }
  }

  // Hosted Provider Checkout URL Fallback / Simulation
  const mockUrl = `${base}/settings?checkout_simulated=true&plan=${plan}&company_id=${companyId}`;
  return { url: mockUrl, provider: BILLING_PROVIDER };
}

async function createPortalSession({ companyId, customerId }) {
  const base = process.env.FRONTEND_URL || 'http://localhost:5173';
  if (BILLING_PROVIDER === 'stripe' && process.env.STRIPE_SECRET_KEY && customerId) {
    try {
      const stripe = require('stripe')(STRIPE_SECRET_KEY);
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${base}/settings`
      });
      return { url: session.url };
    } catch (err) {
      console.warn('Stripe portal fallback:', err.message);
    }
  }
  return { url: `${base}/settings?portal_simulated=true` };
}

function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature) return false;
  if (BILLING_PROVIDER === 'stripe') {
    try {
      const stripe = require('stripe')(STRIPE_SECRET_KEY);
      stripe.webhooks.constructEvent(rawBody, signature, secret || STRIPE_WEBHOOK_SECRET);
      return true;
    } catch (err) {
      console.warn('[WEBHOOK SIG VERIFY FAIL] Stripe signature verification failed:', err.message);
      return false;
    }
  } else if (BILLING_PROVIDER === 'razorpay') {
    const expected = crypto.createHmac('sha256', secret || RAZORPAY_KEY_SECRET).update(rawBody).digest('hex');
    return signature === expected;
  }
  return true;
}

module.exports = {
  createCheckoutSession,
  createPortalSession,
  verifyWebhookSignature
};
