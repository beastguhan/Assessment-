# Methodology, Decisions & Trade-offs — Write-up

**Assessment:** Nilavan Realtors – Cyber Security + DevOps  
**Live URL:** https://guhan.store  
**Date:** 26 March 2026  

---

## 1. Approach to Finding Vulnerabilities

### Phase 1 — Source Code Review (White-box)
The first step was a manual line-by-line review of the application source code, starting with the most sensitive file: `app/api/sendgrid/route.ts`. This file handles all contact form submissions and email sending, making it the highest-risk attack surface.

Key questions asked during code review:
- Is user input sanitized before use?
- Are there any rate limiting or throttling mechanisms?
- Are secrets handled securely via environment variables?
- Is error handling leaking internal details?
- Are all required fields validated before processing?

### Phase 2 — Live PoC Testing (Black-box)
Every finding from the code review was verified with a working proof-of-concept on the live server at `https://guhan.store`. This confirmed that vulnerabilities were actually exploitable in production, not just theoretical.

Tests performed:
- **Rate limiting test** — 10 rapid POST requests to `/api/sendgrid`
- **XSS injection** — script tags and event handlers in form fields
- **Email header injection** — newline characters in name/email fields
- **Empty/missing field test** — blank and absent fields submitted
- **Malicious link injection** — HTML anchor tags with external URLs
- **Directory exposure** — `.git/config`, `.git/HEAD`, `.env` paths tested
- **Security header audit** — `curl -I` to inspect all response headers
- **Server info disclosure** — checking `Server:` and `X-Powered-By:` headers
- **Invalid JSON test** — malformed request body submitted
- **Oversized payload test** — 10,000 character field values submitted

### Phase 3 — Infrastructure Review
The Nginx configuration, UFW firewall rules, PM2 setup, and SSL certificate were all reviewed against production-grade security baselines.

### Tools Used
| Tool | Purpose |
|------|---------|
| `curl` | HTTP request testing, header inspection, PoC demonstrations |
| Manual code audit | Source code vulnerability identification |
| Nginx config review | Server hardening verification |
| `nslookup` | DNS propagation verification |
| `pm2` | Process management verification |
| `ufw` | Firewall rule verification |
| Browser DevTools | Live HTTPS and padlock verification |

---

## 2. Decisions Made During Server Setup

### Non-Root Application User
The application runs as `devuser` — never as `root`. This is the single most important security decision. If an attacker achieves Remote Code Execution through any vulnerability (malicious npm package, code injection, etc.), they are limited to `devuser` privileges. They cannot read `/etc/shadow`, install system-level backdoors, or access other users' files without further privilege escalation.

### SSH Port Change to 2222
The default SSH port (22) is constantly scanned and brute-forced by automated bots worldwide. Changing to port 2222 is not security through obscurity alone — it significantly reduces noise in logs and eliminates the vast majority of automated attacks. Combined with key-only authentication, it creates a strong SSH posture.

### Disabled Password Authentication
Key-only SSH authentication eliminates the entire class of brute-force and credential stuffing attacks against SSH. Even if an attacker knows the username, they cannot login without the private key file.

### UFW Default Deny
The firewall denies all inbound traffic by default. Only the three required ports (2222, 80, 443) are explicitly opened. This follows the principle of least privilege — nothing is accessible unless intentionally allowed.

### Nginx as Reverse Proxy
The Next.js application listens on `localhost:3000` and is never directly exposed to the internet. Nginx sits in front and handles:
- SSL termination
- HTTP → HTTPS redirection
- Security header injection
- Path blocking (`.git`, hidden files)
- Request proxying

This separation of concerns means the Node.js process never deals with raw TLS or security headers — Nginx handles it centrally.

### PM2 Process Manager
PM2 ensures the application automatically restarts if it crashes and starts automatically when the server reboots. Without PM2, a single unhandled error would take the site offline permanently until manual intervention.

### Let's Encrypt SSL
Free, trusted by all major browsers, and auto-renewing every 90 days. Certbot integrates directly with Nginx to handle configuration changes and renewals automatically. HTTPS is enforced with HTTP → HTTPS redirect (301) and HSTS headers.

### .git Directory Blocked in Nginx
The `.git` directory is present on the server because we cloned the repository. Without Nginx protection, anyone could access `https://guhan.store/.git/config` and download the entire repository history using tools like `git-dumper`. The Nginx rule blocks this at the web server level before the request reaches Next.js.

---

## 3. Trade-offs in Fix Implementations

### Rate Limiting by IP
**Trade-off:** IP-based rate limiting can incorrectly block multiple legitimate users who share a public IP address (e.g., an entire office behind a single NAT gateway). If 5 people from the same office try to contact the business at the same time, some may be rate-limited.  
**Why it's still worth it:** The alternative — no rate limiting — allows unlimited spam. The trade-off is acceptable because the contact form is low-frequency by nature. Real users rarely submit more than 1–2 times.

### CSP with `unsafe-inline`
**Trade-off:** Next.js uses inline styles and scripts by default, which means a strict CSP that blocks `unsafe-inline` would break the site. The recommended fix includes `unsafe-inline` to maintain compatibility.  
**Ideal solution:** Use CSP nonces generated per-request, which allows specific inline scripts to run while blocking injected ones. This requires more complex Next.js middleware configuration.

### HSTS `max-age=31536000`
**Trade-off:** Once a browser sees this header, it will refuse to connect to the site over HTTP for 1 full year — even if the SSL certificate expires or is misconfigured. If Certbot fails to auto-renew and the certificate expires, the site will become inaccessible in browsers that have cached the HSTS policy.  
**Mitigation:** Monitor certificate expiry with automated alerts. Certbot auto-renews at 60 days remaining.

### `server_tokens off`
**Trade-off:** Hiding the Nginx version number does not prevent a determined attacker from fingerprinting the server through timing analysis or other techniques. It is "security through obscurity" in part.  
**Why it's still worth it:** It removes the easiest avenue — version disclosure in headers — which is what the vast majority of automated scanners rely on. Every barrier matters.

### SSH Port Change
**Trade-off:** Non-standard SSH port can confuse team members who try to SSH in with default settings and get a connection refused error. Requires all team members to use `-p 2222`.  
**Mitigation:** Document the port in the team's SSH config file (`~/.ssh/config`) so it's transparent.

---

## 4. Vulnerability Priority Order for Fixes

If fixes must be prioritised, address them in this order:

1. **Rate Limiting** — most immediately exploitable, easiest to automate
2. **Input Validation** — prevents empty/malformed data from consuming SendGrid quota
3. **XSS / HTML Sanitization** — prevents injection into sent emails
4. **Content-Security-Policy** — browser-level XSS mitigation
5. **Server Version Disclosure** — remove Nginx version and X-Powered-By
6. **Error Message Handling** — prevent information leakage on failures
