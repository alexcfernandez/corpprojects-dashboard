// test/canonical.test.js — regla de redirección a dominio canónico.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { shouldRedirect } = require('../src/canonical');

const HOST = 'dashboard.corpprojects.es';
const RAILWAY = 'corpprojects-dashboard-production.up.railway.app';

test('sin CANONICAL_HOST no redirige nunca', () => {
  assert.equal(shouldRedirect({ method: 'GET', host: RAILWAY, path: '/', canonicalHost: undefined }), false);
});

test('redirige una navegación GET desde la URL de Railway', () => {
  assert.equal(shouldRedirect({ method: 'GET', host: RAILWAY, path: '/', canonicalHost: HOST }), true);
  assert.equal(shouldRedirect({ method: 'GET', host: RAILWAY, path: '/parte', canonicalHost: HOST }), true);
});

test('no redirige si ya estás en el dominio canónico', () => {
  assert.equal(shouldRedirect({ method: 'GET', host: HOST, path: '/', canonicalHost: HOST }), false);
});

test('nunca redirige el healthcheck', () => {
  assert.equal(shouldRedirect({ method: 'GET', host: RAILWAY, path: '/health', canonicalHost: HOST }), false);
});

test('nunca redirige la API (webhook de Twilio incluido)', () => {
  assert.equal(shouldRedirect({ method: 'GET',  host: RAILWAY, path: '/api/summary',  canonicalHost: HOST }), false);
  assert.equal(shouldRedirect({ method: 'POST', host: RAILWAY, path: '/api/whatsapp', canonicalHost: HOST }), false);
});

test('nunca redirige el callback de OAuth de Google', () => {
  assert.equal(shouldRedirect({ method: 'GET', host: RAILWAY, path: '/auth/google/callback', canonicalHost: HOST }), false);
});

test('no redirige peticiones que no son GET', () => {
  assert.equal(shouldRedirect({ method: 'POST', host: RAILWAY, path: '/', canonicalHost: HOST }), false);
});

test('no redirige si no hay host', () => {
  assert.equal(shouldRedirect({ method: 'GET', host: undefined, path: '/', canonicalHost: HOST }), false);
});
