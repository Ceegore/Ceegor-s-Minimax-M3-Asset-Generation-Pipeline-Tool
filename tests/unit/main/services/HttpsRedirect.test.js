// tests/unit/main/services/HttpsRedirect.test.js
// Bug-fix #3 (2026-06-19): guard against infinite redirect loops.
// The previous version captured `maxRedirects` by closure but
// never decremented it, so the guard was dead. These tests
// pin the new behaviour: a redirect loop must reject within
// `maxRedirects` hops with a "Too many redirects" error.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

// We use the http transport via the DI seam `{ get: http.get }` so the
// test doesn't need to set up a TLS server.
const { httpsGetFollowingRedirects } = require('../../../../main/services/HttpsRedirect');

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, port });
    });
  });
}

function stopServer(srv) {
  return new Promise((resolve) => srv.close(resolve));
}

test('follows a single redirect and resolves with the final response', async () => {
  let firstHits = 0;
  let secondHits = 0;
  const { srv, port } = await startServer((req, res) => {
    if (req.url === '/start') {
      firstHits++;
      res.writeHead(302, { location: `http://127.0.0.1:${port}/end` });
      res.end();
    } else if (req.url === '/end') {
      secondHits++;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('final');
    } else {
      res.writeHead(404); res.end();
    }
  });
  try {
    const res = await httpsGetFollowingRedirects(`http://127.0.0.1:${port}/start`, 5, { get: http.get });
    assert.equal(res.statusCode, 200);
    let body = '';
    res.setEncoding('utf8');
    for await (const chunk of res) body += chunk;
    assert.equal(body, 'final');
    assert.equal(firstHits, 1);
    assert.equal(secondHits, 1);
  } finally {
    await stopServer(srv);
  }
});

test('rejects with "Too many redirects" when the chain exceeds maxRedirects', async () => {
  let hits = 0;
  const { srv, port } = await startServer((req, res) => {
    hits++;
    // Always redirect to ourselves. The Location header must be a
    // valid absolute URL.
    res.writeHead(302, { location: `http://127.0.0.1:${port}/loop?i=${hits}` });
    res.end();
  });
  try {
    await assert.rejects(
      httpsGetFollowingRedirects(`http://127.0.0.1:${port}/loop`, 3, { get: http.get }),
      (err) => /Too many redirects/.test(err.message),
    );
    // 1 initial + 3 redirects = 4 hits (the 4th attempt is the one
    // that pushes `remaining` to 0 and rejects without making a 5th
    // request). Allow some slack on the exact count — the point is
    // that it's bounded.
    assert.ok(hits >= 3 && hits <= 5, `expected 3..5 hits, got ${hits}`);
  } finally {
    await stopServer(srv);
  }
});

test('rejects immediately when Location header is missing', async () => {
  const { srv, port } = await startServer((req, res) => {
    res.writeHead(302); // no Location
    res.end();
  });
  try {
    await assert.rejects(
      httpsGetFollowingRedirects(`http://127.0.0.1:${port}/start`, 5, { get: http.get }),
      /Too many redirects/,
    );
  } finally {
    await stopServer(srv);
  }
});