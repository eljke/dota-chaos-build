import assert from 'node:assert/strict';
import test from 'node:test';
import { signVerificationPayload, verifyVerificationSignature } from '../worker/src/verification-auth.js';

test('verification callback signatures are stable and tamper-evident', async () => {
  const secret = 'a'.repeat(64);
  const timestamp = '1786124014';
  const body = JSON.stringify({ jobId: '00000000-0000-4000-8000-000000000000', status: 'running' });
  const signature = await signVerificationPayload(secret, timestamp, body);

  assert.match(signature, /^[0-9a-f]{64}$/);
  assert.equal(await verifyVerificationSignature(secret, timestamp, body, signature), true);
  assert.equal(await verifyVerificationSignature(secret, timestamp, `${body} `, signature), false);
  assert.equal(await verifyVerificationSignature(`${secret}x`, timestamp, body, signature), false);
});
