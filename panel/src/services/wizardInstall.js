const { execSync, spawn } = require('child_process');

const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
const execOpts = { encoding: 'utf8', env, timeout: 600000, maxBuffer: 4 * 1024 * 1024 };

function run(cmd, opts = {}) {
  try {
    const result = execSync(cmd, { ...execOpts, ...opts });
    return { ok: true, out: (result && result.toString()) || '' };
  } catch (err) {
    const stderr = (err.stderr && err.stderr.toString()) || err.message || '';
    const stdout = (err.stdout && err.stdout.toString()) || '';
    return { ok: false, out: stdout + stderr };
  }
}

/**
 * Run a command with spawn and stream stdout/stderr to onOutput(text).
 * Returns Promise<{ ok: boolean }>. Uses -q (not -qq) for apt so output is visible.
 */
function runStreaming(cmd, onOutput) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const send = (data) => {
      if (data && onOutput) onOutput(data.toString());
    };
    child.stdout.on('data', send);
    child.stderr.on('data', send);
    child.on('close', (code) => {
      resolve({ ok: code === 0 });
    });
  });
}

/**
 * Run apt-get update (once per install run).
 */
function aptUpdate() {
  return run('apt-get update -qq');
}

/**
 * Install PHP versions (e.g. ['8.1','8.2']). Adds ondrej/php PPA then installs each version.
 */
function installPhp(versions) {
  if (!versions || versions.length === 0) return { ok: true, out: '' };
  const list = Array.isArray(versions) ? versions : (versions || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return { ok: true, out: '' };

  let out = '';
  const addRepo = run('add-apt-repository -y ppa:ondrej/php', { stdio: 'pipe' });
  if (!addRepo.ok) return addRepo;
  out += addRepo.out;

  const update = run('apt-get update -qq');
  if (!update.ok) return update;
  out += update.out;

  for (const v of list) {
    const pkg = `php${v}-fpm php${v}-mysql php${v}-curl php${v}-mbstring php${v}-xml php${v}-zip`;
    const r = run(`apt-get install -y -qq ${pkg}`);
    if (!r.ok) return { ok: false, out: out + r.out };
    out += r.out;
  }
  return { ok: true, out };
}

/**
 * Install database: 'mysql' or 'mariadb'.
 */
function installDatabase(choice) {
  if (choice === 'mysql') {
    return run('apt-get install -y -qq mysql-server');
  }
  if (choice === 'mariadb') {
    return run('apt-get install -y -qq mariadb-server');
  }
  return { ok: true, out: '' };
}

/**
 * Install Postfix + Dovecot (mail).
 */
function installMail() {
  return run('apt-get install -y -qq postfix dovecot-core dovecot-imapd dovecot-lmtpd');
}

/**
 * Install ProFTPD.
 */
function installFtp() {
  return run('apt-get install -y -qq proftpd-basic');
}

/**
 * Install Certbot for Nginx.
 */
function installCertbot() {
  return run('apt-get install -y -qq certbot python3-certbot-nginx');
}

/**
 * Run full wizard install from state object (from wizard_state row).
 * Returns { success, log }.
 */
function runWizardInstall(state) {
  const log = [];
  const phpVersions = (state.php_versions || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const databaseChoice = state.database_choice || 'mysql';
  const installEmail = !!state.email_installed;
  const installFtpFlag = !!state.ftp_installed;
  const installCertbotFlag = !!state.certbot_installed;

  function step(name, fn) {
    log.push(`[${name}]`);
    const r = fn();
    if (r.out) log.push(r.out.trim());
    if (!r.ok) log.push(`Error in step: ${name}`);
    return r;
  }

  const r1 = step('apt-get update', aptUpdate);
  if (!r1.ok) return { success: false, log: log.join('\n') };

  if (phpVersions.length > 0) {
    const r2 = step('PHP ' + phpVersions.join(', '), () => installPhp(phpVersions));
    if (!r2.ok) return { success: false, log: log.join('\n') };
  }

  const r3 = step('Database (' + databaseChoice + ')', () => installDatabase(databaseChoice));
  if (!r3.ok) return { success: false, log: log.join('\n') };

  if (installEmail) {
    const r4 = step('Mail (Postfix + Dovecot)', installMail);
    if (!r4.ok) return { success: false, log: log.join('\n') };
  }

  if (installFtpFlag) {
    const r5 = step('FTP (ProFTPD)', installFtp);
    if (!r5.ok) return { success: false, log: log.join('\n') };
  }

  if (installCertbotFlag) {
    const r6 = step('Certbot', installCertbot);
    if (!r6.ok) return { success: false, log: log.join('\n') };
  }

  return { success: true, log: log.join('\n') };
}

/**
 * Run full wizard install with live streaming. Calls onOutput(text) for each chunk.
 * Returns Promise<{ success: boolean }>. Uses apt without -qq so output is visible.
 */
async function runWizardInstallStreaming(state, onOutput) {
  const out = (text) => { if (onOutput && text) onOutput(text); };
  const phpVersions = (state.php_versions || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const databaseChoice = state.database_choice || 'mysql';
  const installEmail = !!state.email_installed;
  const installFtpFlag = !!state.ftp_installed;
  const installCertbotFlag = !!state.certbot_installed;

  try {
    out('[apt-get update]\n');
    const r1 = await runStreaming('apt-get update -q', out);
    if (!r1.ok) return { success: false };

    if (phpVersions.length > 0) {
      out('\n[PHP ' + phpVersions.join(', ') + ']\n');
      const rRepo = await runStreaming('add-apt-repository -y ppa:ondrej/php', out);
      if (!rRepo.ok) return { success: false };
      await runStreaming('apt-get update -q', out);
      for (const v of phpVersions) {
        const pkg = 'php' + v + '-fpm php' + v + '-mysql php' + v + '-curl php' + v + '-mbstring php' + v + '-xml php' + v + '-zip';
        const rP = await runStreaming('apt-get install -y -q ' + pkg, out);
        if (!rP.ok) return { success: false };
      }
    }

    out('\n[Database: ' + databaseChoice + ']\n');
    const dbPkg = databaseChoice === 'mariadb' ? 'mariadb-server' : 'mysql-server';
    const r3 = await runStreaming('apt-get install -y -q ' + dbPkg, out);
    if (!r3.ok) return { success: false };

    if (installEmail) {
      out('\n[Mail: Postfix + Dovecot]\n');
      const r4 = await runStreaming('apt-get install -y -q postfix dovecot-core dovecot-imapd dovecot-lmtpd', out);
      if (!r4.ok) return { success: false };
    }

    if (installFtpFlag) {
      out('\n[FTP: ProFTPD]\n');
      const r5 = await runStreaming('apt-get install -y -q proftpd-basic', out);
      if (!r5.ok) return { success: false };
    }

    if (installCertbotFlag) {
      out('\n[Certbot]\n');
      const r6 = await runStreaming('apt-get install -y -q certbot python3-certbot-nginx', out);
      if (!r6.ok) return { success: false };
    }

    return { success: true };
  } catch (err) {
    out('\n' + (err.message || String(err)) + '\n');
    return { success: false };
  }
}

module.exports = {
  aptUpdate,
  installPhp,
  installDatabase,
  installMail,
  installFtp,
  installCertbot,
  runWizardInstall,
  runWizardInstallStreaming
};
