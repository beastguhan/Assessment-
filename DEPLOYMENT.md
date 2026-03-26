# Deployment Guide — Nilavan Realtors Next.js App

**Live URL:** https://guhan.store  
**Server:** AWS EC2 t2.micro (Ubuntu 24.04 LTS)  
**Deployed By:** DevOps Engineer  
**Deployment Date:** 26 March 2026  

---

## Stack Overview

| Component | Technology |
|-----------|-----------|
| Cloud Provider | AWS EC2 (Free Tier) |
| OS | Ubuntu 24.04 LTS |
| Web Server | Nginx 1.18 (reverse proxy) |
| Process Manager | PM2 |
| SSL | Let's Encrypt (Certbot) |
| Runtime | Node.js 18 (via NVM) |
| Application | Next.js 15 |
| Domain | guhan.store (Hostinger DNS) |

---

## Step 1 — Launch AWS EC2 Instance

1. Login to [aws.amazon.com](https://aws.amazon.com) → EC2 → **Launch Instance**
2. Choose **Ubuntu 24.04 LTS** (Free Tier eligible)
3. Instance type: **t2.micro**
4. Create a new key pair → download `.pem` file
5. Security Group — add inbound rules:
   - SSH → Port 22 → 0.0.0.0/0
   - HTTP → Port 80 → 0.0.0.0/0
   - HTTPS → Port 443 → 0.0.0.0/0
6. Launch instance — note the **Public IP**

---

## Step 2 — Connect to EC2

```bash
chmod 400 your-key.pem
ssh -i your-key.pem ubuntu@YOUR_EC2_IP
```

Verify the server IP:
```bash
curl ifconfig.me
# Output: 34.202.236.139
```

---

## Step 3 — Point Domain DNS to EC2

1. Login to Hostinger → Domains → guhan.store → DNS/Nameservers
2. Edit the **A record** (name: @) → set value to `34.202.236.139`
3. Edit the **www A record** → set value to `34.202.236.139`
4. Save — wait 10–30 minutes for DNS propagation

Verify DNS propagation:
```bash
nslookup guhan.store
# Should return 34.202.236.139
```

---

## Step 4 — Create Non-Root User

> The application must NEVER run as root. All app operations use `devuser`.

```bash
sudo adduser devuser
sudo usermod -aG sudo devuser
sudo rsync --archive --chown=devuser:devuser ~/.ssh /home/devuser
```

---

## Step 5 — Harden SSH Configuration

```bash
sudo nano /etc/ssh/sshd_config
```

Change the following lines:
```
Port 2222
PasswordAuthentication no
PermitRootLogin no
```

> ⚠️ Before restarting SSH — add port 2222 in AWS Security Group:
> EC2 → Security Groups → Edit Inbound Rules → Add Custom TCP → Port 2222 → 0.0.0.0/0

```bash
sudo systemctl restart ssh
```

Open a new terminal and verify new SSH connection works:
```bash
ssh -i your-key.pem -p 2222 devuser@34.202.236.139
```

All subsequent commands are run as `devuser`.

---

## Step 6 — Configure UFW Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 2222/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

Expected output:
```
Status: active

To                         Action      From
--                         ------      ----
2222/tcp                   ALLOW IN    Anywhere
80/tcp                     ALLOW IN    Anywhere
443/tcp                    ALLOW IN    Anywhere
```

---

## Step 7 — Install Node.js 18 via NVM

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 18
nvm use 18
node -v
npm -v
```

Expected output:
```
v18.20.4
10.7.0
```

---

## Step 8 — Install Nginx and PM2

```bash
sudo apt update
sudo apt install nginx -y
npm install -g pm2
nginx -v
pm2 -v
```

---

## Step 9 — Clone and Build the Application

```bash
cd ~
git clone https://github.com/Leadtap/lt-nilavan.git
cd lt-nilavan
npm install
```

Create environment file:
```bash
nano .env.local
```

Add the following:
```
SENDGRID_API_KEY=your_sendgrid_api_key_here
SENDGRID_TO_EMAIL=your_verified_sender@email.com
```

Build the application:
```bash
npm run build
```

---

## Step 10 — Run Application with PM2

```bash
pm2 start npm --name "nilavan" -- start
pm2 save
pm2 startup
```

Copy and run the command output by `pm2 startup`, for example:
```bash
sudo env PATH=$PATH:/home/devuser/.nvm/versions/node/v18.20.4/bin pm2 startup systemd -u devuser --hp /home/devuser
```

Verify app is running:
```bash
pm2 list
```

Expected output:
```
┌────┬──────────┬──────────┬─────────┬─────────┬──────────┐
│ id │ name     │ mode     │ status  │ restart │ uptime   │
├────┼──────────┼──────────┼─────────┼─────────┼──────────┤
│ 0  │ nilavan  │ fork     │ online  │ 0       │ 1m       │
└────┴──────────┴──────────┴─────────┴─────────┴──────────┘
```

---

## Step 11 — Configure Nginx as Reverse Proxy

```bash
sudo nano /etc/nginx/sites-available/nilavan
```

Paste the following configuration:
```nginx
server {
    listen 80;
    server_name guhan.store www.guhan.store;

    # Block .git directory — prevents source code exposure
    location ~ /\.git {
        deny all;
        return 404;
    }

    # Block all hidden files
    location ~ /\. {
        deny all;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the config:
```bash
sudo ln -s /etc/nginx/sites-available/nilavan /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

Expected output of `nginx -t`:
```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

---

## Step 12 — Obtain SSL Certificate (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d guhan.store -d www.guhan.store
```

Follow the prompts:
- Enter your email address
- Agree to terms → Y
- Share email with EFF → N
- Redirect HTTP to HTTPS → **2**

Reload Nginx:
```bash
sudo systemctl reload nginx
```

Verify SSL is working:
```bash
curl -I https://guhan.store
```

Expected output:
```
HTTP/1.1 200 OK
...
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

---

## Step 13 — Hide Server Version Information

Edit Nginx main config:
```bash
sudo nano /etc/nginx/nginx.conf
```

Inside the `http {}` block, add:
```nginx
server_tokens off;
```

Edit Next.js config:
```bash
nano ~/lt-nilavan/next.config.js
```

Add:
```javascript
module.exports = {
  poweredByHeader: false,
}
```

Reload Nginx and rebuild:
```bash
sudo systemctl reload nginx
cd ~/lt-nilavan && npm run build && pm2 restart nilavan
```

---

## Step 14 — Final Verification Checklist

```bash
# 1. App running via PM2
pm2 list

# 2. Firewall status
sudo ufw status verbose

# 3. HTTPS working
curl -I https://guhan.store

# 4. HTTP redirects to HTTPS
curl -I http://guhan.store

# 5. .git directory blocked
curl -I https://guhan.store/.git/config

# 6. .env blocked
curl -I https://guhan.store/.env

# 7. Security headers present
curl -I https://guhan.store | grep -i "x-frame\|strict\|content-type\|x-xss\|referrer"
```

Expected results:
```
PM2 status: online
UFW: active with ports 2222, 80, 443
HTTPS: HTTP/1.1 200 OK
HTTP redirect: HTTP/1.1 301 Moved Permanently → https://guhan.store
.git: HTTP/1.1 404 Not Found
.env: HTTP/1.1 403 Forbidden
Security headers: all present
```

---

## Why These Decisions Were Made

| Decision | Reason |
|----------|--------|
| Non-root user `devuser` | Limits blast radius of any RCE exploit — attacker cannot access system files |
| SSH port changed to 2222 | Stops automated bots that scan port 22 constantly |
| Password SSH disabled | Eliminates brute-force and credential stuffing attacks |
| UFW default deny | All ports closed unless explicitly opened — least privilege |
| Nginx reverse proxy | Node.js never exposed directly — Nginx handles SSL, headers, path blocking |
| PM2 process manager | Auto-restart on crash and on server reboot — high availability |
| Let's Encrypt SSL | Free, trusted, auto-renewing — enforces HTTPS on all connections |
| `.git` blocked in Nginx | Prevents source code and secret exposure via browser |
| Security headers in Nginx | Protects against clickjacking, MIME sniffing, XSS at browser level |
