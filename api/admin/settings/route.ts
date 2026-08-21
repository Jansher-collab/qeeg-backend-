import { NextRequest, NextResponse } from 'next/server';
import { getReportFeeAUD, setReportFeeAUD } from '@/lib/backend/services/paypalService';
import { prisma } from '@/lib/backend/prisma';

export async function GET() {
  try {
    const currentFee = await getReportFeeAUD();
    const settings = await prisma.systemSetting.findMany();

    return NextResponse.json({
      reportFeeAUD: currentFee,
      currency: 'AUD',
      settings,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as any;
    if (typeof body.reportFeeAUD === 'number' && body.reportFeeAUD > 0) {
      const updatedFee = await setReportFeeAUD(body.reportFeeAUD);
      return NextResponse.json({
        message: 'Report fee updated successfully.',
        reportFeeAUD: updatedFee,
        currency: 'AUD',
      });
    }

    return NextResponse.json({ error: 'Invalid reportFeeAUD value.' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}
