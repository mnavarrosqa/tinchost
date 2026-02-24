const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LIVE_DIR = '/etc/letsencrypt/live';

function validateDomain(domain) {
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new Error('Invalid domain for SSL');
  }
}

/**
 * Obtain Let's Encrypt certificate for domain. Panel runs as root so can run certbot.
 * Risk: Fails if DNS does not point to this server or ports 80/443 blocked.
 */
function obtainCert(domain) {
  validateDomain(domain);
  try {
    execSync(`certbot certonly --nginx -d ${domain} --non-interactive --agree-tos --register-unsafely-without-email`, {
      stdio: 'pipe',
      encoding: 'utf8'
    });
    return true;
  } catch (e) {
    const msg = e.stderr || e.stdout || e.message;
    throw new Error(`Certbot failed: ${msg}`);
  }
}

/**
 * Get certificate status for domain. Returns { found, expiry, daysLeft, valid } or { found: false }.
 */
function getCertStatus(domain) {
  validateDomain(domain);
  const certPath = path.join(LIVE_DIR, domain, 'cert.pem');
  try {
    if (!fs.existsSync(certPath)) return { found: false };
    const out = execSync(`openssl x509 -in ${certPath} -enddate -noout`, { encoding: 'utf8' });
    const m = out.match(/notAfter=(.+)/);
    if (!m) return { found: true, expiry: null, daysLeft: null, valid: null };
    const expiryStr = m[1].trim();
    const expiryDate = new Date(expiryStr);
    const now = new Date();
    const daysLeft = Math.floor((expiryDate - now) / (24 * 60 * 60 * 1000));
    return { found: true, expiry: expiryStr, expiryDate: expiryDate.toISOString(), daysLeft, valid: daysLeft > 0 };
  } catch (_) {
    return { found: false };
  }
}

/**
 * Renew certificate for domain (force renewal for this cert only).
 */
function renewCert(domain) {
  validateDomain(domain);
  try {
    execSync(`certbot renew --cert-name ${domain} --non-interactive`, { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch (e) {
    const msg = e.stderr || e.stdout || e.message;
    throw new Error(`Renew failed: ${msg}`);
  }
}

/**
 * Delete certificate for domain. Does not update site or nginx; caller must set ssl=0 and rewrite vhost.
 */
function deleteCert(domain) {
  validateDomain(domain);
  try {
    execSync(`certbot delete --cert-name ${domain} --non-interactive`, { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch (e) {
    const msg = e.stderr || e.stdout || e.message;
    throw new Error(`Delete failed: ${msg}`);
  }
}

module.exports = { obtainCert, getCertStatus, renewCert, deleteCert };
