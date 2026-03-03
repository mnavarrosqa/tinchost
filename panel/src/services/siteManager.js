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
  return path.join(sitesAvailable, `upgs-${safe}.conf`);
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
  const isNode = site.app_type === 'node';
  const port = isNode && site.node_port != null ? Number(site.node_port) : null;
  if (isNode && (!port || port < 1 || port > 65535)) {
    throw new Error('Node app requires a valid port (1-65535)');
  }
  const proxyBlock = isNode ? `    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }
` : '';
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
  const root = site.docroot;
  const htaccessCompat = site.htaccess_compat && !isNode;
  const sensitiveBlock = htaccessCompat ? `    location ~ /\\. {
        return 404;
    }
    location ~* \\.(htaccess|htpasswd|env)$ {
        return 404;
    }
` : '';
  const phpLocationBlock = `${sensitiveBlock}    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
${phpBlock}
`;
  const locationBlock = isNode ? proxyBlock : phpLocationBlock;
  let conf = `
server {
    listen 80;
    server_name ${site.domain};
    root ${root};
    index index.php index.html;
    client_max_body_size 64M;
${locationBlock}
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
    root ${root};
    index index.php index.html;
    client_max_body_size 64M;
${locationBlock}
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

const NGINX_IP_PREVIEW_FILENAME = 'upgs-ip-preview.conf';

function getIpPreviewPath(settings) {
  const { sitesAvailable } = getPaths(settings);
  return path.join(sitesAvailable, NGINX_IP_PREVIEW_FILENAME);
}

/**
 * Build nginx location block for one site under /_preview/<id>/ (PHP or Node).
 * Used when serving site by public IP before domain is delegated.
 */
function ipPreviewLocationBlock(site) {
  const id = Number(site.id);
  if (!Number.isInteger(id) || id < 1) return '';
  const docroot = site.docroot.replace(/\/+$/, '') + '/';
  const isNode = site.app_type === 'node';
  const port = isNode && site.node_port != null ? Number(site.node_port) : null;

  if (isNode && port >= 1 && port <= 65535) {
    return `    location /_preview/${id}/ {
        proxy_pass http://127.0.0.1:${port}/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Prefix /_preview/${id};
        proxy_set_header Connection "";
    }
`;
  }

  const phpSocket = site.php_version ? `/run/php/php${site.php_version}-fpm.sock` : '/run/php/php8.2-fpm.sock';
  return `    location /_preview/${id}/ {
        alias ${docroot};
        index index.php index.html;
        client_max_body_size 64M;
        try_files $uri $uri/ /_preview/${id}/index.php?$query_string;
        location ~ \\.php$ {
            include snippets/fastcgi-php.conf;
            fastcgi_pass unix:${phpSocket};
            fastcgi_param SCRIPT_FILENAME $request_filename;
        }
    }
`;
}

/**
 * Write nginx config so sites can be previewed by public IP at /_preview/<site_id>/
 * when the domain is not yet delegated. Only writes if server_public_ip is set.
 * Requests to the public IP with path /_preview/<id>/ serve that site's docroot;
 * other paths proxy to the panel.
 */
function writeIpPreviewConf(settings, sites) {
  const serverIp = (settings && settings.server_public_ip && String(settings.server_public_ip).trim()) || null;
  const serverIpv6 = (settings && settings.server_public_ipv6 && String(settings.server_public_ipv6).trim()) || null;
  const { sitesAvailable, sitesEnabled } = getPaths(settings);
  const file = path.join(sitesAvailable, NGINX_IP_PREVIEW_FILENAME);
  const enabled = path.join(sitesEnabled, NGINX_IP_PREVIEW_FILENAME);

  if (!serverIp && !serverIpv6) {
    try { fs.unlinkSync(enabled); } catch (_) {}
    try { fs.unlinkSync(file); } catch (_) {}
    return;
  }

  const serverNames = [serverIp, serverIpv6].filter(Boolean).join(' ');
  const previewBlocks = (sites || []).map(s => ipPreviewLocationBlock(s)).filter(Boolean).join('');

  const panelProxy = `    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
`;

  const content = `# UPGS Panel: preview sites by public IP before domain is delegated
server {
    listen 80;
    listen [::]:80;
    server_name ${serverNames};
${previewBlocks}${panelProxy}
}
`;
  fs.writeFileSync(file, content, 'utf8');
  try { fs.unlinkSync(enabled); } catch (_) {}
  fs.symlinkSync(file, enabled);
}

function removeIpPreviewConf(settings) {
  const { sitesAvailable, sitesEnabled } = getPaths(settings);
  const file = path.join(sitesAvailable, NGINX_IP_PREVIEW_FILENAME);
  const enabled = path.join(sitesEnabled, NGINX_IP_PREVIEW_FILENAME);
  try { fs.unlinkSync(enabled); } catch (_) {}
  try { fs.unlinkSync(file); } catch (_) {}
}

const NGINX_UPLOAD_CONF = '/etc/nginx/conf.d/99-upgs-uploads.conf';
const NGINX_UPLOAD_CONTENT = '# UPGS Panel: allow larger uploads (e.g. WordPress media)\nclient_max_body_size 64M;\n';

/**
 * Apply global Nginx upload limit (64M) so all server blocks accept large uploads.
 * Writes to conf.d and reloads nginx. Fixes 413 when vhost was not regenerated.
 */
function applyNginxUploadLimit() {
  try {
    const dir = path.dirname(NGINX_UPLOAD_CONF);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(NGINX_UPLOAD_CONF, NGINX_UPLOAD_CONTENT, 'utf8');
    reloadNginx();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message || 'Failed to apply Nginx upload limit' };
  }
}

module.exports = { writeVhost, removeVhost, reloadNginx, getVhostPath, applyNginxUploadLimit, writeIpPreviewConf, removeIpPreviewConf, getIpPreviewPath };
