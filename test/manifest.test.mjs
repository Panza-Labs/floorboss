import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const plugin = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url)));
const market = JSON.parse(readFileSync(new URL('../.claude-plugin/marketplace.json', import.meta.url)));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

test('manifests agree', () => {
  assert.equal(plugin.name, 'floorboss');
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, './');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(plugin.version, pkg.version);
  assert.deepEqual(plugin.author, { name: 'Panza Labs', url: 'https://panzalabs.com' });
  assert.equal(plugin.license, 'Apache-2.0');
});

test('no runtime dependencies', () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});
