// src/data/sessionSettings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_SETTINGS_VERSION,
  SERVER_API_KEY_DEFS,
  createDefaultSessionSettings,
  normalizeSessionSettings,
  mergeSessionSettings,
  describeServerKeyStatus,
  toClientSettings,
} from './sessionSettings.js';

const VALID_CAMERA = { lon: 2.6502, lat: 39.5696, height: 800, heading: 1.2, pitch: -0.5, roll: 0 };

// ── createDefaultSessionSettings / normalizeSessionSettings ────────────

test('createDefaultSessionSettings returns an empty, well-shaped record', () => {
  const defaults = createDefaultSessionSettings();
  assert.equal(defaults.version, SESSION_SETTINGS_VERSION);
  assert.deepEqual(defaults.apiKeys, {});
  assert.equal(defaults.camera, null);
  assert.equal(defaults.mapStack, null);
  assert.equal(defaults.panelAlpha, null);
  assert.equal(defaults.layerState, null);
  assert.equal(defaults.updatedAt, null);
});

test('normalizeSessionSettings falls back to defaults for non-object input', () => {
  assert.deepEqual(normalizeSessionSettings(null), createDefaultSessionSettings());
  assert.deepEqual(normalizeSessionSettings(undefined), createDefaultSessionSettings());
  assert.deepEqual(normalizeSessionSettings('nonsense'), createDefaultSessionSettings());
});

test('normalizeSessionSettings accepts a fully-populated valid record', () => {
  const out = normalizeSessionSettings({
    apiKeys: { FIRMS_MAP_KEY: '  abc123  ', TOMTOM_API_KEY: 'xyz' },
    camera: VALID_CAMERA,
    mapStack: 'hybrid',
    panelAlpha: 0.5,
    layerState: '{"v":2}',
    updatedAt: 1700000000000,
  });
  assert.deepEqual(out.apiKeys, { FIRMS_MAP_KEY: 'abc123', TOMTOM_API_KEY: 'xyz' });
  assert.deepEqual(out.camera, VALID_CAMERA);
  assert.equal(out.mapStack, 'hybrid');
  assert.equal(out.panelAlpha, 0.5);
  assert.equal(out.layerState, '{"v":2}');
  assert.equal(out.updatedAt, 1700000000000);
});

test('normalizeSessionSettings drops unknown apiKeys ids', () => {
  const out = normalizeSessionSettings({ apiKeys: { NOT_A_REAL_KEY: 'x', FIRMS_MAP_KEY: 'y' } });
  assert.deepEqual(out.apiKeys, { FIRMS_MAP_KEY: 'y' });
});

test('normalizeSessionSettings drops empty/whitespace-only apiKeys values', () => {
  const out = normalizeSessionSettings({ apiKeys: { FIRMS_MAP_KEY: '   ' } });
  assert.deepEqual(out.apiKeys, {});
});

test('normalizeSessionSettings rejects a camera pose missing any field', () => {
  for (const field of ['lon', 'lat', 'height', 'heading', 'pitch', 'roll']) {
    const broken = { ...VALID_CAMERA };
    delete broken[field];
    assert.equal(normalizeSessionSettings({ camera: broken }).camera, null, `field: ${field}`);
  }
});

test('normalizeSessionSettings rejects a camera pose with non-finite fields', () => {
  assert.equal(normalizeSessionSettings({ camera: { ...VALID_CAMERA, lat: NaN } }).camera, null);
  assert.equal(normalizeSessionSettings({ camera: { ...VALID_CAMERA, lon: 'nope' } }).camera, null);
  assert.equal(normalizeSessionSettings({ camera: { ...VALID_CAMERA, lat: 200 } }).camera, null);
  assert.equal(normalizeSessionSettings({ camera: { ...VALID_CAMERA, height: -99999 } }).camera, null);
});

test('normalizeSessionSettings clamps panelAlpha into [0.2, 0.95]', () => {
  assert.equal(normalizeSessionSettings({ panelAlpha: 0 }).panelAlpha, 0.2);
  assert.equal(normalizeSessionSettings({ panelAlpha: 5 }).panelAlpha, 0.95);
  assert.equal(normalizeSessionSettings({ panelAlpha: 0.5 }).panelAlpha, 0.5);
});

test('normalizeSessionSettings treats null/empty/non-numeric panelAlpha as unset', () => {
  assert.equal(normalizeSessionSettings({ panelAlpha: null }).panelAlpha, null);
  assert.equal(normalizeSessionSettings({ panelAlpha: '' }).panelAlpha, null);
  assert.equal(normalizeSessionSettings({ panelAlpha: 'nope' }).panelAlpha, null);
});

test('normalizeSessionSettings rejects a blank mapStack/layerState as unset', () => {
  assert.equal(normalizeSessionSettings({ mapStack: '   ' }).mapStack, null);
  assert.equal(normalizeSessionSettings({ mapStack: 42 }).mapStack, null);
  assert.equal(normalizeSessionSettings({ layerState: '' }).layerState, null);
  assert.equal(normalizeSessionSettings({ layerState: 42 }).layerState, null);
});

// ── mergeSessionSettings ────────────────────────────────────────────────

