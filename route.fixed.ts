import { NextResponse } from 'next/server';
import sendgrid from '@sendgrid/mail';
import { NextRequest } from 'next/server';

// ─── In-memory rate limiter ───────────────────────────────────────────────────
// Tracks request counts per IP. Resets every 60 seconds.
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 5;         // max requests per window
const WINDOW_MS = 60 * 1000;  // 1 minute window

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + WINDOW_MS });
    return false;
  }

  if (entry.count >= RATE_LIMIT) {
    return true;
  }

  entry.count++;
  return false;
}

// ─── Input sanitizer ─────────────────────────────────────────────────────────
// Escapes HTML special characters to prevent XSS in email body
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br/>');  // also prevents header injection
}

// ─── Email validator ──────────────────────────────────────────────────────────
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// ─── API Route Handler ────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {

    // FIX 1: Rate Limiting — max 5 requests per IP per minute
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      'anonymous';

    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again later.' },
        { status: 429 }
      );
    }

    const body = await req.json();
    const { name, email, phone, message } = body;

    // FIX 2: Input Validation — required fields and format checks
    if (!name || !email || !message) {
      return NextResponse.json(
        { error: 'Name, email, and message are required.' },
        { status: 400 }
      );
    }

    if (!isValidEmail(email)) {
      return NextResponse.json(
        { error: 'Invalid email address.' },
        { status: 400 }
      );
    }

    if (name.length > 100 || message.length > 2000) {
      return NextResponse.json(
        { error: 'Input exceeds maximum allowed length.' },
        { status: 400 }
      );
    }

    // FIX 3: Sanitize all inputs before embedding in HTML email
    const safeName    = escapeHtml(String(name).trim());
    const safeEmail   = escapeHtml(String(email).trim());
    const safePhone   = escapeHtml(String(phone || 'Not provided').trim());
    const safeMessage = escapeHtml(String(message).trim());

    const apiKey  = process.env.SENDGRID_API_KEY;
    const toEmail = process.env.SENDGRID_TO_EMAIL;

    if (!apiKey) {
      // FIX 4: No sensitive details in error response — log internally only
      console.error('[SendGrid] SENDGRID_API_KEY is not configured');
      return NextResponse.json(
        { error: 'Unable to process request. Please try again later.' },
        { status: 500 }
      );
    }

    if (!toEmail) {
      console.error('[SendGrid] SENDGRID_TO_EMAIL is not configured');
      return NextResponse.json(
        { error: 'Unable to process request. Please try again later.' },
        { status: 500 }
      );
    }

    sendgrid.setApiKey(apiKey);

    const msg = {
      to: toEmail,
      from: toEmail,
      subject: 'New Contact Form Submission',
      // Plain text version also uses safe values
      text: `Name: ${safeName}\nEmail: ${safeEmail}\nPhone: ${safePhone}\nMessage: ${safeMessage}`,
      // FIX 3: All user values are HTML-escaped before embedding
      html: `
        <html>
          <body style="background: #f6f6f7; padding: 40px 0;">
            <div style="max-width: 480px; margin: 40px auto; background: #fff; border-radius: 18px;
                        box-shadow: 0 2px 8px rgba(0,0,0,0.04); padding: 32px; font-family: Arial, sans-serif;">
              <div style="text-align: center; margin-bottom: 24px;">
                <div style="font-size: 22px; font-weight: bold; letter-spacing: 1px; color: #222;">
                  NILAVAN REALTORS
                </div>
              </div>
              <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
              <div style="font-size: 16px; color: #222; margin-bottom: 24px;">
                <p style="margin: 0 0 16px 0;">You have a new contact form submission:</p>
                <p style="margin: 0 0 8px 0;"><strong>Name:</strong> ${safeName}</p>
                <p style="margin: 0 0 8px 0;"><strong>Email:</strong> ${safeEmail}</p>
                <p style="margin: 0 0 8px 0;"><strong>Phone:</strong> ${safePhone}</p>
                <p style="margin: 0 0 8px 0;"><strong>Message:</strong> ${safeMessage}</p>
              </div>
            </div>
          </body>
        </html>
      `,
    };

    await sendgrid.send(msg);
    return NextResponse.json({ success: true });

  } catch (error: unknown) {
    // FIX 4: Log error internally but never expose details to client
    console.error('[SendGrid] Failed to send email:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Unable to process request. Please try again later.' },
      { status: 500 }
    );
  }
}
