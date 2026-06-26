// notify.js — transactional email/SMS abstraction (PRD: notifications; STATUS §C.2).
// Provider-agnostic and zero-dependency: email goes via the SendGrid HTTP API and SMS
// via the Twilio HTTP API, both over `fetch` (same approach as push.js → FCM). Every
// send is GATED on credentials — with no provider env set, sends are logged no-ops, so
// the whole pipeline is safe to run unconfigured (e.g. the pilot). Callers treat it as
// fire-and-forget: nothing here ever throws.
//
// To enable real delivery, set:
//   Email (SendGrid):  SENDGRID_API_KEY, NOTIFY_FROM_EMAIL  (optional NOTIFY_FROM_NAME)
//   SMS   (Twilio):    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//   Links/brand:       NOTIFY_APP_URL (absolute base URL for links), NOTIFY_BRAND (display name)
'use strict';

const APP_URL = () => (process.env.NOTIFY_APP_URL || '').replace(/\/$/, '');
const BRAND = () => process.env.NOTIFY_BRAND || process.env.NOTIFY_FROM_NAME || 'Co-op';

const emailConfigured = () => !!(process.env.SENDGRID_API_KEY && process.env.NOTIFY_FROM_EMAIL);
const smsConfigured   = () => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
const configured      = () => emailConfigured() || smsConfigured();

/** Low-level email send. Never throws. Returns {sent, skipped?, error?}. */
async function sendEmail({ to, subject, text, html }) {
  if (!to) return { sent: false, skipped: true, reason: 'no-recipient' };
  if (!emailConfigured()) {
    console.log(`[notify:email:skip] "${subject}" → ${to} (SendGrid not configured)`);
    return { sent: false, skipped: true };
  }
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.NOTIFY_FROM_EMAIL, name: BRAND() },
        subject,
        content: [
          { type: 'text/plain', value: text || '' },
          ...(html ? [{ type: 'text/html', value: html }] : [])
        ]
      })
    });
    if (!res.ok) throw new Error('SendGrid ' + res.status + ' ' + (await res.text()).slice(0, 120));
    return { sent: true };
  } catch (e) { console.error('[notify:email] send failed:', e.message); return { sent: false, error: e.message }; }
}

/** Low-level SMS send (Twilio). Never throws. Returns {sent, skipped?, error?}. */
async function sendSms({ to, body }) {
  if (!to) return { sent: false, skipped: true, reason: 'no-recipient' };
  if (!smsConfigured()) {
    console.log(`[notify:sms:skip] → ${to} (Twilio not configured)`);
    return { sent: false, skipped: true };
  }
  try {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const creds = Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
    const form = new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: String(body || '').slice(0, 1500) });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    if (!res.ok) throw new Error('Twilio ' + res.status + ' ' + (await res.text()).slice(0, 120));
    return { sent: true };
  } catch (e) { console.error('[notify:sms] send failed:', e.message); return { sent: false, error: e.message }; }
}

// ---------------- high-level transactional flows ----------------

/** Password reset (STATUS §D / §C.2). Emails the one-time token + a deep link. */
async function passwordReset({ email, token, name }) {
  const b = BRAND();
  const link = `${APP_URL()}/?reset=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
  return sendEmail({
    to: email,
    subject: `Reset your ${b} password`,
    text: `Hi ${name || 'there'},\n\nUse this code to reset your ${b} password (valid for 1 hour):\n\n${token}\n\nOr open: ${link}\n\nIf you didn't request this, you can ignore this email.\n\n— ${b}`,
    html: `<p>Hi ${esc(name) || 'there'},</p><p>Use this code to reset your ${esc(b)} password (valid for 1 hour):</p><p style="font-size:18px"><strong>${esc(token)}</strong></p><p><a href="${esc(link)}">Reset your password</a></p><p>If you didn't request this, you can ignore this email.</p><p>— ${esc(b)}</p>`
  });
}

/** Onboarding approval decision (PRD ONB-12). */
async function approvalDecision({ email, name, role, decision, reason }) {
  const b = BRAND();
  const approved = decision === 'approve' || decision === 'active' || decision === 'approved';
  const roleLabel = role === 'restaurant' ? 'restaurant partner' : role === 'driver' ? 'driver' : role === 'rider' ? 'rider' : 'member';
  const subject = approved ? `You're approved — welcome to ${b}` : `Update on your ${b} ${roleLabel} application`;
  const body = approved
    ? `Hi ${name || 'there'},\n\nGreat news — your ${b} ${roleLabel} application has been approved. You can sign in now: ${APP_URL()}/\n\n— ${b}`
    : `Hi ${name || 'there'},\n\nThank you for applying to ${b} as a ${roleLabel}. After review we're unable to approve your application at this time.${reason ? `\n\nReason: ${reason}` : ''}\n\nYou can update your details and resubmit from your account.\n\n— ${b}`;
  return sendEmail({ to: email, subject, text: body,
    html: `<p>${body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>` });
}

/** OTP verification code (PRD ONB-26). Sends by SMS when a phone is given, else email. */
async function otpCode({ email, phone, code }) {
  const b = BRAND();
  const msg = `Your ${b} verification code is ${code}. It expires in 10 minutes.`;
  if (phone && smsConfigured()) { const r = await sendSms({ to: phone, body: msg }); return { ...r, channel: 'sms' }; }
  const r = await sendEmail({ to: email, subject: `Your ${b} verification code`, text: msg,
    html: `<p>Your ${esc(b)} verification code is <strong>${esc(code)}</strong>.</p><p>It expires in 10 minutes.</p>` });
  return { ...r, channel: 'email' };
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

module.exports = {
  configured, emailConfigured, smsConfigured,
  sendEmail, sendSms,
  passwordReset, approvalDecision, otpCode
};