test('mergeSessionSettings: an apiKeys patch sets/replaces only the given ids', () => {
  const base = normalizeSessionSettings({ apiKeys: { FIRMS_MAP_KEY: 'old', TOMTOM_API_KEY: 'kept' } });
  const merged = mergeSessionSettings(base, { apiKeys: { FIRMS_MAP_KEY: 'new' } });
  assert.deepEqual(merged.apiKeys, { FIRMS_MAP_KEY: 'new', TOMTOM_API_KEY: 'kept' });
});

test('mergeSessionSettings: an explicit empty-string apiKeys value clears that key only', () => {
  const base = normalizeSessionSettings({ apiKeys: { FIRMS_MAP_KEY: 'a', TOMTOM_API_KEY: 'b' } });
  const merged = mergeSessionSettings(base, { apiKeys: { FIRMS_MAP_KEY: '' } });
  assert.deepEqual(merged.apiKeys, { TOMTOM_API_KEY: 'b' });
});

test('mergeSessionSettings: apiKeys absent from the patch entirely leaves all keys untouched', () => {
  const base = normalizeSessionSettings({ apiKeys: { FIRMS_MAP_KEY: 'a' }, mapStack: 'osm' });
  const merged = mergeSessionSettings(base, { mapStack: 'hybrid' });
  assert.deepEqual(merged.apiKeys, { FIRMS_MAP_KEY: 'a' });
  assert.equal(merged.mapStack, 'hybrid');
});

test('mergeSessionSettings: a field present in the patch replaces the base value, including null', () => {
  const base = normalizeSessionSettings({ camera: VALID_CAMERA, mapStack: 'osm' });
  const merged = mergeSessionSettings(base, { camera: null, mapStack: 'hybrid' });
  assert.equal(merged.camera, null);
  assert.equal(merged.mapStack, 'hybrid');
});

test('mergeSessionSettings: a field absent from the patch keeps the base value', () => {
  const base = normalizeSessionSettings({ camera: VALID_CAMERA, panelAlpha: 0.4 });
  const merged = mergeSessionSettings(base, { mapStack: 'osm' });
  assert.deepEqual(merged.camera, VALID_CAMERA);
  assert.equal(merged.panelAlpha, 0.4);
});

test('mergeSessionSettings always stamps a fresh updatedAt', () => {
  const base = normalizeSessionSettings({ updatedAt: 1 });
  const merged = mergeSessionSettings(base, {});
  assert.ok(merged.updatedAt > 1);
});

test('mergeSessionSettings tolerates a non-object patch by returning the normalized base unchanged', () => {
  const base = normalizeSessionSettings({ mapStack: 'osm' });
  assert.deepEqual(mergeSessionSettings(base, null), base);
});

// ── describeServerKeyStatus ──────────────────────────────────────────────

test('describeServerKeyStatus covers every SERVER_API_KEY_DEFS entry exactly once', () => {
  const status = describeServerKeyStatus(createDefaultSessionSettings(), {});
  assert.equal(status.length, SERVER_API_KEY_DEFS.length);
  assert.deepEqual(status.map((s) => s.id).sort(), SERVER_API_KEY_DEFS.map((d) => d.id).sort());
});

test('describeServerKeyStatus: a file-saved key reports configured/source=file even when env also has one', () => {
  const settings = normalizeSessionSettings({ apiKeys: { FIRMS_MAP_KEY: 'file-value' } });
  const status = describeServerKeyStatus(settings, { FIRMS_MAP_KEY: 'env-value' });
  const firms = status.find((s) => s.id === 'FIRMS_MAP_KEY');
  assert.equal(firms.configured, true);
  assert.equal(firms.source, 'file');
});

test('describeServerKeyStatus: no file value but an env value reports configured/source=env', () => {
  const status = describeServerKeyStatus(createDefaultSessionSettings(), { TOMTOM_API_KEY: 'env-value' });
  const tomtom = status.find((s) => s.id === 'TOMTOM_API_KEY');
  assert.equal(tomtom.configured, true);
  assert.equal(tomtom.source, 'env');
});

test('describeServerKeyStatus: neither file nor env reports not configured/source=none', () => {
  const status = describeServerKeyStatus(createDefaultSessionSettings(), {});
  for (const entry of status) {
    assert.equal(entry.configured, false);
    assert.equal(entry.source, 'none');
  }
});

test('describeServerKeyStatus never exposes the actual secret value', () => {
  const settings = normalizeSessionSettings({ apiKeys: { OPENAI_API_KEY: 'sk-super-secret' } });
  const status = describeServerKeyStatus(settings, {});
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('sk-super-secret'));
});

// ── toClientSettings ─────────────────────────────────────────────────────

test('toClientSettings never includes apiKeys, even when populated', () => {
  const settings = normalizeSessionSettings({ apiKeys: { FIRMS_MAP_KEY: 'secret' }, mapStack: 'osm' });
  const client = toClientSettings(settings);
  assert.equal('apiKeys' in client, false);
  assert.equal(client.mapStack, 'osm');
  assert.ok(!JSON.stringify(client).includes('secret'));
});

test('toClientSettings normalizes whatever it is given (defensive against a malformed disk file)', () => {
  const client = toClientSettings({ mapStack: 42, camera: 'nope' });
  assert.equal(client.mapStack, null);
  assert.equal(client.camera, null);
});
