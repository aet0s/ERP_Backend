'use strict';

const nodemailer = require('nodemailer');

function createTransporter() {
  const user = (process.env.SMTP_USER || 'erpsolarman@gmail.com').trim();
  const pass = (process.env.SMTP_PASS || 'ybpwbiaodaspykth').replace(/\s+/g, '');

  // If custom SMTP host is set (non-gmail)
  if (process.env.SMTP_HOST && process.env.SMTP_HOST !== 'smtp.gmail.com') {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '465', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user, pass }
    });
  }

  // Gmail SMTP via official service configuration
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user,
      pass
    }
  });
}

/**
 * Send 6-digit registration verification OTP
 */
async function sendOtpEmail({ to, name, otp }) {
  console.log(`\n==================================================`);
  console.log(`[REGISTRATION OTP] Destination: ${to}`);
  console.log(`[REGISTRATION OTP] Verification Code: [ ${otp} ]`);
  console.log(`==================================================\n`);

  const from = process.env.EMAIL_FROM || '"ERP Studio" <erpsolarman@gmail.com>';
  const cleanName = name ? String(name).trim() : 'Valued Partner';

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>ERP Studio Security Verification</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #F4F1EA; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #202923;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #F4F1EA; padding: 40px 15px;">
        <tr>
          <td align="center">
            <table width="100%" max-width="540" cellpadding="0" cellspacing="0" border="0" style="max-width: 540px; background-color: #FFFFFF; border-radius: 16px; border: 1px solid #D3DFD9; overflow: hidden; box-shadow: 0 10px 25px rgba(13, 62, 47, 0.05);">
              
              <!-- Header Accent Line -->
              <tr>
                <td style="height: 4px; background: linear-gradient(90deg, #176B52, #0D3E2F);"></td>
              </tr>

              <!-- Brand Header -->
              <tr>
                <td style="padding: 32px 36px 20px 36px; border-bottom: 1px solid #EBF1EE;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td>
                        <span style="font-size: 18px; font-weight: 700; color: #0D3E2F; letter-spacing: -0.5px;">ERP Studio</span>
                        <span style="font-size: 11px; font-weight: 600; color: #8DA79A; text-transform: uppercase; letter-spacing: 1px; margin-left: 8px;">Enterprise Cloud</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Main Body -->
              <tr>
                <td style="padding: 36px 36px 28px 36px;">
                  <h1 style="margin: 0 0 12px 0; font-size: 22px; font-weight: 600; color: #202923; line-height: 1.3;">
                    Verify your identity
                  </h1>
                  <p style="margin: 0 0 24px 0; font-size: 14px; color: #4B5563; line-height: 1.6;">
                    Hello <strong>${cleanName}</strong>,<br>
                    Please use the following 6-digit verification code to complete your enterprise workspace registration:
                  </p>

                  <!-- OTP Token Box -->
                  <div style="background-color: #F4F1EA; border: 1px solid #D3DFD9; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
                    <div style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 36px; font-weight: 700; color: #0D3E2F; letter-spacing: 10px; margin-left: 10px;">
                      ${otp}
                    </div>
                    <div style="margin-top: 10px; font-size: 11px; color: #8DA79A; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">
                      Expires in 10 minutes
                    </div>
                  </div>

                  <p style="margin: 0 0 12px 0; font-size: 13px; color: #6B7280; line-height: 1.5;">
                    If you did not request this authorization code, you can safely ignore this email. No organization workspace will be created without this verification.
                  </p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="padding: 20px 36px; background-color: #FAF8F5; border-top: 1px solid #EBF1EE; font-size: 11px; color: #8DA79A; line-height: 1.5;">
                  ERP Studio Security & Compliance • TLS 1.3 End-to-End Cryptography<br>
                  © 2026 ERP Studio Inc. Automated System Notification.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const transporter = createTransporter();
  const info = await transporter.sendMail({
    from,
    to,
    subject: `ERP Studio — Your Registration Verification Code [${otp}]`,
    text: `Your ERP Studio verification code is ${otp}. This code expires in 10 minutes.`,
    html
  });

  console.log(`[SMTP SUCCESS] Sent OTP to ${to}, Message ID: ${info.messageId}`);
  return { ok: true, messageId: info.messageId };
}

