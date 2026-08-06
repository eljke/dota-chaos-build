import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.btoa = value => Buffer.from(value, 'binary').toString('base64');
globalThis.atob = value => Buffer.from(value, 'base64').toString('binary');

const { decodeBuildCode, encodeBuildCode } = await import('../js/build-code.js');

test('build code round-trips unicode-safe parameters', () => {
  const value = 's=ABC123&h=axe&i=phase_boots.blink&note=хаос';
  assert.equal(decodeBuildCode(encodeBuildCode(value)), value);
});

test('invalid build code is rejected', () => {
  assert.equal(decodeBuildCode('not-a-build'), null);
  assert.equal(decodeBuildCode('DCB1-%%%'), null);
});
