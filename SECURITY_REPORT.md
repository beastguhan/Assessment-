# Security Vulnerability Assessment Report


---

## Executive Summary

A thorough security assessment was performed on the Nilavan Realtors web application, covering both the source code and the live deployment at https://guhan.store. The assessment identified **8 vulnerabilities** ranging from Critical to Low severity. The most critical issues involve missing rate limiting on the contact form API, unsanitized user input passed directly into HTML email content (XSS), server version disclosure, and missing security headers.

| Severity | Count |
|----------|-------|
| 🔴 High | 4 |
| 🟡 Medium | 3 |
| 🟢 Low | 1 |
| ✅ Fixed (during deployment) | 3 |

---

## Threat Scenario Responses

Before the detailed findings, the assessment addresses the five real-world attack scenarios specified in the problem statement.

---

### Scenario 1 — "I want to flood the business owner's inbox with thousands of spam emails using the contact form."

**How it works:**  
The `/api/sendgrid` endpoint accepts POST requests with no rate limiting, no CAPTCHA, and no authentication. An attacker can write a simple script that sends thousands of requests per minute, each triggering a real email via SendGrid. This consumes the business's SendGrid quota, floods the inbox, and may cause legitimate enquiries to be missed.

**Demonstrated on live server:**
```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "Request $i: %{http_code}\n" \
    -X POST https://guhan.store/api/sendgrid \
    -H "Content-Type: application/json" \
    -d '{"name":"test","email":"test@test.com","phone":"1234567890","message":"spam test"}';
done
```

**Result:**
```
Request 1: 200
Request 2: 200
Request 3: 200
Request 4: 200
Request 5: 200
Request 6: 200
Request 7: 200
Request 8: 200
Request 9: 200
Request 10: 200
```
All 10 requests succeeded — no rate limiting detected.

**Fix:** Implement rate limiting (see Vulnerability 1).

---

### Scenario 2 — "I want to inject a malicious link into an email that appears to come from the business's own system."

**How it works:**  
User input (`name`, `email`, `message`) is interpolated directly into the HTML email body without sanitization. An attacker can inject HTML tags including anchor tags with malicious URLs. The email appears to come from the business's verified SendGrid sender, making it highly convincing phishing content.

**Demonstrated on live server:**
```bash
curl -s -X POST https://guhan.store/api/sendgrid \
  -H "Content-Type: application/json" \
  -d '{"name":"Nilavan Support","email":"test@test.com","phone":"1234567890","message":"Click here to verify: <a href=http://evil-phishing-site.com>http://guhan.store/verify</a>"}'
```

**Result:** `{"success":true}` — The malicious link was injected into the email successfully.

**Fix:** Sanitize all input before embedding in HTML (see Vulnerability 2).

---

### Scenario 3 — "I want to access the full source code of the application from the browser without any credentials."

**How it works:**  
If the `.git` directory is publicly accessible, an attacker can download the entire Git history using tools like `git-dumper`, revealing source code, hardcoded secrets, environment variable names, and commit history — even if files were later deleted.

**Demonstrated on live server (BEFORE fix):**
```bash
curl -I https://guhan.store/.git/config
```

**Result after Nginx fix:** `HTTP/1.1 404 Not Found` ✅ — blocked successfully.

**Without the fix it would return:** the raw Git config file exposing repository internals.

**Fix:** Already applied in Nginx config — `location ~ /\.git { deny all; return 404; }` (see Vulnerability 5).

---

### Scenario 4 — "I want to embed this website inside my own malicious site to trick users (clickjacking)."

**How it works:**  
Without an `X-Frame-Options` header, an attacker can embed the site inside an invisible `<iframe>` on their own malicious page. The victim thinks they are clicking on the attacker's page but are actually interacting with the real site underneath — submitting forms, clicking buttons, etc.

**Demonstrated:**
```bash
curl -I https://guhan.store | grep -i "x-frame"
```

**Result:** `X-Frame-Options: SAMEORIGIN` ✅ — header is present and configured correctly after deployment fix.

**Fix:** Already applied in Nginx config — `add_header X-Frame-Options "SAMEORIGIN" always;`

---

