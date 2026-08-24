import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// Ensure data sovereignty by binding strictly to AWS Sydney Region (ap-southeast-2)
const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-2';
const FROM_EMAIL = process.env.SES_FROM_EMAIL || 'reports@qeeg.com.au';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://qeeg.com.au';

let sesClient: SESClient | null = null;

function getSESClient(): SESClient | null {
  if (sesClient) return sesClient;

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    console.warn(
      '[Amazon SES] AWS credentials not detected. Running emailService in simulation/local logging mode (Sydney ap-southeast-2 compliant).'
    );
    return null;
  }

  sesClient = new SESClient({
    region: AWS_REGION,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return sesClient;
}

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  simulated?: boolean;
  error?: string;
}

/**
 * Dispatches automated transactional notification when a correlation report is ready for download.
 */
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
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure (ap-southeast-2) &bull; Privacy Act 1988 &amp; Health Records Act 2001
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `Your QEEG correlation report for case ${caseReference} is ready for download at ${downloadUrl}. Please note that all data is permanently purged immediately upon download.`,
  });
}

/**
 * Dispatches notification when a QEEG fails server-side reliability verification.
 */
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

  return sendEmail({
    to: toEmail,
    subject,
    html: htmlBody,
    text: `Case ${caseReference} recorded a Test/Retest reliability score of ${reliabilityScore.toFixed(2)} (below the 0.80 threshold). No charge has been made and files have been purged.`,
  });
}

// ----------------------------------------------------
// Resend Auth Notification Emails
// ----------------------------------------------------

export async function sendWelcomeEmail(toEmail: string, username: string) {
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
          <div style="text-align: center; margin: 30px 0;">
            <a href="${APP_BASE_URL}/portal" class="btn">Go to Dashboard</a>
          </div>
          <p>If you have any questions, feel free to reply directly to this email.</p>
          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure
          </div>
        </div>
      </body>
    </html>
  `;

  if (!process.env.RESEND_API_KEY) {
    console.log(`[Simulated Email] Welcome Email to ${toEmail}`);
    return { success: true };
  }

  try {
    const data = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: toEmail,
      subject,
      html: htmlBody,
    });
    return { success: true, data };
  } catch (error) {
    console.error('[Resend Error]', error);
    return { success: false, error };
  }
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

  if (!process.env.RESEND_API_KEY) {
    console.log(`[Simulated Email] Password Reset Email to ${toEmail} with URL: ${resetUrl}`);
    return { success: true };
  }

  try {
    const data = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: toEmail,
      subject,
      html: htmlBody,
    });
    return { success: true, data };
  } catch (error) {
    console.error('[Resend Error]', error);
    return { success: false, error };
  }
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
            <a href="${APP_BASE_URL}/login" class="btn">Go to Login</a>
          </div>
          <p style="font-size: 13px; color: #64748b;">If you did not make this change, please immediately reply to this email to secure your account.</p>
          <div class="footer">
            Applied Neurosciences Pty Ltd &bull; Sovereign Australian Infrastructure
          </div>
        </div>
      </body>
    </html>
  `;

  if (!process.env.RESEND_API_KEY) {
    console.log(`[Simulated Email] Password Reset Confirmation Email to ${toEmail}`);
    return { success: true };
  }

  try {
    const data = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: toEmail,
      subject,
      html: htmlBody,
    });
    return { success: true, data };
  } catch (error) {
    console.error('[Resend Error]', error);
    return { success: false, error };
  }
}

/**
 * Underlying helper sending emails via AWS SES (Sydney ap-southeast-2).
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
  const client = getSESClient();

  if (!client) {
    console.log(`[Email Simulated (SES ap-southeast-2)] To: ${to} | Subject: ${subject}`);
    return {
      success: true,
      simulated: true,
      messageId: `SIMULATED-${Date.now()}`,
    };
  }

  try {
    const command = new SendEmailCommand({
      Source: FROM_EMAIL,
      Destination: {
        ToAddresses: [to],
      },
      Message: {
        Subject: {
          Data: subject,
          Charset: 'UTF-8',
        },
        Body: {
          Html: {
            Data: html,
            Charset: 'UTF-8',
          },
          Text: {
            Data: text,
            Charset: 'UTF-8',
          },
        },
      },
    });

    const response = await client.send(command);
    return {
      success: true,
      messageId: response.MessageId,
    };
  } catch (error) {
    console.error('[Amazon SES Error]', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown SES error',
    };
  }
}
