"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendReportReadyNotification = sendReportReadyNotification;
exports.sendReliabilityRejectedNotification = sendReliabilityRejectedNotification;
exports.sendPasswordResetEmail = sendPasswordResetEmail;
const client_ses_1 = require("@aws-sdk/client-ses");
// Ensure data sovereignty by binding strictly to AWS Sydney Region (ap-southeast-2)
const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-2';
const FROM_EMAIL = process.env.SES_FROM_EMAIL || 'reports@qeeg.com.au';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://qeeg.com.au';
let sesClient = null;
function getSESClient() {
    if (sesClient)
        return sesClient;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
        console.warn('[Amazon SES] AWS credentials not detected. Running emailService in simulation/local logging mode (Sydney ap-southeast-2 compliant).');
        return null;
    }
    sesClient = new client_ses_1.SESClient({
        region: AWS_REGION,
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
    });
    return sesClient;
}
/**
 * Dispatches automated transactional notification when a correlation report is ready for download.
 */
async function sendReportReadyNotification(toEmail, practitionerName, caseReference, downloadUrl) {
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
async function sendReliabilityRejectedNotification(toEmail, practitionerName, caseReference, reliabilityScore) {
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
/**
 * Dispatches password reset link to referring practitioner.
 */
async function sendPasswordResetEmail(toEmail, resetUrl) {
    const subject = `[QEEG.com.au] Password Reset Request`;
    const htmlBody = `
    <!DOCTYPE html>
    <html>
      <body style="font-family: sans-serif; color: #1e293b; padding: 20px;">
        <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 32px;">
          <h2 style="color: #16233b; margin-top: 0;">Password Reset</h2>
          <p>We received a request to reset your QEEG.com.au portal password. Click the link below to set a new password:</p>
          <p style="text-align: center; margin: 24px 0;">
            <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #16233b; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600;">Reset Password</a>
          </p>
          <p style="font-size: 12px; color: #64748b;">This link will expire in 2 hours. If you did not make this request, you can safely ignore this email.</p>
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
/**
 * Underlying helper sending emails via AWS SES (Sydney ap-southeast-2).
 */
async function sendEmail({ to, subject, html, text, }) {
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
        const command = new client_ses_1.SendEmailCommand({
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
    }
    catch (error) {
        console.error('[Amazon SES Error]', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown SES error',
        };
    }
}