/**
 * Send 6-digit password reset OTP email
 */
async function sendPasswordResetOtpEmail({ to, otp }) {
  console.log(`\n==================================================`);
  console.log(`[PASSWORD RESET OTP] Destination: ${to}`);
  console.log(`[PASSWORD RESET OTP] Verification Code: [ ${otp} ]`);
  console.log(`==================================================\n`);

  const from = process.env.EMAIL_FROM || '"ERP Studio" <erpsolarman@gmail.com>';

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>ERP Studio Password Recovery</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #F4F1EA; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #202923;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #F4F1EA; padding: 40px 15px;">
        <tr>
          <td align="center">
            <table width="100%" max-width="540" cellpadding="0" cellspacing="0" border="0" style="max-width: 540px; background-color: #FFFFFF; border-radius: 16px; border: 1px solid #D3DFD9; overflow: hidden; box-shadow: 0 10px 25px rgba(13, 62, 47, 0.05);">
              
              <!-- Header Accent Line -->
              <tr>
                <td style="height: 4px; background: linear-gradient(90deg, #176B52, #0D3E2F);"></td>
              </tr>

              <!-- Brand Header -->
              <tr>
                <td style="padding: 32px 36px 20px 36px; border-bottom: 1px solid #EBF1EE;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td>
                        <span style="font-size: 18px; font-weight: 700; color: #0D3E2F; letter-spacing: -0.5px;">ERP Studio</span>
                        <span style="font-size: 11px; font-weight: 600; color: #8DA79A; text-transform: uppercase; letter-spacing: 1px; margin-left: 8px;">Security & Account Recovery</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Main Body -->
              <tr>
                <td style="padding: 36px 36px 28px 36px;">
                  <h1 style="margin: 0 0 12px 0; font-size: 22px; font-weight: 600; color: #202923; line-height: 1.3;">
                    Reset your directory password
                  </h1>
                  <p style="margin: 0 0 24px 0; font-size: 14px; color: #4B5563; line-height: 1.6;">
                    We received a request to reset the password for your account (<strong>${to}</strong>). Use the verification code below to authorize this password reset:
                  </p>

                  <!-- OTP Token Box -->
                  <div style="background-color: #F4F1EA; border: 1px solid #D3DFD9; border-radius: 12px; padding: 24px; text-align: center; margin-bottom: 24px;">
                    <div style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 36px; font-weight: 700; color: #0D3E2F; letter-spacing: 10px; margin-left: 10px;">
                      ${otp}
                    </div>
                    <div style="margin-top: 10px; font-size: 11px; color: #8DA79A; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">
                      Valid for 10 minutes
                    </div>
                  </div>

                  <p style="margin: 0 0 12px 0; font-size: 13px; color: #6B7280; line-height: 1.5;">
                    If you did not initiate this request, your account may be compromised. Please notify your workspace administrator immediately.
                  </p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="padding: 20px 36px; background-color: #FAF8F5; border-top: 1px solid #EBF1EE; font-size: 11px; color: #8DA79A; line-height: 1.5;">
                  ERP Studio Security & Compliance • TLS 1.3 End-to-End Cryptography<br>
                  © 2026 ERP Studio Inc. Automated System Notification.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const transporter = createTransporter();
  const info = await transporter.sendMail({
    from,
    to,
    subject: `ERP Studio — Password Reset Code [${otp}]`,
    text: `Your ERP Studio password reset code is ${otp}. This code is valid for 10 minutes.`,
    html
  });

  console.log(`[SMTP SUCCESS] Sent password reset OTP to ${to}, Message ID: ${info.messageId}`);
  return { ok: true, messageId: info.messageId };
}

