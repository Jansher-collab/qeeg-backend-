"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
const server_1 = require("next/server");
const prisma_1 = require("@/lib/backend/prisma");
const authService_1 = require("@/lib/backend/services/authService");
async function GET(req) {
    try {
        const user = await (0, authService_1.getAuthenticatedUser)(req);
        if (!user || (user.role !== 'NEUROSCIENTIST' && user.role !== 'ADMIN')) {
            return server_1.NextResponse.json({ error: 'Forbidden. Access restricted to Clinical Neuroscientists and Administrators.' }, { status: 403 });
        }
        // Fetch reports awaiting review or in processing
        const queue = await prisma_1.prisma.qeeqReport.findMany({
            where: {
                status: {
                    in: ['IN_NEUROSCIENTIST_REVIEW', 'GENERATING', 'PENDING_RELIABILITY', 'COMPLETED'],
                },
            },
            orderBy: {
                createdAt: 'desc',
            },
            include: {
                submittingPractitioner: {
                    select: {
                        email: true,
                        practitionerProfile: {
                            select: {
                                fullName: true,
                                clinicName: true,
                                profession: true,
                            },
                        },
                    },
                },
            },
        });
        return server_1.NextResponse.json({
            queue,
            count: queue.length,
        });
    }
    catch (error) {
        console.error('Error fetching review queue:', error);
        return server_1.NextResponse.json({ error: error.message }, { status: 500 });
    }
}
