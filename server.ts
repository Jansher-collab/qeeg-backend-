import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import path from 'path';
import fs from 'fs/promises';
import { prisma } from './lib/prisma';
import {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  createPasswordResetToken,
  validatePasswordResetToken,
  getSessionCookieName,
  getSessionCookieOptions,
} from './lib/services/authService';
import { verifyIngestionPayload } from './lib/services/reliabilityParser';
import {
  authorisePayment,
  capturePayment,
  voidPayment,
  getReportFeeAUD,
  setReportFeeAUD,
} from './lib/services/paypalService';
import { compileCorrelationReport } from './lib/services/correlationEngine';
import { sendReportReadyNotification } from './lib/services/emailService';
import { generatePreFilledChecklistPDF } from './lib/services/pdfService';
import { logActivity, getActivityLogs } from './lib/services/activityLogger';
import { UserRole } from '@prisma/client';

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// 1. Core Middlewares
app.use(
  cors({
    origin: [
      FRONTEND_URL,
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// 2. Session Configuration (Australian Data Sovereignty: Local Session State)
app.use(
  session({
    secret: process.env.JWT_SECRET || 'qeeg-sydney-secure-jwt-secret-2026-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// 3. Auth Helper Middleware
async function authenticateUser(req: Request, res: Response, next: NextFunction) {
  try {
    const token =
      req.cookies[getSessionCookieName()] ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.substring(7)
        : undefined);

    if (!token) {
      return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }

    const payload = verifyToken(token);
    if (!payload?.userId) {
      return res.status(401).json({ error: 'Invalid or expired session token.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { practitionerProfile: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'User account not found.' });
    }

    (req as any).user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed.' });
  }
}

// ----------------------------------------------------
// Health Check & Root
// ----------------------------------------------------
app.get('/health', async (req: Request, res: Response) => {
  try {
    let dbStatus = 'connected';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'disconnected';
    }

    res.json({
      status: 'healthy',
      server: 'QEEG.com.au Backend VPS',
      region: 'ap-southeast-2 (Sydney)',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      port: PORT,
    });
  } catch (err: any) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'QEEG.com.au Sovereign Backend API',
    region: 'ap-southeast-2 (Sydney, Australia)',
    version: '1.0.0',
    documentation: 'https://qeeg.com.au/the-science',
  });
});

// ----------------------------------------------------
// 1. Authentication Routes
// ----------------------------------------------------
app.post('/api/auth/signup', async (req: Request, res: Response) => {
  try {
    const {
      email,
      password,
      fullName,
      professionalTitle,
      professionType,
      profession,
      providerNumber,
      practiceName,
      clinicName,
      practiceAddress,
      practicePhone,
      phone,
      practiceEmail,
      notificationEmail,
      role = 'PRACTITIONER',
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    if (existingUser) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await hashPassword(password);
    const assignedRole = role === 'NEUROSCIENTIST' ? UserRole.NEUROSCIENTIST : UserRole.PRACTITIONER;

    const resolvedProfession = professionType?.trim() || profession?.trim() || null;
    const resolvedClinic = practiceName?.trim() || clinicName?.trim() || null;
    const resolvedPhone = practicePhone?.trim() || phone?.trim() || null;

    const newUser = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        passwordHash,
        role: assignedRole,
        practitionerProfile: {
          create: {
            fullName: fullName?.trim() || null,
            professionalTitle: professionalTitle?.trim() || null,
            professionType: resolvedProfession,
            profession: resolvedProfession,
            providerNumber: providerNumber?.trim() || null,
            practiceName: resolvedClinic,
            clinicName: resolvedClinic,
            practiceAddress: practiceAddress?.trim() || null,
            practicePhone: resolvedPhone,
            phone: resolvedPhone,
            practiceEmail: practiceEmail?.trim() || email.toLowerCase().trim(),
            notificationEmail: notificationEmail?.trim() || email.toLowerCase().trim(),
          },
        },
      },
      include: { practitionerProfile: true },
    });

    await logActivity({
      userId: newUser.id,
      action: 'PRACTITIONER_REGISTERED',
      details: { role: newUser.role, clinicName: newUser.practitionerProfile?.clinicName },
      ipAddress: req.ip || '127.0.0.1',
    });

    console.log('\n======================================================');
    console.log(`[PostgreSQL DB] 👤 User Registered: ${newUser.email} (ID: ${newUser.id})`);
    console.log(`[PostgreSQL DB] 🏥 Profile Linked: ${newUser.practitionerProfile?.fullName || 'N/A'} - ${newUser.practitionerProfile?.clinicName || 'N/A'}`);
    console.log('======================================================\n');

    res.status(201).json({
      message: 'Account created successfully. Please log in.',
      user: {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
        practitionerProfile: newUser.practitionerProfile,
      },
    });
  } catch (error: any) {
    console.error('[PostgreSQL DB ERROR] Signup error:', error);
    res.status(500).json({ error: error.message || 'Failed to create account.' });
  }
});

// Alias for /api/auth/register
app.post('/api/auth/register', async (req: Request, res: Response) => {
  // Re-route to signup handler
  const signupHandler = app._router.stack.find((layer: any) => layer.route?.path === '/api/auth/signup');
  if (signupHandler) {
    return signupHandler.handle(req, res);
  }
  res.status(404).json({ error: 'Endpoint not found.' });
});

// Diagnostic & Verification Endpoint: List registered users in database
app.get('/api/auth/users', async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
        practitionerProfile: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ count: users.length, users });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { practitionerProfile: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    const cookieOpts = getSessionCookieOptions();
    res.cookie(cookieOpts.name, token, cookieOpts);

    await logActivity({
      userId: user.id,
      action: 'USER_LOGGED_IN',
      details: { role: user.role },
      ipAddress: req.ip || '127.0.0.1',
    });

    res.json({
      message: 'Logged in successfully.',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        practitionerProfile: user.practitionerProfile,
      },
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message || 'Login failed.' });
  }
});

