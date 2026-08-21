import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookieName } from '@/lib/backend/services/authService';

export async function POST(req: NextRequest) {
  const response = NextResponse.json({ message: 'Logged out successfully.' });
  const cookieName = getSessionCookieName();

  response.cookies.set(cookieName, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return response;
}