/**
 * Send Workspace, Vendor or Customer Invitation Email
 */
async function sendInvitationEmail({ to, name, inviterName, workspaceName, role, inviteType, inviteLink, expiresAt }) {
  console.log(`\n==================================================`);
  console.log(`[INVITATION EMAIL] Destination: ${to}`);
  console.log(`[INVITATION EMAIL] Type: ${inviteType} | Role: ${role}`);
  console.log(`[INVITATION EMAIL] Target URL: ${inviteLink}`);
  console.log(`==================================================\n`);

  const from = process.env.EMAIL_FROM || '"ERP Studio" <erpsolarman@gmail.com>';
  const cleanName = name ? String(name).trim() : 'Valued Partner';
  const cleanOrg = workspaceName ? String(workspaceName).trim() : 'ERP Workspace';
  const cleanRole = role ? String(role).replace(/_/g, ' ').toUpperCase() : (inviteType === 'vendor' ? 'SUPPLIER PARTNER' : (inviteType === 'customer' ? 'CLIENT PARTNER' : 'TEAM MEMBER'));

  let subject = `Invitation to join ${cleanOrg} on ERP Studio`;
  let badgeLabel = 'Team Member Invitation';
  let buttonText = 'Accept Invitation & Set Password';
  let inviteDescription = `You have been invited by ${inviterName ? `<strong>${inviterName}</strong> from ` : ''}<strong>${cleanOrg}</strong> to join the enterprise workspace as <strong>${cleanRole}</strong>.`;

  if (inviteType === 'vendor') {
    subject = `Invitation: Connect with ${cleanOrg} on ERP Vendor Portal`;
    badgeLabel = 'Supplier / Vendor Portal';
    buttonText = 'Access Vendor Portal & Connect';
    inviteDescription = `<strong>${cleanOrg}</strong> has invited your business to access their digital Vendor Portal. Collaborate seamlessly on Purchase Orders, Deliveries, and Invoices.`;
  } else if (inviteType === 'customer') {
    subject = `Invitation: Connect with ${cleanOrg} on ERP Customer Portal`;
    badgeLabel = 'Customer / Buyer Portal';
    buttonText = 'Access Customer Portal & Connect';
    inviteDescription = `<strong>${cleanOrg}</strong> has invited your organization to access their digital Customer Portal. Track Sales Orders, Invoices, Shipments, and Statements in real-time.`;
  }

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #F4F1EA; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #202923;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #F4F1EA; padding: 40px 15px;">
        <tr>
          <td align="center">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; background-color: #FFFFFF; border-radius: 16px; border: 1px solid #D3DFD9; overflow: hidden; box-shadow: 0 10px 25px rgba(13, 62, 47, 0.05);">
              
              <!-- Header Accent Bar -->
              <tr>
                <td style="height: 4px; background: linear-gradient(90deg, #176B52, #0D3E2F);"></td>
              </tr>

              <!-- Brand Header -->
              <tr>
                <td style="padding: 28px 36px 20px 36px; border-bottom: 1px solid #EBF1EE; background-color: #FAF8F5;">
                  <table width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td>
                        <span style="font-size: 19px; font-weight: 700; color: #0D3E2F; letter-spacing: -0.5px;">ERP Studio</span>
                        <span style="font-size: 11px; font-weight: 600; color: #8DA79A; text-transform: uppercase; letter-spacing: 1px; margin-left: 8px;">Enterprise Cloud</span>
                      </td>
                      <td align="right">
                        <span style="display: inline-block; padding: 4px 10px; font-size: 10px; font-weight: 700; color: #176B52; background-color: #EBF1EE; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px; border: 1px solid #D3DFD9;">
                          ${badgeLabel}
                        </span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Main Content Body -->
              <tr>
                <td style="padding: 36px 36px 28px 36px;">
                  <h1 style="margin: 0 0 14px 0; font-size: 22px; font-weight: 700; color: #202923; line-height: 1.3;">
                    You're invited to collaborate
                  </h1>
                  
                  <p style="margin: 0 0 20px 0; font-size: 15px; color: #4B5563; line-height: 1.6;">
                    Hello <strong>${cleanName}</strong>,
                  </p>

                  <p style="margin: 0 0 24px 0; font-size: 14px; color: #4B5563; line-height: 1.6;">
                    ${inviteDescription}
                  </p>

                  <!-- Invitation Details Box -->
                  <div style="background-color: #FAF8F5; border: 1px solid #D3DFD9; border-radius: 12px; padding: 18px 20px; margin-bottom: 28px;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 13px;">
                      <tr>
                        <td style="padding: 5px 0; color: #8DA79A; font-weight: 500; width: 120px;">Organization:</td>
                        <td style="padding: 5px 0; color: #202923; font-weight: 700;">${cleanOrg}</td>
                      </tr>
                      <tr>
                        <td style="padding: 5px 0; color: #8DA79A; font-weight: 500;">Assigned Role:</td>
                        <td style="padding: 5px 0; color: #176B52; font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px;">${cleanRole}</td>
                      </tr>
                      <tr>
                        <td style="padding: 5px 0; color: #8DA79A; font-weight: 500;">Recipient:</td>
                        <td style="padding: 5px 0; color: #202923; font-family: monospace;">${to}</td>
                      </tr>
                      <tr>
                        <td style="padding: 5px 0; color: #8DA79A; font-weight: 500;">Link Validity:</td>
                        <td style="padding: 5px 0; color: #6B7280; font-size: 12px;">7 days from issuance</td>
                      </tr>
                    </table>
                  </div>

                  <!-- Call to Action Button -->
                  <div style="text-align: center; margin-bottom: 30px;">
                    <a href="${inviteLink}" style="display: inline-block; background-color: #176B52; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 10px; box-shadow: 0 4px 12px rgba(23, 107, 82, 0.25);">
                      ${buttonText} &rarr;
                    </a>
                  </div>

                  <!-- Fallback Link Section -->
                  <div style="background-color: #F4F1EA; border: 1px dashed #D3DFD9; border-radius: 8px; padding: 14px; margin-bottom: 20px;">
                    <p style="margin: 0 0 6px 0; font-size: 11px; color: #6B7280; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                      Button not working? Copy and paste this link in your browser:
                    </p>
                    <a href="${inviteLink}" style="font-size: 11px; color: #176B52; word-break: break-all; text-decoration: underline; line-height: 1.4;">
                      ${inviteLink}
                    </a>
                  </div>

                  <p style="margin: 0; font-size: 12px; color: #8DA79A; line-height: 1.5;">
                    If you were not expecting this invitation, you can disregard this email. The link will safely expire automatically.
                  </p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="padding: 20px 36px; background-color: #FAF8F5; border-top: 1px solid #EBF1EE; font-size: 11px; color: #8DA79A; line-height: 1.5;">
                  ERP Studio Security & Compliance • TLS 1.3 Encrypted Transmission<br>
                  © 2026 ERP Studio Inc. Generated by active workspace administrator.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const transporter = createTransporter();
  const info = await transporter.sendMail({
    from,
    to,
    subject,
    text: `Hello ${cleanName},\n\nYou have been invited to join ${cleanOrg} on ERP Studio as ${cleanRole}.\n\nPlease accept your invitation here:\n${inviteLink}\n\nThis invitation is valid for 7 days.`,
    html
  });

  console.log(`[SMTP SUCCESS] Sent invitation email to ${to}, Message ID: ${info.messageId}`);
  return { ok: true, messageId: info.messageId };
}

module.exports = {
  createTransporter,
  sendOtpEmail,
  sendPasswordResetOtpEmail,
  sendInvitationEmail
};

