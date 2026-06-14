// Route guards based on the session user.
export function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/auth/login');
}

export function requireAdmin(req, res, next) {
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase();
  if (req.session?.user?.email?.toLowerCase() === adminEmail && adminEmail) {
    return next();
  }
  return res.status(403).render('errors/404', { pageTitle: 'Forbidden' });
}
