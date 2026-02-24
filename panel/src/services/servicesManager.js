const { execFileSync } = require('child_process');

/** Map wizard_state to list of service definitions: { id, label, unit } */
function getInstalledServices(state) {
  const list = [];
  list.push({ id: 'nginx', label: 'Nginx (web server)', unit: 'nginx' });
  const phpVersions = (state && state.php_versions ? state.php_versions : '8.2').toString().split(',').map(s => s.trim()).filter(Boolean);
  phpVersions.forEach((v) => {
    list.push({ id: `php${v}-fpm`, label: `PHP ${v} FPM`, unit: `php${v}-fpm` });
  });
  const dbChoice = (state && state.database_choice) || 'mysql';
  list.push({ id: 'mysql', label: dbChoice === 'mariadb' ? 'MariaDB' : 'MySQL', unit: 'mysql' });
  if (state && state.email_installed) {
    list.push({ id: 'postfix', label: 'Postfix (mail)', unit: 'postfix' });
    list.push({ id: 'dovecot', label: 'Dovecot (IMAP/LMTP)', unit: 'dovecot' });
  }
  if (state && state.ftp_installed) {
    list.push({ id: 'proftpd', label: 'ProFTPD', unit: 'proftpd' });
  }
  return list;
}

const ALLOWED_UNITS = new Set([
  'nginx', 'mysql', 'postfix', 'dovecot', 'proftpd'
]);

function isAllowedUnit(unit, state) {
  if (ALLOWED_UNITS.has(unit)) return true;
  if (unit.startsWith('php') && unit.endsWith('-fpm')) {
    const v = unit.slice(3, -4);
    const versions = (state && state.php_versions ? state.php_versions : '').toString().split(',').map(s => s.trim()).filter(Boolean);
    return versions.includes(v);
  }
  return false;
}

function getServiceStatus(unit) {
  try {
    const out = execFileSync('systemctl', ['is-active', unit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return out === 'active' ? 'active' : out || 'inactive';
  } catch (_) {
    return 'inactive';
  }
}

function restartService(unit) {
  try {
    execFileSync('systemctl', ['restart', unit], { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e.stderr && e.stderr.toString()) || e.message || 'Restart failed' };
  }
}

module.exports = { getInstalledServices, getServiceStatus, restartService, isAllowedUnit };
