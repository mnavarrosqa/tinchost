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
 * Sensible upload limits for PHP (WordPress/media etc). Writes 98-uploads.ini for FPM and CLI.
 * No restart here; applyPhpMailConfig restarts FPM so both are loaded.
 */
function applyPhpUploadDefaults(version) {
  const uploadIni = `; Tinchost: allow larger uploads (e.g. WordPress media)
upload_max_filesize = 64M
post_max_size = 64M
`;
  const dirs = [
    path.join('/etc/php', version, 'fpm', 'conf.d'),
    path.join('/etc/php', version, 'cli', 'conf.d')
  ];
  try {
    for (const dir of dirs) {
      if (!fs.existsSync(path.join(dir, '..'))) continue;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '98-uploads.ini'), uploadIni, 'utf8');
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, out: (err.message || String(err)) };
  }
}

/**
 * Ensure PHP mail() works via system sendmail (Postfix). Writes 99-mail.ini for both FPM and CLI
 * so transactional mail works for any PHP version. Uses standard path /usr/sbin/sendmail -t -i.
 */
function applyPhpMailConfig(version) {
  const mailIni = `; Tinchost: default PHP mail() via system sendmail (Postfix)
sendmail_path = "/usr/sbin/sendmail -t -i"
`;
  const dirs = [
    path.join('/etc/php', version, 'fpm', 'conf.d'),
    path.join('/etc/php', version, 'cli', 'conf.d')
  ];
  try {
    for (const dir of dirs) {
      if (!fs.existsSync(path.join(dir, '..'))) continue;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '99-mail.ini'), mailIni, 'utf8');
    }
    const fpmDir = path.join('/etc/php', version, 'fpm');
    if (fs.existsSync(fpmDir)) {
      const restart = run('systemctl restart php' + version + '-fpm');
      if (!restart.ok) return { ok: false, out: restart.out };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, out: (err.message || String(err)) };
  }
}

/**
 * Configure Postfix so mail sent by PHP (www-data) uses envelope sender noreply@hostname
 * instead of www-data@hostname. Helps WordPress and other PHP mail when -f is not set.
 */
function applyPostfixForPhpMail() {
  try {
    const hostname = require('os').hostname() || 'localhost';
    const genericPath = '/etc/postfix/generic';
    const content = `# Tinchost: default envelope sender for PHP (www-data)
www-data@${hostname} noreply@${hostname}
www-data noreply@${hostname}
`;
    fs.writeFileSync(genericPath, content, 'utf8');
    run('postmap ' + genericPath);
    run('postconf -e "smtp_generic_maps = hash:' + genericPath + '"');
    const restart = run('systemctl reload postfix');
    return restart.ok ? { ok: true } : { ok: false, out: restart.out };
  } catch (err) {
    return { ok: false, out: (err.message || String(err)) };
  }
}

/**
 * Return list of PHP versions installed under /etc/php (e.g. ['7.4', '8.1', '8.2']).
 */
function getInstalledPhpVersions() {
  const phpDir = '/etc/php';
  if (!fs.existsSync(phpDir)) return [];
  const versions = [];
  for (const name of fs.readdirSync(phpDir)) {
    const full = path.join(phpDir, name);
    if (fs.statSync(full).isDirectory() && /^\d+\.\d+$/.test(name)) versions.push(name);
  }
  return versions.sort();
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
    const uploadCfg = applyPhpUploadDefaults(v);
    if (!uploadCfg.ok) return { ok: false, out: out + (uploadCfg.out || '') };
    const mailCfg = applyPhpMailConfig(v);
    if (!mailCfg.ok) return { ok: false, out: out + (mailCfg.out || '') };
  }
  return { ok: true, out };
}

/**
 * Write performance-optimized InnoDB config for MySQL or MariaDB.
 * Drop-in file in the engine's conf.d; then restart mysql service.
 */
function applyDatabasePerformance(choice) {
  const dir = choice === 'mariadb'
    ? '/etc/mysql/mariadb.conf.d'
    : '/etc/mysql/mysql.conf.d';
  const file = path.join(dir, '99-tinchost-performance.cnf');
  const content = `; Tinchost database performance tuning
[mysqld]
innodb_buffer_pool_size = 256M
innodb_log_file_size = 64M
innodb_flush_log_at_trx_commit = 2
innodb_flush_method = O_DIRECT
`;
  try {
    if (!fs.existsSync(dir)) return { ok: true };
    fs.writeFileSync(file, content, 'utf8');
    const restart = run('systemctl restart mysql');
    return restart.ok ? { ok: true } : { ok: false, out: restart.out };
  } catch (err) {
    return { ok: false, out: (err.message || String(err)) };
  }
}