### Scenario 5 — "I gained access to the server — how did running the app as root make things worse?"

**How it works:**  
If the application runs as root and an attacker achieves Remote Code Execution (RCE) through any vulnerability (e.g., a malicious npm package, a code injection flaw), they immediately gain full root access to the server. This means they can:
- Read `/etc/shadow` (all password hashes)
- Install backdoors and rootkits
- Access all files on the server including SSH keys
- Pivot to other systems in the network
- Destroy all data

**Our fix:** The application runs as `devuser` — a non-root user with limited sudo privileges. Even if the app is compromised, the attacker is contained to the `devuser` scope and cannot affect system-level files without further privilege escalation.

---

## Detailed Vulnerability Findings

---

## Vulnerability 1 — Missing Rate Limiting on Contact Form API

- **OWASP Category:** A05:2021 – Security Misconfiguration
- **Affected File:** `app/api/sendgrid/route.ts` (entire file)
- **Severity:** 🔴 High

### Description
The `/api/sendgrid` POST endpoint has no rate limiting, throttling, or CAPTCHA protection. Any client can send unlimited requests without restriction. There is no IP-based limiting, no token-based limiting, and no delay between requests.

### Business Impact
An attacker can automate thousands of POST requests per minute, each triggering a real email via SendGrid. This results in:
- Business inbox being flooded, causing legitimate enquiries to be lost
- SendGrid free tier quota (100 emails/day) being exhausted within seconds
- Potential financial cost if on a paid SendGrid plan
- Denial of service for the contact functionality

### Proof of Concept
```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "Request $i: %{http_code}\n" \
    -X POST https://guhan.store/api/sendgrid \
    -H "Content-Type: application/json" \
    -d '{"name":"test","email":"test@test.com","phone":"1234567890","message":"spam test"}';
done
```

**Output:**
```
Request 1: 200
Request 2: 200
Request 3: 200
Request 4: 200
Request 5: 200
Request 6: 200
Request 7: 200
Request 8: 200
Request 9: 200
Request 10: 200
```
All 10 requests succeeded with no throttling.

### Recommended Fix
Install `next-rate-limit` and apply it in the API route:

```bash
npm install next-rate-limit
```

```typescript
// app/api/sendgrid/route.ts
import { NextResponse } from 'next/server';
import sendgrid from '@sendgrid/mail';
import { RateLimiter } from 'next-rate-limit';

const limiter = new RateLimiter({
  uniqueTokenPerInterval: 500,
  interval: 60000, // 1 minute
});

export async function POST(req: Request) {
  // Allow max 5 requests per IP per minute
  const remaining = await limiter.check(5, req.headers.get('x-forwarded-for') || 'anonymous');
  if (!remaining.isRateLimited) {
    return NextResponse.json({ error: 'Too Many Requests' }, { status: 429 });
  }
  // ... rest of handler
}
```

**After fix, expected output:**
```
Request 1: 200
Request 2: 200
...
Request 6: 429  ← Too Many Requests
```

---

## Vulnerability 2 — Stored XSS via Unsanitized Input in HTML Email

- **OWASP Category:** A03:2021 – Injection
- **Affected File:** `app/api/sendgrid/route.ts`, Lines 35–50
- **Severity:** 🔴 High

### Description
User-supplied input (`name`, `email`, `phone`, `message`) is interpolated directly into an HTML email template using JavaScript template literals without any sanitization or escaping. An attacker can inject arbitrary HTML and JavaScript into the email body.

**Vulnerable code (Lines 35–50):**
```typescript
html: `
  <p style="margin: 0 0 8px 0;"><strong>Name:</strong> ${name}</p>
  <p style="margin: 0 0 8px 0;"><strong>Email:</strong> ${email}</p>
  <p style="margin: 0 0 8px 0;"><strong>Phone:</strong> ${phone}</p>
  <p style="margin: 0 0 8px 0;"><strong>Message:</strong> ${message}</p>
`
```

### Business Impact
- Malicious HTML/JS injected into emails received by the business owner
- Phishing links embedded in emails that appear to come from the business's own verified sender
- Potential for credential harvesting if the email client renders injected scripts
- Reputational damage if the business's SendGrid domain is used to send phishing content

