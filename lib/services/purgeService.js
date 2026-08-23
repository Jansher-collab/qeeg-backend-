"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executePurgeOnDownload = executePurgeOnDownload;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const prisma_1 = require("../prisma");
const activityLogger_1 = require("./activityLogger");
/**
 * Exact Purge-on-Download implementation:
 * Immediately and permanently deletes all associated server files from disk
 * and purges/anonymizes the database record from PostgreSQL.
 */
async function executePurgeOnDownload(reportId, userId, ipAddress) {
    const deletedFiles = [];
    try {
        // Step 1: Retrieve report details
        const report = await prisma_1.prisma.qeeqReport.findUnique({
            where: { id: reportId },
        });
        if (!report) {
            return {
                success: false,
                reportId,
                filesDeleted: [],
                dbRecordPurged: false,
                error: 'Report record not found for purging.',
            };
        }
        // Step 2: Unlink/delete physical files on disk
        let filePaths = [];
        if (report.filePaths) {
            if (Array.isArray(report.filePaths)) {
                filePaths = report.filePaths;
            }
            else if (typeof report.filePaths === 'string') {
                filePaths = [report.filePaths];
            }
        }
        // Also check standard upload scratch directory for case files
        const caseDir = path_1.default.join(process.cwd(), 'uploads', report.caseReference);
        filePaths.push(caseDir);
        for (const fileOrDirPath of filePaths) {
            try {
                const stats = await promises_1.default.stat(fileOrDirPath).catch(() => null);
                if (stats) {
                    if (stats.isDirectory()) {
                        await promises_1.default.rm(fileOrDirPath, { recursive: true, force: true });
                    }
                    else {
                        await promises_1.default.unlink(fileOrDirPath);
                    }
                    deletedFiles.push(fileOrDirPath);
                }
            }
            catch (fileErr) {
                console.warn(`File purge error for ${fileOrDirPath}:`, fileErr);
            }
        }
        // Step 3: Record PURGE_COMPLETED activity log BEFORE deleting the report link
        await (0, activityLogger_1.logActivity)({
            reportId: report.id,
            caseReference: report.caseReference,
            userId: userId || report.submittingPractitionerId,
            action: 'FILES_AND_RECORD_PURGED',
            details: {
                reason: 'Purge-on-Download completion policy',
                filesDeleted: deletedFiles,
                purgedAt: new Date().toISOString(),
            },
            ipAddress,
        });
        // Step 4: Delete the database record from PostgreSQL
        await prisma_1.prisma.qeeqReport.delete({
            where: { id: reportId },
        });
        return {
            success: true,
            reportId,
            filesDeleted: deletedFiles,
            dbRecordPurged: true,
        };
    }
    catch (error) {
        const errMessage = error instanceof Error ? error.message : 'Unknown purge error';
        // Fallback: If cascade/FK prevents full deletion, anonymize and wipe sensitive fields
        try {
            await prisma_1.prisma.qeeqReport.update({
                where: { id: reportId },
                data: {
                    status: 'DOWNLOADED_AND_PURGED',
                    tovaData: undefined,
                    checklistData: undefined,
                    findings: undefined,
                    reportSummary: undefined,
                    filePaths: undefined,
                    purgedAt: new Date(),
                },
            });
        }
        catch {
            // Ignore fallback error
        }
        return {
            success: false,
            reportId,
            filesDeleted: deletedFiles,
            dbRecordPurged: false,
            error: errMessage,
        };
    }
}
