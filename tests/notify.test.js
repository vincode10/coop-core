// notify.test.js — transport + generic flows; unconfigured no-op (no provider env).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
for (const k of ['SENDGRID_API_KEY', 'NOTIFY_FROM_EMAIL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']) delete process.env[k];
const notify = require('../notify');

test('unconfigured: configured() false; sends are skipped no-ops', async () => {
  assert.equal(notify.configured(), false);
  assert.equal((await notify.sendEmail({ to: 'a@b.com', subject: 'x', text: 'y' })).skipped, true);
  assert.equal((await notify.sendSms({ to: '+61400000000', body: 'x' })).skipped, true);
});

test('generic flows never throw and report skipped when unconfigured', async () => {
  assert.equal((await notify.passwordReset({ email: 'a@b.com', token: 't', name: 'Sam' })).skipped, true);
  assert.equal((await notify.approvalDecision({ email: 'a@b.com', name: 'Sam', role: 'driver', decision: 'approve' })).skipped, true);
  const otp = await notify.otpCode({ email: 'a@b.com', code: '123456' });
  assert.equal(otp.channel, 'email');
  assert.equal(otp.skipped, true);
});
