'use strict';

require('dotenv').config();
const { createTransporter } = require('../lib/mailer');

async function testSmtp() {
  const recipient = process.argv[2] || process.env.SMTP_USER || 'erpsolarman@gmail.com';
  const from = process.env.EMAIL_FROM || '"ERP Studio" <erpsolarman@gmail.com>';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  console.log('====================================================');
  console.log('          ERP Studio — SMTP Outgoing Diagnostic      ');
  console.log('====================================================');
  console.log(`[Config] SMTP User:     ${user || '(not set)'}`);
  console.log(`[Config] SMTP Pass:     ${pass ? '••••••••' + pass.slice(-4) : '(not set)'}`);
  console.log(`[Config] From:          ${from}`);
  console.log(`[Config] Target Recipient: ${recipient}`);
  console.log('----------------------------------------------------');

  const transporter = createTransporter();

  console.log('1. Verifying SMTP transporter connection...');
  try {
    await transporter.verify();
    console.log('   ✓ SMTP connection verified successfully!');
  } catch (err) {
    console.error('   ✕ SMTP connection failed:');
    console.error('     ' + err.message);
    process.exit(1);
  }

  console.log('\n2. Sending test email...');
  const testOtp = String(Math.floor(100000 + Math.random() * 900000));
  const timestamp = new Date().toISOString();

  try {
    const info = await transporter.sendMail({
      from,
      to: recipient,
      subject: `ERP Studio — Outgoing SMTP Test [${testOtp}]`,
      text: `This is an automated test email sent from ERP Studio at ${timestamp}. Verification Code: ${testOtp}`,
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #F4F1EA; padding: 30px; color: #202923;">
          <div style="max-width: 500px; margin: 0 auto; background: #fff; padding: 30px; border-radius: 12px; border: 1px solid #D3DFD9;">
            <h2 style="color: #0D3E2F; margin-top: 0;">ERP Studio Outgoing Test</h2>
            <p>Your SMTP mailer is functioning correctly and successfully sending outgoing emails.</p>
            <div style="background: #F4F1EA; padding: 15px; border-radius: 8px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 4px; color: #176B52;">
              ${testOtp}
            </div>
            <p style="font-size: 12px; color: #8DA79A; margin-top: 20px;">Timestamp: ${timestamp}</p>
          </div>
        </div>
      `
    });

    console.log('   ✓ Email sent successfully!');
    console.log(`   ✓ Message ID: ${info.messageId}`);
    console.log(`   ✓ Accepted:   ${JSON.stringify(info.accepted)}`);
    console.log('====================================================');
    console.log('SUCCESS: Outgoing mail system is 100% operational!');
    console.log('====================================================');
  } catch (err) {
    console.error('   ✕ Failed to send email:');
    console.error('     ' + err.message);
    process.exit(1);
  }
}

testSmtp();