app.get('/api/auth/me', authenticateUser, (req: Request, res: Response) => {
  const user = (req as any).user;
  res.json({
    authenticated: true,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      practitionerProfile: user.practitionerProfile,
    },
  });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  res.clearCookie(getSessionCookieName(), { path: '/' });
  res.json({ message: 'Logged out successfully.' });
});

// ----------------------------------------------------
// 2. Checklist Download Route (Personalized AcroForm PDF)
// ----------------------------------------------------
app.get('/api/checklist/download', async (req: Request, res: Response) => {
  try {
    let practitioner = {
      fullName: 'Registered Referring Practitioner',
      professionalTitle: '',
      profession: 'Clinical Practitioner',
      providerNumber: 'N/A',
      clinicName: 'Clinical Practice',
      practiceAddress: 'Australia',
      phone: '',
      practiceEmail: '',
    };

    // Resolve authenticated practitioner from session token or latest database record
    const token =
      req.cookies[getSessionCookieName()] ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.substring(7)
        : undefined);

    let user = null;
    if (token) {
      const payload = verifyToken(token);
      if (payload?.userId) {
        user = await prisma.user.findUnique({
          where: { id: payload.userId },
          include: { practitionerProfile: true },
        });
      }
    }

    if (!user?.practitionerProfile) {
      user = await prisma.user.findFirst({
        where: { role: 'PRACTITIONER' },
        include: { practitionerProfile: true },
        orderBy: { createdAt: 'desc' },
      });
    }

    if (user?.practitionerProfile) {
      const prof = user.practitionerProfile;
      practitioner = {
        fullName: prof.fullName || 'Registered Referring Practitioner',
        professionalTitle: prof.professionalTitle || '',
        profession: prof.profession || 'Clinical Practitioner',
        providerNumber: prof.providerNumber || 'N/A',
        clinicName: prof.clinicName || 'Clinical Practice',
        practiceAddress: prof.practiceAddress || 'Australia',
        phone: prof.phone || '',
        practiceEmail: user.email,
      };
    }

    console.log(`[Checklist PDF] Generating pre-filled PDF for practitioner: ${practitioner.fullName} (${practitioner.clinicName})`);
    const pdfBuffer = await generatePreFilledChecklistPDF(practitioner);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="QEEG_Symptom_Checklist.pdf"');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(Buffer.from(pdfBuffer));
  } catch (error: any) {
    console.error('Checklist PDF generation error:', error);
    res.status(500).json({ error: 'Failed to generate symptom checklist PDF.' });
  }
});

// ----------------------------------------------------
// 3. Practitioner Reports & Profile
// ----------------------------------------------------
app.get('/api/practitioner/reports', authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const reports = await prisma.qeeqReport.findMany({
      where: { submittingPractitionerId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ reports });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch reports.' });
  }
});

