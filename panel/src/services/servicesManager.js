const { execFileSync, spawnSync } = require('child_process');

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
    const phpVersionsRaw = (state && state.php_versions != null && state.php_versions !== '' ? state.php_versions : '8.2').toString();
    const versions = phpVersionsRaw.split(',').map((s) => s.trim()).filter(Boolean);
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
    const result = spawnSync('systemctl', ['restart', unit], {
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 256 * 1024
    });
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      const stdout = (result.stdout || '').trim();
      const detail = stderr || stdout || result.error?.message || 'Exit code ' + result.status;
      return { ok: false, message: detail };
    }
    const status = getServiceStatus(unit);
    return { ok: true, status };
  } catch (e) {
    const msg = (e.stderr && e.stderr.toString()) || (e.message || 'Restart failed').trim();
    return { ok: false, message: msg };
  }
}

/** Get recent log lines for a systemd unit (journalctl). Returns { ok, output, error }. */
function getServiceLogs(unit, lines) {
  const n = Math.min(Number(lines) || 200, 500);
  try {
    const out = execFileSync(
      'journalctl',
      ['-u', unit, '-n', String(n), '--no-pager', '-o', 'short-iso'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 512 * 1024 }
    );
    return { ok: true, output: out.trim() || '(no log entries)' };
  } catch (e) {
    const err = (e.stderr && e.stderr.toString()) || e.message || 'Failed to read logs';
    return { ok: false, output: '', error: err };
  }
}

module.exports = { getInstalledServices, getServiceStatus, restartService, getServiceLogs, isAllowedUnit };
