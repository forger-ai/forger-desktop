import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCampaignMeasurementOwner } = require('../../dist-electron/main/campaign-measurement-owner.js');

test('campaign owners are per composition, lazy, guarded in non-production, and close on quit', () => {
  const variants = [{ packaged: true }, { packaged: false }, { packaged: true, isDev: true },
    { packaged: true, isTest: true }, { packaged: true, e2eProfileRoot: '/tmp/isolated-forger-test' }];
  const owners = [];
  for (const variant of variants) {
    const listeners = [];
    let pathReads = 0;
    const app = { isPackaged: variant.packaged, getVersion: () => '0.5.18',
      getPath: () => { pathReads += 1; return '/tmp/forger-not-opened-test-profile'; }, on: (...args) => listeners.push(args) };
    const get = createCampaignMeasurementOwner({ app, isDev: false, isTest: false, ...variant });
    assert.equal(pathReads, 0); assert.equal(listeners.length, 0);
    const owner = get(); owners.push(owner);
    assert.equal(get(), owner); assert.equal(listeners.length, 1);
    assert.equal(owner.options.enabled, variant.packaged && !variant.isDev && !variant.isTest && !variant.e2eProfileRoot);
    assert.equal(owner.closed, false); listeners[0][1](); assert.equal(owner.closed, true);
  }
  assert.equal(new Set(owners).size, variants.length);
});
