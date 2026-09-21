import * as postmark from 'postmark';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://qeeg.com.au';

// Outbound email is delivered exclusively through Postmark. There is no
// Nodemailer / SMTP / SES fallback. A missing token is surfaced as an error
// in production (see lib/config/env.ts) and as a logged simulation in
// development so local runs still work without credentials.
//
// The credentials are read LAZILY at send time — never at module load. Capturing
// them as module-scope constants (as a previous version did) silently switched
// all outbound mail into "logged only" mode whenever this module was imported
// before dotenv/config had populated process.env (e.g. one-off scripts/tests),
// even when a real token was present in .env.
function getEmailConfig() {
  return {
    serverToken: process.env.POSTMARK_SERVER_TOKEN || '',
    messageStream: process.env.POSTMARK_MESSAGE_STREAM || 'outbound',
    fromEmail: process.env.FROM_EMAIL || 'admin@qeeg.com.au',
    fromName: process.env.EMAIL_FROM_NAME || 'QEEG Portal',
  };
}

let postmarkClient: postmark.ServerClient | null = null;
let postmarkClientToken = '';

function getPostmarkClient(): postmark.ServerClient {
  const { serverToken } = getEmailConfig();
  if (!serverToken) {
    throw new Error('POSTMARK_SERVER_TOKEN is not set — outbound email cannot be sent.');
  }
  // Re-create the client if the token changed between calls (env loaded late or
  // swapped at runtime), so a stale client never silently uses a bad token.
  if (!postmarkClient || postmarkClientToken !== serverToken) {
    postmarkClient = new postmark.ServerClient(serverToken);
    postmarkClientToken = serverToken;
  }
  return postmarkClient;
}

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  simulated?: boolean;
  error?: string;
}

/**
 * Outbound email delivery via the Postmark transactional API.
 * When POSTMARK_SERVER_TOKEN is absent, the message is logged instead of sent
 * (development convenience) and flagged as simulated.
 */
async function sendEmail({
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
    const { serverToken, messageStream, fromEmail, fromName } = getEmailConfig();
    if (!serverToken) {
      console.log(`[Email:log-provider] To=${to} Subject="${subject}"\n${text}`);
      return { success: true, simulated: true, messageId: `sim-${Date.now()}` };
    }

    const res = await getPostmarkClient().sendEmail({
      From: `${fromName} <${fromEmail}>`,
      To: to,
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      MessageStream: messageStream,
    });
    return { success: true, messageId: res.MessageID };
  } catch (error) {
    // Extend the diagnostic value of every failure: log the HTTP status, the
    // Postmark API error code, AND the underlying fetch cause (e.g. DNS
    // failure "getaddrinfo EAI_AGAIN" or TLS error). A bare "fetch failed" is
    // useless for support — include the real reason in the returned error too.
    const { fromEmail } = getEmailConfig();
    const reason = error instanceof Error ? error.message : 'Unknown email error';
    const status = (error as any)?.status ?? (error as any)?.statusCode;
    const code = (error as any)?.code ?? (error as any)?.ErrorCode;
    const rawCause = (error as any)?.cause;
    const cause =
      rawCause instanceof Error
        ? `${rawCause.name}: ${rawCause.message}`
        : rawCause
          ? String(rawCause)
          : undefined;
    const details = [
      status !== undefined ? `http=${status}` : undefined,
      code !== undefined && code !== 0 ? `code=${code}` : undefined,
      cause ? `cause=${cause}` : undefined,
    ].filter(Boolean).join(' ');
    const detailLine = details ? `${reason} (${details})` : reason;
    console.error(
      `[Email Error (postmark)] to=${to} from=${fromEmail} subject="${subject}" — ${detailLine}`
    );
    return { success: false, error: detailLine };
  }
}

/**
 * Non-blocking connectivity self-test used at server/worker startup. Calls the
 * Postmark server endpoint (no message is sent) to prove reachability AND that
 * the configured token is valid. A failure here is logged loudly so a broken/
 * unreachable email path can never hide behind a silent "fetch failed" later.
 */
