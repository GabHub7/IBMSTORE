'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'viprnestore-jwt-fallback-secret-change-in-production';
const COOKIE_NAME = 'vipstore_auth';
const COOKIE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 jam

function signAdminToken() {
  return jwt.sign({ role: 'admin', sub: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

function getTokenFromReq(req) {
  return (req.cookies && req.cookies[COOKIE_NAME]) || null;
}

function isAdminReq(req) {
  const token = getTokenFromReq(req);
  if (!token) return false;
  const payload = verifyToken(token);
  return !!(payload && payload.role === 'admin');
}

// Middleware: isi res.locals
function authMiddleware(req, res, next) {
  const isAdmin = isAdminReq(req);
  res.locals.isAdmin = isAdmin;
  res.locals.user = isAdmin ? { id: 'admin', username: 'admin', isAdmin: true } : null;
  next();
}

// Middleware: proteksi route admin
function requireAdmin(req, res, next) {
  if (isAdminReq(req)) return next();
  return res.redirect('/admin-login');
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function checkPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

module.exports = {
  signAdminToken, verifyToken,
  setAuthCookie, clearAuthCookie,
  isAdminReq, authMiddleware, requireAdmin,
  hashPassword, checkPassword,
  COOKIE_NAME
};