/**
 * Install database: 'mysql' or 'mariadb'. If config === 'optimized', applies InnoDB tuning after install.
 * If rootPassword is set, configures it via debconf before apt install so the package uses it during setup.
 */
function installDatabase(choice, config, rootPassword) {
  const safePassword = rootPassword ? String(rootPassword).replace(/\r?\n/g, ' ').trim() : '';
  if (choice === 'mysql' && safePassword) {
    const lines = [
      'mysql-server mysql-server/root_password password ' + safePassword,
      'mysql-server mysql-server/root_password_again password ' + safePassword
    ];
    try {
      const result = require('child_process').spawnSync('debconf-set-selections', [], {
        input: lines.join('\n') + '\n',
        encoding: 'utf8',
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
      });
      if (result.status !== 0) return { ok: false, out: (result.stderr || result.stdout || 'debconf-set-selections failed').toString() };
    } catch (e) {
      return { ok: false, out: (e.message || 'debconf-set-selections failed') };
    }
  }
  if (choice === 'mariadb' && safePassword) {
    const lines = [
      'mariadb-server mysql-server/root_password password ' + safePassword,
      'mariadb-server mysql-server/root_password_again password ' + safePassword
    ];
    try {
      const result = require('child_process').spawnSync('debconf-set-selections', [], {
        input: lines.join('\n') + '\n',
        encoding: 'utf8',
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
      });
      if (result.status !== 0) return { ok: false, out: (result.stderr || result.stdout || 'debconf-set-selections failed').toString() };
    } catch (e) {
      return { ok: false, out: (e.message || 'debconf-set-selections failed') };
    }
  }

  if (choice === 'mysql') {
    const r = run('apt-get install -y -qq mysql-server');
    if (!r.ok) return r;
    if (config === 'optimized') {
      const perf = applyDatabasePerformance('mysql');
      if (!perf.ok) return { ok: false, out: r.out + (perf.out || '') };
    }
    return { ok: true, out: r.out };
  }
  if (choice === 'mariadb') {
    const r = run('apt-get install -y -qq mariadb-server');
    if (!r.ok) return r;
    if (config === 'optimized') {
      const perf = applyDatabasePerformance('mariadb');
      if (!perf.ok) return { ok: false, out: r.out + (perf.out || '') };
    }
    return { ok: true, out: r.out };
  }
  return { ok: true, out: '' };
}

/**
 * Install Postfix + Dovecot (mail). After install, ensures all installed PHP versions
 * have sendmail_path set so PHP mail() works.
 */
