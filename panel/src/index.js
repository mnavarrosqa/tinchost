require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const { getDb } = require('./config/database');
const authRouter = require('./routes/auth');
const wizardRouter = require('./routes/wizard');
const sitesRouter = require('./routes/sites');
const settingsRouter = require('./routes/settings');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'templates', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'tinchost-panel-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/login');
}

function requireWizardComplete(req, res, next) {
  const url = req.originalUrl || req.url;
  if (url.startsWith('/wizard') || url.startsWith('/auth') || url === '/login') return next();
  getDb().then(db => {
    const row = db.prepare("SELECT completed FROM wizard_state LIMIT 1").get();
    if (row && row.completed) return next();
    res.redirect('/wizard');
  }).catch(() => next());
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
  res.render('dashboard', { user: req.session.user });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tinchost Panel listening on http://0.0.0.0:${PORT}`);
});
