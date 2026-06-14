// Magic-link auth (no passwords).
//
// Flow:
//   GET  /auth/login            -> email entry form
//   POST /auth/request-link     -> create token, email link, show "check email"
//   GET  /auth/verify/:token    -> validate (incl. same user-agent), show confirm button
//   POST /auth/confirm/:token   -> atomically claim token, set session, redirect home
//   POST /auth/logout           -> destroy session
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { collections } from '../lib/mongo.js';
import { sendMagicLink } from '../lib/mailer.js';

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

const router = express.Router();

router.get('/login', (req, res) => {
  res.render('auth/login', { pageTitle: 'Sign in', error: null });
});

router.post('/request-link', async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!email || !email.includes('@')) {
    return res.status(400).render('auth/login', {
      pageTitle: 'Sign in',
      error: 'Please enter a valid email address.',
    });
  }

  const token = uuidv4();
  await collections.magicTokens().insertOne({
    token,
    email,
    userAgent: req.headers['user-agent'] || '',
    used: false,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });

  const base = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  await sendMagicLink(email, `${base}/auth/verify/${token}`);

  // Always show the same screen, whether or not the email exists (no enumeration).
  res.render('auth/check-email', { pageTitle: 'Check your email', email });
});

router.get('/verify/:token', async (req, res) => {
  const doc = await collections.magicTokens().findOne({ token: req.params.token });

  if (!doc || doc.used || doc.expiresAt < new Date()) {
    return res.status(400).render('auth/expired', { pageTitle: 'Link expired' });
  }
  // Must be opened in the same browser/user-agent that requested it.
  if (doc.userAgent !== (req.headers['user-agent'] || '')) {
    return res.status(400).render('auth/expired', {
      pageTitle: 'Wrong browser',
      message: 'Please open the link in the same browser you requested it from.',
    });
  }

  // Show a confirm button — login completes only on the POST below.
  res.render('auth/confirm', {
    pageTitle: 'Confirm sign in',
    token: doc.token,
    email: doc.email,
  });
});

router.post('/confirm/:token', async (req, res) => {
  // Atomically claim the token so it can never be used twice.
  const claimed = await collections.magicTokens().findOneAndUpdate(
    { token: req.params.token, used: false, expiresAt: { $gt: new Date() } },
    { $set: { used: true, usedAt: new Date() } },
    { returnDocument: 'after' }
  );
  const doc = claimed?.value ?? claimed; // driver-version tolerant
  if (!doc) {
    return res.status(400).render('auth/expired', { pageTitle: 'Link expired' });
  }
  if (doc.userAgent !== (req.headers['user-agent'] || '')) {
    return res.status(400).render('auth/expired', { pageTitle: 'Wrong browser' });
  }

  // Upsert the user record and start the session.
  await collections.users().updateOne(
    { email: doc.email },
    { $set: { email: doc.email, lastLogin: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );

  req.session.user = { email: doc.email, loginAt: new Date() };
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

export default router;
