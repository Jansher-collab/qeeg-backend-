"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
const server_1 = require("next/server");
const prisma_1 = require("@/lib/backend/prisma");
const authService_1 = require("@/lib/backend/services/authService");
async function GET(req) {
    try {
        const user = await (0, authService_1.getAuthenticatedUser)(req);
        if (!user) {
            return server_1.NextResponse.json({ error: 'Unauthorized. Please log in to access your reports.' }, { status: 401 });
        }
        // Fetch reports for this practitioner
        const reports = await prisma_1.prisma.qeeqReport.findMany({
            where: {
                submittingPractitionerId: user.id,
            },
            orderBy: {
                createdAt: 'desc',
            },
            select: {
                id: true,
                caseReference: true,
                status: true,
                confidenceScore: true,
                reliabilityScore: true,
                age: true,
                gender: true,
                handedness: true,
                reportSummary: true,
                reviewerNotes: true,
                reviewedBy: true,
                reviewedAt: true,
                feeAmount: true,
                paymentStatus: true,
                createdAt: true,
                updatedAt: true,
                downloadedAt: true,
                purgedAt: true,
            },
        });
        return server_1.NextResponse.json({
            reports,
            count: reports.length,
        });
    }
    catch (error) {
        console.error('Error fetching practitioner reports:', error);
        return server_1.NextResponse.json({ error: error.message || 'Failed to fetch reports.' }, { status: 500 });
    }
}
