const fs = require('fs');
const path = require('path');
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
 * Write performance-optimized PHP-FPM pool and opcache config for a given version.
 * Pool: dynamic pm with sensible children/spare; opcache: enabled with production tuning.
 */
function applyPhpFpmPerformance(version) {
  const base = path.join('/etc/php', version, 'fpm');
  const poolDir = path.join(base, 'pool.d');
  const confDir = path.join(base, 'conf.d');
  try {
    if (!fs.existsSync(poolDir)) return { ok: true };
    const poolConf = `; Tinchost performance tuning for PHP-FPM ${version}
[www]
pm = dynamic
pm.max_children = 50
pm.start_servers = 5
pm.min_spare_servers = 5
pm.max_spare_servers = 10
pm.max_requests = 500
`;
    fs.writeFileSync(path.join(poolDir, '99-performance.conf'), poolConf, 'utf8');
    if (!fs.existsSync(confDir)) fs.mkdirSync(confDir, { recursive: true });
    const opcacheIni = `; Tinchost OPcache performance tuning for PHP-FPM ${version}
opcache.enable=1
opcache.memory_consumption=128
opcache.interned_strings_buffer=8
opcache.max_accelerated_files=10000
opcache.validate_timestamps=0
opcache.revalidate_freq=0
`;
    fs.writeFileSync(path.join(confDir, '99-opcache-performance.ini'), opcacheIni, 'utf8');
    const restart = run('systemctl restart php' + version + '-fpm');
    return restart.ok ? { ok: true } : { ok: false, out: restart.out };
  } catch (err) {
    return { ok: false, out: (err.message || String(err)) };
  }
}

/**
 * Install PHP-FPM versions (e.g. ['7.4','8.1','8.2']). Adds ondrej/php PPA, then installs phpX-fpm and extensions per version.
 * If config === 'optimized', applies performance pool + opcache config for each version; otherwise leaves package defaults.
 */
function installPhp(versions, config) {
  if (!versions || versions.length === 0) return { ok: true, out: '' };
  const list = Array.isArray(versions) ? versions : (versions || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return { ok: true, out: '' };
  const useOptimized = config === 'optimized';

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
    if (useOptimized) {
      const perf = applyPhpFpmPerformance(v);
      if (!perf.ok) return { ok: false, out: out + (perf.out || '') };
    }
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
    const phpFpmConfig = state.php_fpm_config || 'default';
    const r2 = step('PHP-FPM ' + phpVersions.join(', ') + (phpFpmConfig === 'optimized' ? ' (optimized)' : ''), () => installPhp(phpVersions, phpFpmConfig));
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
  const phpFpmConfig = state.php_fpm_config || 'default';
  const useOptimized = phpFpmConfig === 'optimized';
  const installEmail = !!state.email_installed;
  const installFtpFlag = !!state.ftp_installed;
  const installCertbotFlag = !!state.certbot_installed;

  try {
    out('[apt-get update]\n');
    const r1 = await runStreaming('apt-get update -q', out);
    if (!r1.ok) return { success: false };

    if (phpVersions.length > 0) {
      out('\n[PHP-FPM ' + phpVersions.join(', ') + (useOptimized ? ' (optimized)' : '') + ']\n');
      const rRepo = await runStreaming('add-apt-repository -y ppa:ondrej/php', out);
      if (!rRepo.ok) return { success: false };
      await runStreaming('apt-get update -q', out);
      for (const v of phpVersions) {
        const pkg = 'php' + v + '-fpm php' + v + '-mysql php' + v + '-curl php' + v + '-mbstring php' + v + '-xml php' + v + '-zip';
        const rP = await runStreaming('apt-get install -y -q ' + pkg, out);
        if (!rP.ok) return { success: false };
        if (useOptimized) {
          out('\n[PHP-FPM ' + v + ' performance config]\n');
          const perf = applyPhpFpmPerformance(v);
          if (!perf.ok) return { success: false };
        }
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