app.get('/api/practitioner/profile', authenticateUser, (req: Request, res: Response) => {
  const user = (req as any).user;
  res.json({ profile: user.practitionerProfile });
});

app.put('/api/practitioner/profile', authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const body = req.body;

    const updatedProfile = await prisma.practitionerProfile.upsert({
      where: { userId: user.id },
      update: {
        fullName: body.fullName,
        professionalTitle: body.professionalTitle,
        profession: body.profession,
        providerNumber: body.providerNumber,
        clinicName: body.clinicName,
        practiceAddress: body.practiceAddress,
        phone: body.phone,
        practiceEmail: body.practiceEmail,
        notificationEmail: body.notificationEmail,
      },
      create: {
        userId: user.id,
        fullName: body.fullName,
        professionalTitle: body.professionalTitle,
        profession: body.profession,
        providerNumber: body.providerNumber,
        clinicName: body.clinicName,
        practiceAddress: body.practiceAddress,
        phone: body.phone,
        practiceEmail: body.practiceEmail,
        notificationEmail: body.notificationEmail,
      },
    });

    res.json({ message: 'Profile updated successfully.', profile: updatedProfile });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update profile.' });
  }
});

// ----------------------------------------------------
// 4. Report Submission & Correlation Pipeline
// ----------------------------------------------------
app.post('/api/reports/submit', authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const payload = req.body;

    // 1. Server-Side Reliability & De-Identification Quality Gate
    const verification = verifyIngestionPayload(payload);
    if (!verification.passed) {
      return res.status(400).json({
        error: verification.rejectionReason || 'Reliability score below mandatory 0.80 threshold.',
        reliabilityScore: verification.reliabilityScore,
        threshold: 0.80,
      });
    }

    // 2. Authorise PayPal Payment Hold ($65 AUD)
    const reportFee = await getReportFeeAUD();
    const authResult = await authorisePayment(payload.caseReference, reportFee);

    // 3. Create Report in Database
    const newReport = await prisma.qeeqReport.create({
      data: {
        caseReference: payload.caseReference,
        submittingPractitionerId: user.id,
        status: 'PAYMENT_AUTHORISED',
        reliabilityScore: verification.reliabilityScore,
        age: payload.age ?? verification.age ?? null,
        gender: payload.gender ?? verification.gender ?? null,
        handedness: payload.handedness ?? verification.handedness ?? null,
        tovaData: payload.tovaData ? JSON.parse(JSON.stringify(payload.tovaData)) : undefined,
        checklistData: payload.checklistData ? JSON.parse(JSON.stringify(payload.checklistData)) : undefined,
        feeAmount: reportFee,
        paypalAuthorizationId: authResult.authorizationId || `AUTH-MOCK-${Date.now()}`,
        paymentStatus: 'AUTHORISED',
      },
    });

    await logActivity({
      reportId: newReport.id,
      caseReference: newReport.caseReference,
      userId: user.id,
      action: 'PAYMENT_AUTHORISED',
      details: { amount: reportFee, authorizationId: newReport.paypalAuthorizationId },
      ipAddress: req.ip || '127.0.0.1',
    });

    res.status(201).json({
      message: 'Report submitted and payment authorized.',
      reportId: newReport.id,
      caseReference: newReport.caseReference,
      status: newReport.status,
      feeAmount: newReport.feeAmount,
    });
  } catch (error: any) {
    console.error('Submit report error:', error);
    res.status(500).json({ error: error.message || 'Submission failed.' });
  }
});

