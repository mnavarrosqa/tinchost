const { execSync } = require('child_process');

/**
 * Obtain Let's Encrypt certificate for domain. Panel runs as root so can run certbot.
 * Risk: Fails if DNS does not point to this server or ports 80/443 blocked.
 */
function obtainCert(domain) {
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new Error('Invalid domain for SSL');
  }
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

module.exports = { obtainCert };