function installMail() {
  const r = run('apt-get install -y -qq postfix dovecot-core dovecot-imapd dovecot-lmtpd');
  if (!r.ok) return r;
  const versions = getInstalledPhpVersions();
  for (const v of versions) {
    applyPhpUploadDefaults(v);
    const mailCfg = applyPhpMailConfig(v);
    if (!mailCfg.ok) return { ok: false, out: r.out + (mailCfg.out || '') };
  }
  return { ok: true, out: r.out };
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

/** Allowed Node.js major versions for wizard (NodeSource setup_XX.x). */
const NODE_VERSIONS = ['18', '20', '22'];

/**
 * Install Node.js via NodeSource for the given major version (e.g. '22', '20', '18').
 */
function installNode(version) {
  if (!version || !NODE_VERSIONS.includes(version)) return { ok: true, out: '' };
  const setupUrl = 'https://deb.nodesource.com/setup_' + version + '.x';
  const curl = run('curl -fsSL ' + setupUrl + ' | bash -', { stdio: 'pipe', timeout: 120000 });
  if (!curl.ok) return { ok: false, out: curl.out || 'NodeSource setup failed' };
  const update = run('apt-get update -qq');
  if (!update.ok) return update;
  const install = run('apt-get install -y -qq nodejs');
  if (!install.ok) return { ok: false, out: install.out };
  return { ok: true, out: (curl.out || '') + (install.out || '') };
}

/**
 * Run full wizard install from state object (from wizard_state row).
 * Returns { success, log }.
 */
function runWizardInstall(state, opts) {
  const opts_ = opts || {};
  const mysqlRootPassword = opts_.mysqlRootPassword || null;
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

  const nodeVersion = state.node_version && NODE_VERSIONS.includes(state.node_version) ? state.node_version : null;
  if (nodeVersion) {
    const rNode = step('Node.js ' + nodeVersion, () => installNode(nodeVersion));
    if (!rNode.ok) return { success: false, log: log.join('\n') };
  }

  const databaseConfig = state.database_config || 'default';
  const r3 = step('Database (' + databaseChoice + (databaseConfig === 'optimized' ? ', optimized' : '') + ')', () => installDatabase(databaseChoice, databaseConfig, mysqlRootPassword));
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
async function runWizardInstallStreaming(state, onOutput, opts) {
  const opts_ = opts || {};
  const mysqlRootPassword = opts_.mysqlRootPassword || null;
  const out = (text) => { if (onOutput && text) onOutput(text); };
  const phpVersions = (state.php_versions || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const databaseChoice = state.database_choice || 'mysql';
  const databaseConfig = state.database_config || 'default';
  const useDbOptimized = databaseConfig === 'optimized';
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
        out('\n[PHP ' + v + ' upload & mail config]\n');
        const uploadCfg = applyPhpUploadDefaults(v);
        if (!uploadCfg.ok) return { success: false };
        const mailCfg = applyPhpMailConfig(v);
        if (!mailCfg.ok) return { success: false };
      }
    }

    const nodeVersion = state.node_version && NODE_VERSIONS.includes(state.node_version) ? state.node_version : null;
    if (nodeVersion) {
      out('\n[Node.js ' + nodeVersion + ']\n');
      const setupUrl = 'https://deb.nodesource.com/setup_' + nodeVersion + '.x';
      const rCurl = await runStreaming('curl -fsSL ' + setupUrl + ' | bash -', out);
      if (!rCurl.ok) return { success: false };
      await runStreaming('apt-get update -q', out);
      const rNode = await runStreaming('apt-get install -y -q nodejs', out);
      if (!rNode.ok) return { success: false };
    }

    out('\n[Database: ' + databaseChoice + (useDbOptimized ? ' (optimized)' : '') + ']\n');
    const safePassword = mysqlRootPassword ? String(mysqlRootPassword).replace(/\r?\n/g, ' ').trim() : '';
    if (databaseChoice === 'mysql' && safePassword) {
      const lines = 'mysql-server mysql-server/root_password password ' + safePassword + '\nmysql-server mysql-server/root_password_again password ' + safePassword + '\n';
      const debconf = spawn('debconf-set-selections', [], { env: { ...env, DEBIAN_FRONTEND: 'noninteractive' }, stdio: ['pipe', 'ignore', 'ignore'] });
      debconf.stdin.write(lines);
      debconf.stdin.end();
      await new Promise((res) => debconf.on('close', res));
    }
    if (databaseChoice === 'mariadb' && safePassword) {
      const lines = 'mariadb-server mysql-server/root_password password ' + safePassword + '\nmariadb-server mysql-server/root_password_again password ' + safePassword + '\n';
      const debconf = spawn('debconf-set-selections', [], { env: { ...env, DEBIAN_FRONTEND: 'noninteractive' }, stdio: ['pipe', 'ignore', 'ignore'] });
      debconf.stdin.write(lines);
      debconf.stdin.end();
      await new Promise((res) => debconf.on('close', res));
    }
    const dbPkg = databaseChoice === 'mariadb' ? 'mariadb-server' : 'mysql-server';
    const r3 = await runStreaming('apt-get install -y -q ' + dbPkg, out);
    if (!r3.ok) return { success: false };
    if (useDbOptimized) {
      out('\n[Database performance config]\n');
      const perf = applyDatabasePerformance(databaseChoice);
      if (!perf.ok) return { success: false };
    }

    if (installEmail) {
      out('\n[Mail: Postfix + Dovecot]\n');
      const r4 = await runStreaming('apt-get install -y -q postfix dovecot-core dovecot-imapd dovecot-lmtpd', out);
      if (!r4.ok) return { success: false };
      const phpVers = getInstalledPhpVersions();
      for (const v of phpVers) {
        out('\n[PHP ' + v + ' upload & mail config]\n');
        applyPhpUploadDefaults(v);
        const mailCfg = applyPhpMailConfig(v);
        if (!mailCfg.ok) return { success: false };
      }
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
  installNode,
  installDatabase,
  installMail,
  installFtp,
  installCertbot,
  runWizardInstall,
  runWizardInstallStreaming,
  getInstalledPhpVersions,
  applyPhpMailConfig,
  applyPostfixForPhpMail
};