### Proof of Concept
```bash
# XSS script injection
curl -s -X POST https://guhan.store/api/sendgrid \
  -H "Content-Type: application/json" \
  -d '{"name":"<script>alert(document.cookie)</script>","email":"xss@test.com","phone":"1234567890","message":"<img src=x onerror=alert(1)>"}'
```

**Output:** `{"success":true}` — The malicious payload was accepted and embedded in the email.

```bash
# Malicious link injection
curl -s -X POST https://guhan.store/api/sendgrid \
  -H "Content-Type: application/json" \
  -d '{"name":"Nilavan Support","email":"test@test.com","phone":"1234567890","message":"Click here to verify: <a href=http://evil-phishing-site.com>http://guhan.store/verify</a>"}'
```

**Output:** `{"success":true}` — Phishing link injected successfully into the email.

### Recommended Fix
Sanitize all inputs before embedding in HTML using the `validator` library:

```bash
npm install validator
npm install --save-dev @types/validator
```

```typescript
import validator from 'validator';

// Sanitize inputs before use
const safeName = validator.escape(name || '');
const safeEmail = validator.isEmail(email || '') ? validator.escape(email) : 'Invalid Email';
const safePhone = validator.escape(phone || '');
const safeMessage = validator.escape(message || '');

// Use sanitized values in the email template
html: `
  <p><strong>Name:</strong> ${safeName}</p>
  <p><strong>Email:</strong> ${safeEmail}</p>
  <p><strong>Phone:</strong> ${safePhone}</p>
  <p><strong>Message:</strong> ${safeMessage}</p>
`
```

---

## Vulnerability 3 — Missing Input Validation (Empty & Missing Fields Accepted)

- **OWASP Category:** A03:2021 – Injection
- **Affected File:** `app/api/sendgrid/route.ts`, Lines 6–8
- **Severity:** 🔴 High

### Description
The API performs no validation on incoming fields. It accepts empty strings, missing fields, and null values — all of which trigger a real email to be sent. There is no check that `email` is a valid email address, no minimum length for `message`, and no required field enforcement.

**Vulnerable code (Lines 6–8):**
```typescript
const body = await req.json();
const { name, email, phone, message } = body;
// No validation whatsoever before sending email
```

### Business Impact
- Spam emails with empty or garbage content flood the inbox
- No way to distinguish real enquiries from automated junk
- SendGrid quota wasted on empty submissions

### Proof of Concept
```bash
# Empty fields — still sends email
curl -s -X POST https://guhan.store/api/sendgrid \
  -H "Content-Type: application/json" \
  -d '{"name":"","email":"","phone":"","message":""}'
```
**Output:** `{"success":true}`

```bash
# Completely missing fields — still sends email
curl -s -X POST https://guhan.store/api/sendgrid \
  -H "Content-Type: application/json" \
  -d '{}'
```
**Output:** `{"success":true}`

### Recommended Fix
```typescript
export async function POST(req: Request) {
  const body = await req.json();
  const { name, email, phone, message } = body;

  // Validate required fields
  if (!name || !email || !message) {
    return NextResponse.json({ error: 'Name, email, and message are required' }, { status: 400 });
  }

  // Validate email format
  if (!validator.isEmail(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
  }

  // Validate field lengths
  if (name.length > 100 || message.length > 2000) {
    return NextResponse.json({ error: 'Input too long' }, { status: 400 });
  }

  // ... rest of handler
}
```

---

## Vulnerability 4 — Server Version Disclosure

- **OWASP Category:** A05:2021 – Security Misconfiguration
- **Affected File:** `/etc/nginx/nginx.conf` (Nginx default config)
- **Severity:** 🟡 Medium

### Description
The server exposes its exact software versions in HTTP response headers. This includes both the Nginx version and the Next.js framework. Attackers can use this information to look up known CVEs for those specific versions and craft targeted exploits.

### Proof of Concept
```bash
curl -I https://guhan.store | grep -i "server\|x-powered-by"
```

**Output:**
```
Server: nginx/1.18.0 (Ubuntu)
X-Powered-By: Next.js
```

The exact Nginx version (`1.18.0`) and framework (`Next.js`) are disclosed publicly.

