import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/backend/services/authService';

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return NextResponse.json({ authenticated: false, user: null }, { status: 401 });
    }

    return NextResponse.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        practitionerProfile: user.practitionerProfile,
      },
    });
  } catch (error: any) {
    console.error('Error verifying auth session:', error);
    return NextResponse.json({ authenticated: false, user: null }, { status: 500 });
  }
}
