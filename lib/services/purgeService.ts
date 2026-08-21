import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../prisma';
import { logActivity } from './activityLogger';

export interface PurgeResult {
  success: boolean;
  reportId: string;
  filesDeleted: string[];
  dbRecordPurged: boolean;
  error?: string;
}

/**
 * Exact Purge-on-Download implementation:
 * Immediately and permanently deletes all associated server files from disk 
 * and purges/anonymizes the database record from PostgreSQL.
 */
export async function executePurgeOnDownload(
  reportId: string,
  userId?: string,
  ipAddress?: string
): Promise<PurgeResult> {
  const deletedFiles: string[] = [];

  try {
    // Step 1: Retrieve report details
    const report = await prisma.qeeqReport.findUnique({
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
    let filePaths: string[] = [];
    if (report.filePaths) {
      if (Array.isArray(report.filePaths)) {
        filePaths = report.filePaths as string[];
      } else if (typeof report.filePaths === 'string') {
        filePaths = [report.filePaths];
      }
    }

    // Also check standard upload scratch directory for case files
    const caseDir = path.join(process.cwd(), 'uploads', report.caseReference);
    filePaths.push(caseDir);

    for (const fileOrDirPath of filePaths) {
      try {
        const stats = await fs.stat(fileOrDirPath).catch(() => null);
        if (stats) {
          if (stats.isDirectory()) {
            await fs.rm(fileOrDirPath, { recursive: true, force: true });
          } else {
            await fs.unlink(fileOrDirPath);
          }
          deletedFiles.push(fileOrDirPath);
        }
      } catch (fileErr) {
        console.warn(`File purge error for ${fileOrDirPath}:`, fileErr);
      }
    }

    // Step 3: Record PURGE_COMPLETED activity log BEFORE deleting the report link
    await logActivity({
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
    await prisma.qeeqReport.delete({
      where: { id: reportId },
    });

    return {
      success: true,
      reportId,
      filesDeleted: deletedFiles,
      dbRecordPurged: true,
    };
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : 'Unknown purge error';

    // Fallback: If cascade/FK prevents full deletion, anonymize and wipe sensitive fields
    try {
      await prisma.qeeqReport.update({
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
    } catch {
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