app.post('/api/reports/:id/generate', authenticateUser, async (req: Request, res: Response) => {
  try {
    const reportId = req.params.id as string;
    const report = await prisma.qeeqReport.findUnique({ where: { id: reportId } });

    if (!report) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    if (report.status === 'COMPLETED') {
      return res.json({ message: 'Report is already compiled.', reportId: report.id });
    }

    await prisma.qeeqReport.update({
      where: { id: reportId },
      data: { status: 'GENERATING' },
    });

    // Run Correlation Engine
    const compiledFindings = await compileCorrelationReport(
      report.caseReference,
      report.age ?? undefined,
      report.gender ?? undefined,
      report.handedness ?? undefined,
      report.tovaData as Record<string, unknown> | undefined,
      report.checklistData as Record<string, unknown> | undefined,
      report.reliabilityScore ?? undefined
    );

    // Save report artifact to server
    const reportsDir = path.join(process.cwd(), 'uploads', report.caseReference);
    await fs.mkdir(reportsDir, { recursive: true });
    const filePath = path.join(reportsDir, `QEEG_Report_${report.caseReference}.json`);
    await fs.writeFile(filePath, JSON.stringify(compiledFindings, null, 2), 'utf-8');

    // Capture PayPal Payment
    let captureId = `CAP-MOCK-${reportId}`;
    if (report.paypalAuthorizationId) {
      const cap = await capturePayment(report.paypalAuthorizationId, report.feeAmount);
      if (cap.captureId) captureId = cap.captureId;
    }

    const updatedReport = await prisma.qeeqReport.update({
      where: { id: reportId },
      data: {
        status: 'COMPLETED',
        confidenceScore: compiledFindings.confidenceScore,
        findings: JSON.parse(JSON.stringify(compiledFindings)),
        reportSummary: compiledFindings.overallSummary,
        filePaths: [filePath],
        paypalCaptureId: captureId,
        paymentStatus: 'CAPTURED',
      },
    });

    // Trigger Amazon SES Email Notification
    try {
      const practitioner = await prisma.user.findUnique({
        where: { id: updatedReport.submittingPractitionerId },
        include: { practitionerProfile: true },
      });

      const recipient =
        practitioner?.practitionerProfile?.notificationEmail ||
        practitioner?.practitionerProfile?.practiceEmail ||
        practitioner?.email;

      if (recipient) {
        await sendReportReadyNotification(
          recipient,
          practitioner?.practitionerProfile?.fullName || 'Practitioner',
          updatedReport.caseReference,
          `${FRONTEND_URL}/portal`
        );
      }
    } catch (e) {
      console.warn('SES email notification issue:', e);
    }

    res.json({
      message: 'Report generated and payment captured.',
      reportId: updatedReport.id,
      caseReference: updatedReport.caseReference,
      status: updatedReport.status,
      confidenceScore: compiledFindings.confidenceScore,
      reportData: compiledFindings,
    });
  } catch (error: any) {
    console.error('Generate report error:', error);
    res.status(500).json({ error: error.message || 'Report generation failed.' });
  }
});

app.get('/api/reports/:id/download', authenticateUser, async (req: Request, res: Response) => {
  try {
    const reportId = req.params.id as string;
    const report = await prisma.qeeqReport.findUnique({ where: { id: reportId } });

    if (!report) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    if (report.status === 'DOWNLOADED_AND_PURGED') {
      return res.status(410).json({
        error: 'In accordance with our zero-retention policy, this report was permanently purged upon initial download.',
      });
    }

    // Execute Immediate Server Purge
    const reportsDir = path.join(process.cwd(), 'uploads', report.caseReference);
    await fs.rm(reportsDir, { recursive: true, force: true }).catch(() => {});

    await prisma.qeeqReport.update({
      where: { id: reportId },
      data: {
        status: 'DOWNLOADED_AND_PURGED',
        downloadedAt: new Date(),
        purgedAt: new Date(),
      },
    });

    res.json(report.findings || { caseReference: report.caseReference });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Download failed.' });
  }
});

// ----------------------------------------------------
// 5. Admin & Activity Logs
// ----------------------------------------------------
app.get('/api/activity-logs', authenticateUser, async (req: Request, res: Response) => {
  try {
    const logs = await getActivityLogs({ limit: 50 });
    res.json({ logs });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch logs.' });
  }
});

// ----------------------------------------------------
// Practitioner Portal Routes
// ----------------------------------------------------
app.get('/api/practitioner/profile', authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const profile = await prisma.practitionerProfile.findUnique({
      where: { userId: user.id }
    });
    res.json({ profile });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch profile' });
  }
});

app.get('/api/practitioner/reports', authenticateUser, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const reports = await prisma.qeeqReport.findMany({
      where: { submittingPractitionerId: user.id },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ reports });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch reports' });
  }
});

// 404 Handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
});

// Start Server
app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`[QEEG.com.au Backend] Server listening on port ${PORT}`);
  console.log(`[Region] ap-southeast-2 (Sydney, Australia Sovereign)`);
  console.log(`[CORS Allowed Origin] ${FRONTEND_URL}`);
  console.log(`[Healthcheck URL] http://localhost:${PORT}/health`);
  console.log('====================================================');
});
