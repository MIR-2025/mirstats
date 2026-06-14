// Nodemailer transport + magic-link email. Falls back to console logging
// when SMTP is not configured (handy in dev).
import nodemailer from 'nodemailer';

let transport = null;

function getTransport() {
  if (transport) return transport;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE) === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transport;
}

export async function sendMagicLink(to, link) {
  const siteName = process.env.SITE_NAME || 'Our site';
  const t = getTransport();

  if (!t) {
    console.log(`[magic-link] (SMTP not configured) ${to} -> ${link}`);
    return { sent: false };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await t.sendMail({
    from: `${siteName} <${from}>`,
    to,
    subject: `Your sign-in link for ${siteName}`,
    text: `Sign in to ${siteName}:\n\n${link}\n\nThis link works once and expires in 15 minutes. Open it in this same browser.`,
    html: `<p>Sign in to <strong>${siteName}</strong>:</p>
<p><a href="${link}">Sign in</a></p>
<p style="color:#666;font-size:13px">This link works once and expires in 15 minutes. Open it in the same browser you requested it from.</p>`,
  });
  return { sent: true };
}