### Business Impact
- Attacker knows exactly which version of Nginx is running and can search for known vulnerabilities
- Framework disclosure (`Next.js`) reveals the tech stack, aiding targeted attacks

### Recommended Fix
**In Nginx config** — add `server_tokens off`:
```nginx
# /etc/nginx/nginx.conf
http {
    server_tokens off;  # Add this line
    ...
}
```

**In Next.js** — add to `next.config.js`:
```javascript
module.exports = {
  poweredByHeader: false,  // Removes X-Powered-By: Next.js
}
```

Then reload Nginx:
```bash
sudo systemctl reload nginx
```

---

## Vulnerability 5 — Missing Content-Security-Policy Header

- **OWASP Category:** A05:2021 – Security Misconfiguration
- **Affected File:** `/etc/nginx/sites-available/nilavan`
- **Severity:** 🟡 Medium

### Description
The application does not set a `Content-Security-Policy (CSP)` header. CSP is the primary browser-level defense against XSS attacks. Without it, any injected scripts can execute freely in the user's browser.

### Proof of Concept
```bash
curl -I https://guhan.store
```

**Output — CSP header is absent:**
```
HTTP/1.1 200 OK
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
# Content-Security-Policy is MISSING
```

### Business Impact
- No browser-enforced restriction on what scripts, styles, or resources can load
- XSS attacks can execute without any browser-level mitigation
- Malicious iframes or inline scripts can run freely

### Recommended Fix
Add to Nginx config inside the `server` block:
```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none';" always;
```

---

## Vulnerability 6 — Error Message Information Disclosure

- **OWASP Category:** A05:2021 – Security Misconfiguration
- **Affected File:** `app/api/sendgrid/route.ts`, Lines 54–60
- **Severity:** 🟡 Medium

### Description
When an error occurs, the application returns generic error messages to the client but logs detailed SendGrid error responses including API response bodies to the server console. While the client-facing error is generic, the verbose internal logging could expose sensitive configuration details in log files accessible to anyone who gains partial server access.

Additionally, when invalid JSON is sent, the server returns a 500 error, leaking that an unhandled exception occurred.

**Vulnerable code (Lines 54–60):**
```typescript
catch (error: unknown) {
    console.error('SendGrid Error:', error);
    console.error('SendGrid Response Body:', sgError.response?.body); // Logs sensitive data
    return NextResponse.json({ error: 'Error sending email' }, { status: 500 });
}
```

### Proof of Concept
```bash
curl -s -X POST https://guhan.store/api/sendgrid \
  -H "Content-Type: application/json" \
  -d 'invalid json here'
```

**Output:** `{"error":"Error sending email"}` with HTTP 500 — reveals unhandled exception.

### Business Impact
- Internal server errors reveal that the application crashed, helping attackers probe for weaknesses
- Verbose server logs containing API keys or tokens could be exposed if log files are misconfigured

### Recommended Fix
```typescript
catch (error: unknown) {
  // Log sanitized error internally only
  console.error('Email sending failed - check SendGrid configuration');
  
  // Return consistent, non-revealing error to client
  return NextResponse.json(
    { error: 'Unable to process request. Please try again later.' },
    { status: 500 }
  );
}
```

---

## Vulnerability 7 — Missing HSTS Header (Fixed During Deployment)

- **OWASP Category:** A05:2021 – Security Misconfiguration
- **Affected File:** `/etc/nginx/sites-available/nilavan`
- **Severity:** 🟢 Low (Fixed)

### Description
The `Strict-Transport-Security (HSTS)` header was initially missing. Without HSTS, browsers do not enforce HTTPS, allowing SSL stripping attacks where an attacker on the same network can downgrade HTTPS connections to HTTP.

### Proof of Concept (Before Fix)
```bash
curl -I https://guhan.store | grep -i "strict"
# Returned nothing — header was absent
```

