"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.generateToken = generateToken;
exports.verifyToken = verifyToken;
exports.getSessionCookieName = getSessionCookieName;
exports.getSessionCookieOptions = getSessionCookieOptions;
exports.createPasswordResetToken = createPasswordResetToken;
exports.validatePasswordResetToken = validatePasswordResetToken;
exports.getAuthenticatedUser = getAuthenticatedUser;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const prisma_1 = require("../prisma");
const JWT_SECRET = process.env.JWT_SECRET || 'qeeg-sydney-secure-jwt-secret-2026-production';
const SESSION_COOKIE_NAME = 'qeeg_session_token';
const TOKEN_EXPIRY = '7d';
async function hashPassword(password) {
    const salt = await bcryptjs_1.default.genSalt(10);
    return bcryptjs_1.default.hash(password, salt);
}
async function verifyPassword(password, hash) {
    return bcryptjs_1.default.compare(password, hash);
}
function generateToken(payload) {
    return jsonwebtoken_1.default.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}
function verifyToken(token) {
    try {
        return jsonwebtoken_1.default.verify(token, JWT_SECRET);
    }
    catch (error) {
        return null;
    }
}
function getSessionCookieName() {
    return SESSION_COOKIE_NAME;
}
function getSessionCookieOptions() {
    return {
        name: SESSION_COOKIE_NAME,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 7, // 7 days
    };
}
/**
 * Creates a secure password reset token valid for 1 hour
 */
async function createPasswordResetToken(email) {
    const token = crypto_1.default.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    // Invalidate any existing unused reset tokens for this email
    await prisma_1.prisma.passwordResetToken.updateMany({
        where: { email: email.toLowerCase().trim(), used: false },
        data: { used: true },
    });
    await prisma_1.prisma.passwordResetToken.create({
        data: {
            email: email.toLowerCase().trim(),
            token,
            expiresAt,
            used: false,
        },
    });
    return token;
}
/**
 * Validates a password reset token
 */
async function validatePasswordResetToken(token) {
    const record = await prisma_1.prisma.passwordResetToken.findUnique({
        where: { token },
    });
    if (!record || record.used || record.expiresAt < new Date()) {
        return null;
    }
    return record;
}
/**
 * Extracts and validates the authenticated user from a Next.js Request or Next.js Cookies
 */
async function getAuthenticatedUser(request) {
    try {
        let token;
        if (request) {
            // 1. Check Cookie header
            const cookieHeader = request.headers.get('cookie');
            if (cookieHeader) {
                const cookies = Object.fromEntries(cookieHeader.split(';').map((c) => {
                    const [k, ...v] = c.trim().split('=');
                    return [k, decodeURIComponent(v.join('='))];
                }));
                token = cookies[SESSION_COOKIE_NAME];
            }
            // 2. Check Authorization header
            if (!token) {
                const authHeader = request.headers.get('authorization');
                if (authHeader?.startsWith('Bearer ')) {
                    token = authHeader.substring(7);
                }
            }
        }
        if (!token) {
            return null;
        }
        const payload = verifyToken(token);
        if (!payload?.userId) {
            return null;
        }
        // Fetch user with practitioner profile
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: payload.userId },
            include: {
                practitionerProfile: true,
            },
        });
        if (!user) {
            return null;
        }
        return {
            id: user.id,
            email: user.email,
            role: user.role,
            practitionerProfile: user.practitionerProfile,
        };
    }
    catch (error) {
        console.error('Error authenticating user:', error);
        return null;
    }
}
