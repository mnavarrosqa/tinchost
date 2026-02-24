const os = require('os');
const { execSync } = require('child_process');

/**
 * Get server info for dashboard: load, memory, disk, hostname, main IP.
 * Disk is read from root filesystem via df. All values are safe for template rendering.
 */
function getServerInfo() {
  const cpus = os.cpus().length || 1;
  const loadAvg = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  let diskTotal = 0;
  let diskUsed = 0;
  try {
    const out = execSync('df -B1 / 2>/dev/null || df -k / 2>/dev/null', { encoding: 'utf8', maxBuffer: 4096 });
    const lines = out.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/).filter(Boolean);
      const isK = lines[0].includes('1K-blocks') || lines[0].includes('1024-blocks');
      const block = isK ? 1024 : 1;
      diskTotal = parseInt(parts[1], 10) * block;
      diskUsed = parseInt(parts[2], 10) * block;
    }
  } catch (_) {}

  const hostname = os.hostname() || '—';
  let mainIp = '—';
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      if (name === 'lo') continue;
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          mainIp = iface.address;
          break;
        }
      }
      if (mainIp !== '—') break;
    }
  } catch (_) {}

  return {
    load: {
      one: Math.round(loadAvg[0] * 100) / 100,
      five: Math.round(loadAvg[1] * 100) / 100,
      fifteen: Math.round(loadAvg[2] * 100) / 100,
      cpus: cpus,
      onePerCpu: cpus > 0 ? Math.min(100, Math.round((loadAvg[0] / cpus) * 100)) : 0
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      usedPercent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0
    },
    disk: {
      total: diskTotal,
      used: diskUsed,
      free: diskTotal - diskUsed,
      usedPercent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0
    },
    hostname,
    mainIp
  };
}

function formatBytes(n) {
  if (n === 0 || !Number.isFinite(n)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (Math.round(v * 100) / 100) + ' ' + units[i];
}

module.exports = { getServerInfo, formatBytes };