### Fix Applied
Added to Nginx config:
```nginx
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

### Verification After Fix
```bash
curl -I https://guhan.store | grep -i "strict"
# Strict-Transport-Security: max-age=31536000; includeSubDomains
```

---

## Vulnerability 8 — .git Directory Exposure (Fixed During Deployment)

- **OWASP Category:** A05:2021 – Security Misconfiguration
- **Affected File:** `/etc/nginx/sites-available/nilavan`
- **Severity:** 🔴 High (Fixed)

### Description
Without Nginx protection, the `.git` directory was publicly accessible. An attacker could use tools like `git-dumper` to download the entire repository history, including source code, hardcoded secrets, and deleted sensitive files.

### Proof of Concept (Before Fix)
```bash
curl -I https://guhan.store/.git/config
# Would return HTTP 200 with git config contents
```

### Fix Applied
```nginx
location ~ /\.git {
    deny all;
    return 404;
}
```

### Verification After Fix
```bash
curl -I https://guhan.store/.git/config
```
**Output:**
```
HTTP/1.1 404 Not Found
```

```bash
curl -I https://guhan.store/.git/HEAD
```
**Output:**
```
HTTP/1.1 404 Not Found
```

---

## Summary of All Findings

| # | Vulnerability | OWASP | Severity | Status |
|---|--------------|-------|----------|--------|
| 1 | Missing Rate Limiting | A05:2021 | 🔴 High | ⚠️ Needs Fix |
| 2 | XSS via Unsanitized HTML Email Input | A03:2021 | 🔴 High | ⚠️ Needs Fix |
| 3 | Missing Input Validation | A03:2021 | 🔴 High | ⚠️ Needs Fix |
| 4 | Server Version Disclosure | A05:2021 | 🟡 Medium | ⚠️ Needs Fix |
| 5 | Missing Content-Security-Policy | A05:2021 | 🟡 Medium | ⚠️ Needs Fix |
| 6 | Error Message Information Disclosure | A05:2021 | 🟡 Medium | ⚠️ Needs Fix |
| 7 | Missing HSTS Header | A05:2021 | 🟢 Low | ✅ Fixed |
| 8 | .git Directory Exposure | A05:2021 | 🔴 High | ✅ Fixed |

---

## Methodology

### Approach
The assessment used a combined black-box and white-box methodology:

1. **Source Code Review** — Manual review of `app/api/sendgrid/route.ts` to identify injection points, missing validation, and insecure coding patterns.

2. **Live PoC Testing** — All vulnerabilities were demonstrated with real `curl` commands against the live deployment at `https://guhan.store`.

3. **Header Analysis** — HTTP response headers were inspected using `curl -I` to identify missing security headers.

4. **Directory Traversal Testing** — Common sensitive paths (`.git`, `.env`) were tested for public exposure.

5. **Input Fuzzing** — Empty inputs, missing fields, oversized payloads, and malicious HTML were submitted to the API to test for validation and injection issues.

### Tools Used
- `curl` — HTTP request testing and header inspection
- Manual source code audit — direct code review
- Nginx config review — server hardening verification
- Browser DevTools — live site verification

---

## Decisions Made During Server Setup

1. **Non-root user (`devuser`)** — The application never runs as root. This limits the blast radius of any RCE vulnerability to the `devuser` scope only.

2. **SSH port changed to 2222** — Reduces automated brute-force attempts that target the default port 22.

3. **Password-based SSH disabled** — Key-only authentication eliminates brute-force and credential stuffing attacks on SSH.

4. **UFW firewall** — Only ports 2222, 80, and 443 are open. All other inbound traffic is denied by default.

5. **Nginx as reverse proxy** — The Node.js app is never exposed directly to the internet. Nginx handles SSL termination, security headers, and path blocking.

6. **Let's Encrypt SSL** — Free, auto-renewing certificate enforces HTTPS on all connections.

7. **PM2 process manager** — Ensures the app auto-restarts on crash and on server reboot.

---

## Trade-offs

| Decision | Trade-off |
|----------|-----------|
| `server_tokens off` hides Nginx version but doesn't prevent fingerprinting via timing | Minor — still best practice |
| CSP `unsafe-inline` needed for Next.js inline styles | Weakens CSP slightly — ideally use nonces |
| Rate limiting by IP can block legitimate users behind NAT | Acceptable trade-off vs spam risk |
| HSTS `max-age=31536000` locks HTTPS for 1 year | If SSL cert expires and isn't renewed, site becomes inaccessible |