export async function checkEmailConnectivity(): Promise<EmailSendResult> {
  const { serverToken, fromEmail, messageStream } = getEmailConfig();
  if (!serverToken) {
    console.warn('[Email] POSTMARK_SERVER_TOKEN not set — outbound email is DISABLED (messages logged only).');
    return { success: false, error: 'POSTMARK_SERVER_TOKEN is not set.' };
  }
  try {
    const server = await getPostmarkClient().getServer();
    console.log(
      `[Email] Postmark reachable — server="${server.Name}" (id=${server.ID}); outbound mail is LIVE (from=${fromEmail}, stream=${messageStream}).`
    );
    return { success: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown email error';
    const rawCause = (error as any)?.cause;
    const cause =
      rawCause instanceof Error
        ? `${rawCause.name}: ${rawCause.message}`
        : rawCause
          ? String(rawCause)
          : undefined;
    const status = (error as any)?.status ?? (error as any)?.statusCode;
    const detailLine = [status !== undefined ? `http=${status}` : undefined, cause].filter(Boolean).join(' ');
    console.error(
      `[Email] Postmark connectivity check FAILED — ${reason}${detailLine ? ` (${detailLine})` : ''}. ` +
        'Registration/login/approval emails will NOT be delivered until this is resolved.'
    );
    return { success: false, error: detailLine ? `${reason} (${detailLine})` : reason };
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

  return sendEmail({
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

  return sendEmail({
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

  return sendEmail({
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

  return sendEmail({
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

          <p style="font-size: 13px; color: #64748b;">
            If you did not request this report, please immediately contact <a href="mailto:support@qeeg.com.au">support@qeeg.com.au</a>.
          </p>

          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure &bull; Privacy Act 1988 &amp; Health Records Act 2001
          </div>
        </div>
      </body>
    </html>
  `;

return sendEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `Your QEEG correlation report for case ${caseReference} is ready for download at ${downloadUrl}.`,
  });
}

export async function sendAdminRejectionNotification(
  toEmail: string,
  practitionerName: string,
  caseReference: string
): Promise<EmailSendResult> {
  const subject = `[QEEG.com.au] Case Declined - Authorization Voided for ${caseReference}`;
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
          .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; background-color: #fee2e2; color: #991b1b; font-size: 12px; font-weight: 600; margin-bottom: 12px; }
          .alert { background: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; padding: 16px; margin: 24px 0; font-size: 13px; color: #991b1b; }
          .footer { font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #f1f5f9; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <span class="badge">CASE DECLINED</span>
            <div class="logo">QEEG.com.au</div>
          </div>
          <p>Dear ${practitionerName || 'Practitioner'},</p>
          <p>The correlation analysis for case reference <strong>${caseReference}</strong> has been declined during administrative review.</p>
          
          <div class="alert">
            <strong>Payment Voided:</strong> Your PayPal authorization hold of $65 AUD has been fully voided. You have not been charged for this submission.
          </div>

          <p style="font-size: 13px; color: #64748b;">
            If you believe this was an error, please immediately contact <a href="mailto:support@qeeg.com.au">support@qeeg.com.au</a>.
          </p>

          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure &bull; Privacy Act 1988 &amp; Health Records Act 2001
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `Your QEEG correlation report for case ${caseReference} was declined. Your $65 AUD payment hold has been voided.`,
  });
}

export async function sendAdminApprovalNotification(
  toEmail: string,
  practitionerName: string,
  caseReference: string,
  dashboardUrl: string
): Promise<EmailSendResult> {
  const subject = `[QEEG.com.au] Case Approved & Processing - ${caseReference}`;
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
          .footer { font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #f1f5f9; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <span class="badge">CASE APPROVED</span>
            <div class="logo">QEEG.com.au</div>
          </div>
          <p>Dear ${practitionerName || 'Practitioner'},</p>
          <p>Your case reference <strong>${caseReference}</strong> has been reviewed and approved by our administrative team.</p>
          <p>Your payment of $65.00 AUD has been captured and the correlation analysis is now being generated. You will receive a separate email with a secure download link once the report is ready.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${dashboardUrl}" class="btn">View Dashboard &rarr;</a>
          </div>
          <p style="font-size: 13px; color: #64748b;">
            If you have any questions, please contact <a href="mailto:support@qeeg.com.au">support@qeeg.com.au</a>.
          </p>
          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure &bull; Privacy Act 1988 & Health Records Act 2001
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `Your case ${caseReference} has been approved and is now being processed. Your $65.00 AUD payment has been captured. You will receive a separate email with a secure download link once the report is ready. View your dashboard at ${dashboardUrl}`,
  });
}

/**
 * Dedicated retention-window notification sent to every practitioner with an
 * active/completed case still pending download whenever the admin updates the
 * global retention setting. States the exact configured day count and warns
 * that un-downloaded reports are automatically deleted once that period elapses.
 */
export async function sendRetentionUpdateNotification(
  toEmail: string,
  practitionerName: string,
  retentionDays: number,
  pendingCaseCount?: number
): Promise<EmailSendResult> {
  const dayLabel = retentionDays === 1 ? 'day' : 'days';
  const pendingLine =
    pendingCaseCount && pendingCaseCount > 0
      ? `You currently have <strong>${pendingCaseCount}</strong> ${pendingCaseCount === 1 ? 'report' : 'reports'} awaiting download.`
      : 'Your pending reports will remain retrievable for this period.';
  const subject = `[QEEG.com.au] Report Download Window Updated - ${retentionDays} ${dayLabel}`;
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
          .warning { background: #fef3c7; border: 1px solid #fde68a; border-radius: 10px; padding: 16px; margin: 24px 0; font-size: 13px; color: #92400e; }
          .footer { font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #f1f5f9; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <span class="badge">REPORT DOWNLOAD WINDOW</span>
            <div class="logo">QEEG.com.au</div>
          </div>
          <p>Dear ${practitionerName || 'Practitioner'},</p>
          <p>Our platform retention settings were recently updated. From now on, a completed report is available for download for <strong>${retentionDays} ${dayLabel}</strong>.</p>

          <div class="warning">
            <strong>Auto-deletion warning:</strong> Any report that is not downloaded within <strong>${retentionDays} ${dayLabel}</strong> of becoming available will be <strong>automatically and permanently deleted from our servers</strong>. Once deleted, the report cannot be recovered.
          </div>

          <p style="font-size: 13px; color: #64748b;">${pendingLine}</p>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${FRONTEND_URL}/portal" class="btn">Go to Dashboard &rarr;</a>
          </div>

          <p style="font-size: 13px; color: #64748b;">
            Please download and securely store any pending reports within your download window. If you have any questions, contact <a href="mailto:support@qeeg.com.au">support@qeeg.com.au</a>.
          </p>

          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure &bull; Privacy Act 1988 &amp; Health Records Act 2001
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `Our report retention settings were updated. Completed reports are now available for download for ${retentionDays} ${dayLabel}; any report not downloaded within that period will be automatically and permanently deleted from our servers. ${pendingCaseCount && pendingCaseCount > 0 ? `You currently have ${pendingCaseCount} report(s) awaiting download.` : ''} Please download and securely store your pending reports. View your dashboard at ${FRONTEND_URL}/portal.`,
  });
}

/**
 * Recurring auto-reminder (Spec: 3-day cadence) emailed to a practitioner whose
 * report is still pending download. States the exact case reference, the
 * download reminder, how many retention days remain before the report is
 * automatically deleted, and a secure link to the practitioner dashboard.
 */
export async function sendReportAutoReminderNotification(
  toEmail: string,
  practitionerName: string,
  caseReference: string,
  retentionDays: number,
  remainingDays: number,
  dashboardUrl: string
): Promise<EmailSendResult> {
  const dayLabel = retentionDays === 1 ? 'day' : 'days';
  const remainingLabel =
    remainingDays <= 1 ? 'less than 1 day' : `${remainingDays} days`;
  const subject = `[QEEG.com.au] Report ${caseReference} Awaiting Download`;
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
          .case-ref { display: inline-block; background-color: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 8px; padding: 4px 10px; font-family: monospace; font-weight: 600; color: #16233b; }
          .warning { background: #fef3c7; border: 1px solid #fde68a; border-radius: 10px; padding: 16px; margin: 24px 0; font-size: 13px; color: #92400e; }
          .footer { font-size: 12px; color: #94a3b8; margin-top: 32px; border-top: 1px solid #f1f5f9; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <span class="badge">REMINDER · REPORT PENDING DOWNLOAD</span>
            <div class="logo">QEEG.com.au</div>
          </div>
          <p>Dear ${practitionerName || 'Practitioner'},</p>
          <p>This is a friendly reminder that your completed QEEG correlation report for case reference <span class="case-ref">${caseReference}</span> is still awaiting download in your portal.</p>

          <div class="warning">
            <strong>Remaining download window:</strong> Your report is retained for <strong>${retentionDays} ${dayLabel}</strong> in total. Approximately <strong>${remainingLabel}</strong> remain before it is <strong>automatically and permanently deleted from our servers</strong>. Once deleted, the report cannot be recovered.
          </div>

          <p style="font-size: 13px; color: #64748b;">
            Please log in, download the report to your secure practice records, and save it before the window expires.
          </p>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${dashboardUrl}" class="btn">Go to Dashboard &rarr;</a>
          </div>

          <p style="font-size: 13px; color: #64748b;">
            If you believe you have already downloaded this report, you can safely ignore this email. For any questions, contact <a href="mailto:support@qeeg.com.au">support@qeeg.com.au</a>.
          </p>

          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure &bull; Privacy Act 1988 &amp; Health Records Act 2001
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `Reminder: report for case ${caseReference} is still awaiting download. It will be retained for ${retentionDays} ${dayLabel} in total; approximately ${remainingLabel} remain before it is automatically and permanently deleted from our servers. Please download it to your secure practice records before the window expires. View your dashboard at ${dashboardUrl}.`,
  });
}

