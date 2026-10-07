import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function createDashboardAuth(password) {
  if (password === null) return () => false;
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new Error('Set DASHBOARD_PASSWORD to a private password of 12-256 characters.');
  }
  const expected = createHash('sha256').update(password).digest();
  const sessions = new Map();
  const lifetime = 12 * 60 * 60 * 1000;
  let attempts = 0;
  let windowEnds = 0;
  return async (request, response, url, origin) => {
    const now = Date.now();
    for (const [token, expires] of sessions) if (expires <= now) sessions.delete(token);
    const cookieName = request.socket.encrypted ? '__Host-dashboard' : 'dashboard';
    const cookie = (request.headers.cookie || '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const loggedIn = sessions.has(cookie);
    const setCookie = (token, age) => response.setHeader('Set-Cookie',
      `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${request.socket.encrypted ? '; Secure' : ''}`);
    const redirect = (location) => { response.writeHead(303, { Location: location }); response.end(); };
    if (url.pathname === '/login' && request.method === 'GET') {
      if (loggedIn) { redirect('/'); return true; }
      return false;
    }
    if (['/login', '/logout'].includes(url.pathname) && request.method === 'POST') {
      if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site'
        || request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
        response.writeHead(403); response.end('Same-origin form required.'); return true;
      }
      if (url.pathname === '/logout') {
        sessions.delete(cookie); setCookie('', 0); redirect('/login'); return true;
      }
      if (now >= windowEnds) { attempts = 0; windowEnds = now + 60000; }
      if (++attempts > 10) {
        response.writeHead(429, { 'Retry-After': String(Math.ceil((windowEnds - now) / 1000)) });
        response.end('Too many login attempts. Try again in a minute.'); return true;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2048) { response.writeHead(413); response.end(); return true; }
        chunks.push(chunk);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const supplied = form.get('password') || '';
      if (form.getAll('password').length !== 1 || !timingSafeEqual(expected, createHash('sha256').update(supplied).digest())) {
        redirect('/login?error=1'); return true;
      }
      sessions.delete(cookie);
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('hex');
      sessions.set(token, now + lifetime);
      setCookie(token, lifetime / 1000); redirect('/'); return true;
    }
    if (url.pathname === '/font.woff2' && request.method === 'GET') return false;
    if (loggedIn) return false;
    if (['/', '/recordings'].includes(url.pathname) && request.method === 'GET') redirect('/login');
    else {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Sign in required.' }));
    }
    return true;
  };
}