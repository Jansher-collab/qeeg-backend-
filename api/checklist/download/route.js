"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
const server_1 = require("next/server");
const prisma_1 = require("@/lib/prisma");
const authService_1 = require("@/lib/services/authService");
const pdfService_1 = require("@/lib/services/pdfService");
async function GET(req) {
    try {
        const authUser = await (0, authService_1.getAuthenticatedUser)(req);
        if (!authUser) {
            return server_1.NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
        }
        const userWithProfile = await prisma_1.prisma.user.findUnique({
            where: { id: authUser.id },
            include: { practitionerProfile: true },
        });
        const profile = userWithProfile?.practitionerProfile;
        const pdfBuffer = await (0, pdfService_1.generatePreFilledChecklistPDF)({
            fullName: profile?.fullName || authUser.email.split('@')[0],
            professionalTitle: profile?.professionalTitle || undefined,
            profession: profile?.profession || undefined,
            providerNumber: profile?.providerNumber || undefined,
            clinicName: profile?.clinicName || undefined,
            practiceAddress: profile?.practiceAddress || undefined,
            phone: profile?.phone || undefined,
            practiceEmail: profile?.practiceEmail || authUser.email,
        });
        return new server_1.NextResponse(Buffer.from(pdfBuffer), {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': 'attachment; filename="QEEG_Symptom_Checklist.pdf"',
                'Cache-Control': 'no-store, max-age=0',
            },
        });
    }
    catch (error) {
        console.error('[Checklist PDF Download Error]', error);
        return server_1.NextResponse.json({ error: error.message || 'Failed to generate symptom checklist PDF.' }, { status: 500 });
    }
}
