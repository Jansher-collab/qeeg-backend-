"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
exports.PUT = PUT;
const server_1 = require("next/server");
const prisma_1 = require("@/lib/backend/prisma");
const authService_1 = require("@/lib/backend/services/authService");
async function GET(req) {
    try {
        const user = await (0, authService_1.getAuthenticatedUser)(req);
        if (!user) {
            return server_1.NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
        }
        const profile = await prisma_1.prisma.practitionerProfile.findUnique({
            where: { userId: user.id },
        });
        return server_1.NextResponse.json({ profile });
    }
    catch (error) {
        return server_1.NextResponse.json({ error: error.message }, { status: 500 });
    }
}
async function PUT(req) {
    try {
        const user = await (0, authService_1.getAuthenticatedUser)(req);
        if (!user) {
            return server_1.NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
        }
        const body = (await req.json());
        const { fullName, professionalTitle, profession, providerNumber, clinicName, practiceAddress, phone, practiceEmail, notificationEmail, } = body;
        const updatedProfile = await prisma_1.prisma.practitionerProfile.upsert({
            where: { userId: user.id },
            update: {
                fullName: fullName?.trim() || null,
                professionalTitle: professionalTitle?.trim() || null,
                profession: profession?.trim() || null,
                providerNumber: providerNumber?.trim() || null,
                clinicName: clinicName?.trim() || null,
                practiceAddress: practiceAddress?.trim() || null,
                phone: phone?.trim() || null,
                practiceEmail: practiceEmail?.trim() || null,
                notificationEmail: notificationEmail?.trim() || null,
            },
            create: {
                userId: user.id,
                fullName: fullName?.trim() || null,
                professionalTitle: professionalTitle?.trim() || null,
                profession: profession?.trim() || null,
                providerNumber: providerNumber?.trim() || null,
                clinicName: clinicName?.trim() || null,
                practiceAddress: practiceAddress?.trim() || null,
                phone: phone?.trim() || null,
                practiceEmail: practiceEmail?.trim() || null,
                notificationEmail: notificationEmail?.trim() || user.email,
            },
        });
        return server_1.NextResponse.json({
            message: 'Profile updated successfully.',
            profile: updatedProfile,
        });
    }
    catch (error) {
        return server_1.NextResponse.json({ error: error.message }, { status: 500 });
    }
}
