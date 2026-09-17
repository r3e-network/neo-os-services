import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

test('admin proxy pins upstream and rewrites callback locations', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (request) => {
    seen = request;
    return new Response(null, {
      status: 302,
      headers: {
        location: 'https://admin.neomini.app/auth/callback?code=x',
        'set-cookie': 'sid=x; Domain=admin.neomini.app; Path=/',
      },
    });
  };
  try {
    const response = await worker.fetch(
      new Request('https://admin.neoos.network/auth/login?returnTo=%2F')
    );
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('location'),
      'https://admin.neoos.network/auth/callback?code=x'
    );
    assert.equal(response.headers.get('set-cookie'), 'sid=x; Path=/');
    assert.equal(seen.url, 'https://admin.neomini.app/auth/login?returnTo=%2F');
  } finally {
    globalThis.fetch = original;
  }
});

test('admin proxy never follows a caller-provided origin', async () => {
  const original = globalThis.fetch;
  let url = '';
  globalThis.fetch = async (request) => {
    url = request.url;
    return new Response('ok');
  };
  try {
    await worker.fetch(new Request('https://admin.neoos.network/https://evil.example/'));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(new URL(url).origin, 'https://admin.neomini.app');
});

test('admin proxy preserves the application OIDC redirect URI for code exchange', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(null, {
      status: 307,
      headers: {
        location:
          'https://auth.example/authorize?redirect_uri=https%3A%2F%2Fadmin.neomini.app%2Fauth%2Fcallback',
      },
    });
  try {
    const response = await worker.fetch(new Request('https://admin.neoos.network/auth/login'));
    assert.equal(
      response.headers.get('location'),
      'https://auth.example/authorize?redirect_uri=https%3A%2F%2Fadmin.neomini.app%2Fauth%2Fcallback'
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('admin proxy preserves two host-only cookies and external redirect parameters exactly', async (t) => {
  const location =
    'https://auth.example/authorize?redirect_uri=https%3A%2F%2Fadmin.neoos.network%2Fauth%2Fcallback&state=admin.neomini.app';
  t.mock.method(globalThis, 'fetch', async (request) => {
    assert.equal(request.redirect, 'manual');
    const headers = new Headers({ location });
    headers.append('set-cookie', '__Host-session=value; Secure; HttpOnly; Path=/');
    headers.append(
      'set-cookie',
      '__Host-transaction=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; Path=/'
    );
    return new Response(null, { status: 303, headers });
  });
  const response = await worker.fetch(new Request('https://admin.neoos.network/auth/callback'));
  assert.equal(response.headers.get('location'), location);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.match(response.headers.getSetCookie()[1], /Expires=Thu, 01 Jan 1970/);
});
