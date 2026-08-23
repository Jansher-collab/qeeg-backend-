"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GET = GET;
const server_1 = require("next/server");
const activityLogger_1 = require("@/lib/backend/services/activityLogger");
async function GET(req) {
    try {
        const { searchParams } = new URL(req.url);
        const caseReference = searchParams.get('caseReference') || undefined;
        const reportId = searchParams.get('reportId') || undefined;
        const userId = searchParams.get('userId') || undefined;
        const limitStr = searchParams.get('limit');
        const limit = limitStr ? parseInt(limitStr, 10) : 50;
        const logs = await (0, activityLogger_1.getActivityLogs)({
            caseReference,
            reportId,
            userId,
            limit,
        });
        return server_1.NextResponse.json({
            count: logs.length,
            logs,
        });
    }
    catch (error) {
        return server_1.NextResponse.json({ error: error instanceof Error ? error.message : 'Internal Server Error' }, { status: 500 });
    }
}
