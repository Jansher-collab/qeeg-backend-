import nodemailer from 'nodemailer';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://qeeg.com.au';
const EMAIL_USER = process.env.EMAIL_USER || 'jansherkhan385@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'jkokryjjbjuhsprg';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  simulated?: boolean;
  error?: string;
}

/**
 * Underlying helper sending emails via Nodemailer (Gmail SMTP).
 */
async function sendNodemailerEmail({
  to,
  subject,
  html,
  text,
}: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<EmailSendResult> {
  try {
    const info = await transporter.sendMail({
      from: `"QEEG Portal" <${EMAIL_USER}>`,
      to,
      subject,
      text,
      html,
    });
    return {
      success: true,
      messageId: info.messageId,
    };
  } catch (error) {
    console.error('[Nodemailer Error]', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown email error',
    };
  }
}

// ----------------------------------------------------
// Auth Notification Emails
// ----------------------------------------------------

export async function sendWelcomeEmail(toEmail: string, username: string, ipAddress: string) {
  const subject = `Welcome to QEEG.com.au, ${username}!`;
  const htmlBody = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.6; background-color: #f8fafc; padding: 20px; }
          .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
          .header { border-bottom: 1px solid #f1f5f9; padding-bottom: 20px; margin-bottom: 24px; text-align: center; }
          .logo { font-size: 24px; font-weight: 700; color: #16233b; }
          .btn { display: inline-block; padding: 14px 28px; background-color: #16233b; color: #ffffff !important; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px; margin-top: 20px; }
          .footer { font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #f1f5f9; padding-top: 20px; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <div class="logo">QEEG.com.au</div>
          </div>
          <p>Hi ${username},</p>
          <p>Welcome to the QEEG.com.au Practitioner Portal. We are thrilled to have you on board.</p>
          <p>Your account is fully set up and you can now start securely uploading EEG files for correlation and analysis.</p>
          <p style="font-size: 13px; color: #64748b;">Registered from IP: ${ipAddress}</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${FRONTEND_URL}/portal" class="btn">Go to Dashboard</a>
          </div>
          <p>If you have any questions, feel free to reply directly to this email.</p>
          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure
          </div>
        </div>
      </body>
    </html>
  `;

  return sendNodemailerEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `Welcome ${username}! You can now access your dashboard at ${FRONTEND_URL}/portal. Registered from IP: ${ipAddress}`,
  });
}

export async function sendPasswordResetEmail(toEmail: string, resetUrl: string) {
  const subject = `[QEEG.com.au] Password Reset Request`;
  const htmlBody = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.6; background-color: #f8fafc; padding: 20px; }
          .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
          .header { border-bottom: 1px solid #f1f5f9; padding-bottom: 20px; margin-bottom: 24px; text-align: center; }
          .logo { font-size: 24px; font-weight: 700; color: #16233b; }
          .btn { display: inline-block; padding: 14px 28px; background-color: #16233b; color: #ffffff !important; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px; margin-top: 20px; }
          .footer { font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #f1f5f9; padding-top: 20px; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <div class="logo">QEEG.com.au</div>
          </div>
          <h2 style="color: #16233b; margin-top: 0;">Password Reset</h2>
          <p>We received a request to reset your QEEG.com.au portal password. Click the secure link below to set a new password:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" class="btn">Reset Password</a>
          </div>
          <p style="font-size: 13px; color: #64748b;">This link will expire in 1 hour. If you did not make this request, you can safely ignore this email.</p>
          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure
          </div>
        </div>
      </body>
    </html>
  `;

  return sendNodemailerEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `To reset your password, visit: ${resetUrl}`,
  });
}

export async function sendPasswordResetConfirmationEmail(toEmail: string, username: string) {
  const subject = `[QEEG.com.au] Your password has been updated`;
  const htmlBody = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.6; background-color: #f8fafc; padding: 20px; }
          .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
          .header { border-bottom: 1px solid #f1f5f9; padding-bottom: 20px; margin-bottom: 24px; text-align: center; }
          .logo { font-size: 24px; font-weight: 700; color: #16233b; }
          .badge { display: inline-block; padding: 6px 16px; border-radius: 9999px; background-color: #eaf4ef; color: #166534; font-size: 13px; font-weight: 600; margin-bottom: 12px; }
          .btn { display: inline-block; padding: 14px 28px; background-color: #16233b; color: #ffffff !important; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px; margin-top: 20px; }
          .footer { font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #f1f5f9; padding-top: 20px; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <div class="logo">QEEG.com.au</div>
          </div>
          <div style="text-align: center;">
            <span class="badge">PASSWORD UPDATED</span>
          </div>
          <p>Hi ${username},</p>
          <p>This is a confirmation that the password for your QEEG.com.au account was successfully updated.</p>
          <p>If you made this change, no further action is required. You can log in to your account with your new credentials.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${FRONTEND_URL}/login" class="btn">Go to Login</a>
          </div>
          <p style="font-size: 13px; color: #64748b;">If you did not make this change, please immediately reply to this email to secure your account.</p>
          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure
          </div>
        </div>
      </body>
    </html>
  `;

  return sendNodemailerEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `Your password has been updated. If this wasn't you, secure your account immediately.`,
  });
}

export async function sendLoginAlertEmail(toEmail: string, username: string, ipAddress: string) {
  const subject = `[Security Alert] New Login to your QEEG Account`;
  const htmlBody = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.6; background-color: #f8fafc; padding: 20px; }
          .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
          .header { border-bottom: 1px solid #f1f5f9; padding-bottom: 20px; margin-bottom: 24px; text-align: center; }
          .logo { font-size: 24px; font-weight: 700; color: #16233b; }
          .badge { display: inline-block; padding: 6px 16px; border-radius: 9999px; background-color: #fef3c7; color: #92400e; font-size: 13px; font-weight: 600; margin-bottom: 12px; }
          .btn { display: inline-block; padding: 14px 28px; background-color: #16233b; color: #ffffff !important; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px; margin-top: 20px; }
          .footer { font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #f1f5f9; padding-top: 20px; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <div class="logo">QEEG.com.au</div>
          </div>
          <div style="text-align: center;">
            <span class="badge">NEW LOGIN DETECTED</span>
          </div>
          <p>Hi ${username},</p>
          <p>We noticed a new login to your QEEG.com.au account.</p>
          <p><strong>IP Address:</strong> ${ipAddress}</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
          <p>If this was you, you can safely ignore this email.</p>
          <p style="font-size: 13px; color: #64748b; margin-top: 20px;">If you did not make this login, please immediately secure your account and reply to this email.</p>
          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure
          </div>
        </div>
      </body>
    </html>
  `;

  return sendNodemailerEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `New login detected from IP: ${ipAddress}. If this wasn't you, secure your account immediately.`,
  });
}

// ----------------------------------------------------
// System / Report Notification Emails
// ----------------------------------------------------

export async function sendReportReadyNotification(
  toEmail: string,
  practitionerName: string,
  caseReference: string,
  downloadUrl: string
): Promise<EmailSendResult> {
  const subject = `[QEEG.com.au] Report Ready for Download - Case ${caseReference}`;
  const htmlBody = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.6; background-color: #f8fafc; padding: 20px; }
          .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
          .header { border-bottom: 1px solid #f1f5f9; padding-bottom: 20px; margin-bottom: 24px; }
          .logo { font-size: 20px; font-weight: 700; color: #16233b; }
          .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; background-color: #eaf4ef; color: #166534; font-size: 12px; font-weight: 600; margin-bottom: 12px; }
          .btn { display: inline-block; padding: 14px 28px; background-color: #16233b; color: #ffffff !important; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 14px; margin-top: 20px; }
          .alert { background: #fef3c7; border: 1px solid #fde68a; border-radius: 10px; padding: 16px; margin: 24px 0; font-size: 13px; color: #92400e; }
          .footer { font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #f1f5f9; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <span class="badge">EVIDENCE CORRELATION COMPLETE</span>
            <div class="logo">QEEG.com.au</div>
          </div>
          <p>Dear ${practitionerName || 'Practitioner'},</p>
          <p>The correlation analysis for case reference <strong>${caseReference}</strong> has finished processing and is ready for secure one-time collection.</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${downloadUrl}" class="btn">Collect Report &rarr;</a>
          </div>

          <div class="alert">
            <strong>Important Retention Notice:</strong> In accordance with our Australian zero-retention protocol, all source files and the synthesized report are <strong>permanently destroyed from our Sydney servers the exact moment your download completes</strong>. Please save the file securely to your practice records.
          </div>

          <p style="font-size: 13px; color: #64748b;">
            If you did not request this report, please immediately contact <a href="mailto:reception@adhd.com.au">reception@adhd.com.au</a>.
          </p>

          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure &bull; Privacy Act 1988 &amp; Health Records Act 2001
          </div>
        </div>
      </body>
    </html>
  `;

  return sendNodemailerEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `Your QEEG correlation report for case ${caseReference} is ready for download at ${downloadUrl}. Please note that all data is permanently purged immediately upon download.`,
  });
}

export async function sendReliabilityRejectedNotification(
  toEmail: string,
  practitionerName: string,
  caseReference: string,
  reliabilityScore: number
): Promise<EmailSendResult> {
  const subject = `[QEEG.com.au] Reliability Threshold Notice - Case ${caseReference}`;
  const htmlBody = `
    <!DOCTYPE html>
    <html>
      <body style="font-family: sans-serif; color: #1e293b; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px;">
          <h2 style="color: #991b1b; margin-top: 0;">Submission Reliability Below Threshold</h2>
          <p>Dear ${practitionerName || 'Practitioner'},</p>
          <p>The QEEG file uploaded for case <strong>${caseReference}</strong> recorded a Test/Retest reliability score of <strong>${reliabilityScore.toFixed(2)}</strong>, which is below the mandatory quality threshold of <strong>0.80</strong>.</p>
          <p>In accordance with clinical standards, processing has halted, no data has been retained, and <strong>zero fee has been charged</strong> to your account.</p>
          <p>Please clean/artifact-reject your EEG recording and export fresh epochs from NeuroGuide before resubmitting.</p>
          <p style="font-size: 12px; color: #94a3b8; margin-top: 30px;">Applied Neurosciences Pty Ltd &bull; ap-southeast-2 Sydney</p>
        </div>
      </body>
    </html>
  `;

  return sendNodemailerEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `Case ${caseReference} recorded a Test/Retest reliability score of ${reliabilityScore.toFixed(2)} (below the 0.80 threshold). No charge has been made and files have been purged.`,
  });
}
