// tests/unit/src/providers/providersKindBinding.rr2.test.js
// ============================================================================
// RR2-C003 (release requalification 1.0.4 recheck-2): the custom-URL
// production block keyed on `kind === 'custom-openai'` was bypassable —
// an arbitrary id + kind='openrouter' + attacker baseUrl slipped past it,
// and unknown kinds were never rejected. The fix binds ID->kind server
// side, whitelists kinds, accepts only known combinations in production,
// and re-pins built-in kinds at store read/write time.
// ============================================================================
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateProvidersSetPayload, ALLOWED_KINDS, PROVIDER_KIND_BINDING,
} = require('../../../../src/providersPayloadSchema');
const store = require('../../../../src/providersStore');

function builtinTrio(overrides = {}) {
  return {
    providers: [
      { id: 'openrouter', label: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
      { id: 'replicate', label: 'Replicate', kind: 'replicate', baseUrl: '' },
      { id: 'custom-openai', label: 'Custom (OpenAI-compat)', kind: 'custom-openai', baseUrl: '' },
    ],
    ...overrides,
  };
}

test('RR2-C003: legitimate trio passes in BOTH dev and production modes', () => {
  assert.equal(validateProvidersSetPayload(builtinTrio()).ok, true);
  assert.equal(validateProvidersSetPayload(builtinTrio(), { production: true }).ok, true);
});

test('RR2-C003: unknown kinds are rejected (kind is the adapter selector)', () => {
  const p = builtinTrio();
  p.providers.push({ id: 'smuggler', label: 'X', kind: 'evil-adapter', baseUrl: 'https://evil.example/v1' });
  const r = validateProvidersSetPayload(p);
  assert.equal(r.ok, false);
  assert.match(r.error, /kind "evil-adapter" is not allowed/);
});

test('RR2-C003: the documented bypass shape (arbitrary id + openrouter kind + attacker baseUrl) is rejected', () => {
  // In production: unknown id rejected. In dev: still allowed to register
  // extra providers, but ONLY with a whitelisted kind and a separate SSRF
  // gate applies at set-time — the OLD hole was specifically that this
  // shape escaped the custom-URL production block, which now keys on id.
  const p = builtinTrio();
  p.providers.push({ id: 'attacker', label: 'A', kind: 'openrouter', baseUrl: 'https://attacker.example/v1' });
  assert.equal(validateProvidersSetPayload(p, { production: true }).ok, false);
});

test('RR2-C003: built-in IDs are permanently bound to their kind', () => {
  for (const [id, kind] of Object.entries(PROVIDER_KIND_BINDING)) {
    const p = builtinTrio();
    const entry = p.providers.find((x) => x.id === id);
    entry.kind = kind === 'openrouter' ? 'replicate' : 'openrouter';
    const r = validateProvidersSetPayload(p);
    assert.equal(r.ok, false, `re-kinding ${id} must be rejected`);
    assert.match(r.error, /permanently bound/);
  }
});

test('RR2-C003: production rejects ANY unknown provider id', () => {
  const p = builtinTrio();
  p.providers.push({ id: 'extra', label: 'E', kind: 'custom-openai', baseUrl: '' });
  assert.equal(validateProvidersSetPayload(p).ok, true, 'dev may register extras');
  const r = validateProvidersSetPayload(p, { production: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown id "extra"/);
});

test('RR2-C003: ALLOWED_KINDS and the binding cover exactly the adapter set', () => {
  assert.deepEqual([...ALLOWED_KINDS].sort(), ['custom-openai', 'openrouter', 'replicate']);
  assert.deepEqual(Object.keys(PROVIDER_KIND_BINDING).sort(), ['custom-openai', 'openrouter', 'replicate']);
});

test('RR2-C003: store _pinBuiltins re-kinds EVERY built-in, incl. custom-openai', () => {
  const d = {
    providers: [
      { id: 'openrouter', kind: 'replicate', baseUrl: 'https://evil.example' },
      { id: 'replicate', kind: 'custom-openai', baseUrl: 'https://evil.example' },
      { id: 'custom-openai', kind: 'openrouter', baseUrl: 'https://user-set.example/v1' },
    ],
  };
  store._pinBuiltins(d);
  assert.equal(d.providers[0].kind, 'openrouter');
  assert.equal(d.providers[0].baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(d.providers[1].kind, 'replicate');
  assert.equal(d.providers[1].baseUrl, '');
  // custom-openai: KIND is pinned but its baseUrl stays user-settable.
  assert.equal(d.providers[2].kind, 'custom-openai');
  assert.equal(d.providers[2].baseUrl, 'https://user-set.example/v1');
});
