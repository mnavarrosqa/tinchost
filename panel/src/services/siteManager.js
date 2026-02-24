const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getPaths(settings) {
  return {
    sitesAvailable: (settings && settings.nginx_sites_available) || process.env.NGINX_SITES_AVAILABLE || '/etc/nginx/sites-available',
    sitesEnabled: process.env.NGINX_SITES_ENABLED || '/etc/nginx/sites-enabled'
  };
}

function getVhostPath(domain, settings) {
  const { sitesAvailable } = getPaths(settings);
  const safe = domain.replace(/[^a-z0-9._-]/gi, '_');
  return path.join(sitesAvailable, `tinchost-${safe}.conf`);
}

/** Parse site.php_options (JSON) into key=value lines for PHP_VALUE. Only allows safe ini keys and values. */
function getPhpOptionLines(site) {
  if (!site.php_options || typeof site.php_options !== 'string') return [];
  let opts;
  try {
    opts = JSON.parse(site.php_options);
  } catch (_) {
    return [];
  }
  if (!opts || typeof opts !== 'object') return [];
  const lines = [];
  for (const [k, v] of Object.entries(opts)) {
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    const key = k.replace(/[^a-zA-Z0-9_.]/g, '');
    const val = v.replace(/[\r\n"\\]/g, '').trim();
    if (key && val) lines.push(key + '=' + val);
  }
  return lines;
}

function vhostTemplate(site) {
  const phpSocket = site.php_version ? `/run/php/php${site.php_version}-fpm.sock` : '/run/php/php8.2-fpm.sock';
  const phpOptLines = getPhpOptionLines(site);
  const phpValueNginx = phpOptLines.length
    ? '        fastcgi_param PHP_VALUE "' + phpOptLines.join('\n        ') + '";\n'
    : '';
  const phpBlock = `    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${phpSocket};
${phpValueNginx}    }
`;
  let conf = `
server {
    listen 80;
    server_name ${site.domain};
    root ${site.docroot};
    index index.php index.html;
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
${phpBlock}
}
`;
  if (site.ssl) {
    conf = `
server {
    listen 80;
    server_name ${site.domain};
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name ${site.domain};
    ssl_certificate /etc/letsencrypt/live/${site.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${site.domain}/privkey.pem;
    root ${site.docroot};
    index index.php index.html;
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
${phpBlock}
}
`;
  }
  return conf.trim();
}

async function writeVhost(site, settings) {
  const { sitesEnabled } = getPaths(settings);
  const file = getVhostPath(site.domain, settings);
  const content = vhostTemplate(site);
  fs.writeFileSync(file, content, 'utf8');
  const enabled = path.join(sitesEnabled, path.basename(file));
  try { fs.unlinkSync(enabled); } catch (_) {}
  fs.symlinkSync(file, enabled);
}

function removeVhost(site, settings) {
  const { sitesEnabled } = getPaths(settings);
  const file = getVhostPath(site.domain, settings);
  const enabled = path.join(sitesEnabled, path.basename(file));
  try { fs.unlinkSync(enabled); } catch (_) {}
  try { fs.unlinkSync(file); } catch (_) {}
}

function reloadNginx() {
  try {
    execSync('nginx -t', { stdio: 'pipe' });
    execSync('systemctl reload nginx', { stdio: 'pipe' });
  } catch (e) {
    throw new Error(e.stderr?.toString() || e.message || 'nginx reload failed');
  }
}

module.exports = { writeVhost, removeVhost, reloadNginx, getVhostPath };
