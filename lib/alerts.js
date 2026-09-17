const logger = require('./logger');

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || null;

async function sendAlert(title, details = {}) {
  const alertPayload = {
    title: `[ERP PLATFORM ALERT] ${title}`,
    timestamp: new Date().toISOString(),
    details
  };

  logger.error(`ALERT TRIGGERED: ${title}`, details);

  if (ALERT_WEBHOOK_URL) {
    try {
      await fetch(ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🚨 *${alertPayload.title}*\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\``
        })
      });
    } catch (err) {
      logger.error('Failed to dispatch alert webhook', { error: err.message });
    }
  }
}

module.exports = { sendAlert };
