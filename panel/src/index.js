require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const { getDb } = require('./config/database');
const authRouter = require('./routes/auth');
const wizardRouter = require('./routes/wizard');
const sitesRouter = require('./routes/sites');
const settingsRouter = require('./routes/settings');
const { getServerInfo, formatBytes } = require('./services/serverInfo');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'templates', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'upgs-panel-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true }
}));

async function setWizardCompleted(req, res, next) {
  res.locals.wizardCompleted = false;
  if (req.session && req.session.userId) {
    try {
      const db = await getDb();
      const row = db.prepare('SELECT completed FROM wizard_state LIMIT 1').get();
      res.locals.wizardCompleted = !!(row && row.completed);
    } catch (_) {}
  }
  next();
}
app.use(setWizardCompleted);

function setNavLocals(req, res, next) {
  res.locals.user = req.session && req.session.user ? req.session.user : null;
  const p = (req.path || '').replace(/\/$/, '') || '/';
  if (p === '/') res.locals.activeNav = 'dashboard';
  else if (p.startsWith('/wizard')) res.locals.activeNav = 'wizard';
  else if (p.startsWith('/sites')) res.locals.activeNav = 'sites';
  else if (p.startsWith('/databases')) res.locals.activeNav = 'databases';
  else if (p.startsWith('/mail')) res.locals.activeNav = 'mail';
  else if (p.startsWith('/settings')) res.locals.activeNav = 'settings';
  else res.locals.activeNav = '';
  next();
}
app.use(setNavLocals);

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/login');
}

async function requireWizardComplete(req, res, next) {
  const url = req.originalUrl || req.url;
  if (url.startsWith('/wizard') || url.startsWith('/auth') || url === '/login') return next();
  try {
    const db = await getDb();
    const row = db.prepare('SELECT completed FROM wizard_state LIMIT 1').get();
    if (row && row.completed) return next();
    res.redirect('/wizard');
  } catch (e) {
    next(e);
  }
}

app.use('/auth', authRouter);
app.use('/wizard', requireAuth, wizardRouter);
app.use('/sites', requireAuth, requireWizardComplete, sitesRouter);
app.use('/databases', requireAuth, requireWizardComplete, require('./routes/databases'));
app.use('/mail', requireAuth, requireWizardComplete, require('./routes/mail'));
app.use('/settings', requireAuth, settingsRouter);

app.get('/login', async (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  const db = await getDb();
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (count.c === 0) return res.redirect('/auth/setup');
  res.render('login');
});

app.get('/', requireAuth, requireWizardComplete, (req, res) => {
  let serverInfo = null;
  try {
    serverInfo = getServerInfo();
    serverInfo.memory.totalFormatted = formatBytes(serverInfo.memory.total);
    serverInfo.memory.usedFormatted = formatBytes(serverInfo.memory.used);
    if (serverInfo.swap && serverInfo.swap.total > 0) {
      serverInfo.swap.totalFormatted = formatBytes(serverInfo.swap.total);
      serverInfo.swap.usedFormatted = formatBytes(serverInfo.swap.used);
    }
    serverInfo.disk.totalFormatted = formatBytes(serverInfo.disk.total);
    serverInfo.disk.usedFormatted = formatBytes(serverInfo.disk.used);
  } catch (_) {}
  res.render('dashboard', { user: req.session.user, serverInfo });
});

function serverInfoJson() {
  const info = getServerInfo();
  info.memory.totalFormatted = formatBytes(info.memory.total);
  info.memory.usedFormatted = formatBytes(info.memory.used);
  if (info.swap && info.swap.total > 0) {
    info.swap.totalFormatted = formatBytes(info.swap.total);
    info.swap.usedFormatted = formatBytes(info.swap.used);
  }
  info.disk.totalFormatted = formatBytes(info.disk.total);
  info.disk.usedFormatted = formatBytes(info.disk.used);
  return info;
}

app.get('/api/server-info', requireAuth, requireWizardComplete, (req, res) => {
  try {
    res.json(serverInfoJson());
  } catch (_) {
    res.status(500).json({ error: 'Failed to get server info' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`UPGS Panel listening on http://0.0.0.0:${PORT}`);
});
