"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
exports.POST = POST;
const server_1 = require("next/server");
const paypalService_1 = require("@/lib/backend/services/paypalService");
const prisma_1 = require("@/lib/backend/prisma");
async function GET() {
    try {
        const currentFee = await (0, paypalService_1.getReportFeeAUD)();
        const settings = await prisma_1.prisma.systemSettings.findMany();
        return server_1.NextResponse.json({
            reportFeeAUD: currentFee,
            currency: 'AUD',
            settings,
        });
    }
    catch (error) {
        return server_1.NextResponse.json({ error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
    }
}
async function POST(req) {
    try {
        const body = (await req.json());
        if (typeof body.reportFeeAUD === 'number' && body.reportFeeAUD > 0) {
            const updatedFee = await (0, paypalService_1.setReportFeeAUD)(body.reportFeeAUD);
            return server_1.NextResponse.json({
                message: 'Report fee updated successfully.',
                reportFeeAUD: updatedFee,
                currency: 'AUD',
            });
        }
        return server_1.NextResponse.json({ error: 'Invalid reportFeeAUD value.' }, { status: 400 });
    }
    catch (error) {
        return server_1.NextResponse.json({ error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
    }
}
