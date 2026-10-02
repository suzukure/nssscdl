'use strict';
// #661 fixture / #691 explicit metadata bridge inside RootDirectory. No HTTP forwarding.
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const assert = require('node:assert/strict');
const host = 'registry.npmjs.org';

function metadataPath(name) {
  // HTTP route boundary only; manifest/source policy remains #645's validator.
  assert(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name));
  return '/' + name.replace('/', '%2f');
}

function metadata(proxyPort, name) {
  assert(Number.isInteger(proxyPort) && proxyPort >= 1024 && proxyPort <= 65535);
  const path = name === undefined ? '/is-number/7.0.0' : metadataPath(name);
  return new Promise((resolve, reject) => {
    let socket, upstream, agent;
    const fail = () => reject(new Error('official-registry-unavailable'));
    const tunnel = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT',
      path: host + ':443', headers: { Host: host + ':443' }, agent: false });
    const deadline = setTimeout(() => { tunnel.destroy(); socket?.destroy(); upstream?.destroy(); fail(); }, 5000);
    function finish(error, value) {
      clearTimeout(deadline);
      tunnel.destroy(); upstream?.destroy(); socket?.destroy(); agent?.destroy();
      if (error) fail(); else resolve(value);
    }
    tunnel.on('error', () => finish(true));
    tunnel.on('connect', (response, connected, head) => {
      socket = connected;
      if (response.statusCode !== 200 || head.length !== 0) return finish(true);
      agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
      // No DNS or direct-connect path: TLS uses only the established proxy socket.
      agent.createConnection = () => tls.connect({ socket, servername: host, rejectUnauthorized: true });
      upstream = https.get({ hostname: host, path, agent,
        headers: { Accept: name === undefined ? 'application/json' : 'application/vnd.npm.install-v1+json',
          'Accept-Encoding': 'identity' } }, result => {
        if (result.statusCode !== 200) return finish(true); // No redirects/retries.
        let size = 0;
        const chunks = [];
        result.on('data', chunk => {
          size += chunk.length;
          if (size > 65536) finish(true); else chunks.push(chunk);
        });
        result.on('error', () => finish(true));
        result.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            assert.equal(value.name, name === undefined ? 'is-number' : name);
            if (name === undefined) assert.equal(value.version, '7.0.0');
            else assert(value.versions && typeof value.versions === 'object' && !Array.isArray(value.versions));
            finish(false, value);
          } catch { finish(true); }
        });
      });
      upstream.on('error', () => finish(true));
    });
    tunnel.end();
  });
}

function handler(value, counts) {
  const body = JSON.stringify({ name: 'is-number', 'dist-tags': { latest: '7.0.0' },
    versions: { '7.0.0': value } });
  return (request, response) => {
    if (request.method !== 'GET' || request.url !== '/is-number') {
      counts.denied++; response.writeHead(403); response.end(); return;
    }
    counts.metadata++;
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  };
}

function metadataHandler(port, values, counts) {
  return async (request, response) => {
    let name;
    try {
      assert.equal(request.method, 'GET');
      name = decodeURIComponent(request.url.slice(1));
      assert.equal(request.url.toLowerCase(), metadataPath(name));
    } catch {
      counts.denied++; response.writeHead(403); response.end(); return;
    }
    try {
      // Run-local metadata only. Content paths, URLs, query and traversal fail above.
      const value = values.get(name) || await metadata(port, name);
      values.set(name, value);
      const body = JSON.stringify(value);
      counts.metadata++;
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    } catch {
      counts.denied++; response.writeHead(502); response.end();
    }
  };
}

async function serve(port, dependencies) {
  const values = new Map();
  let value;
  if (dependencies === undefined) value = await metadata(port);
  else {
    // Resolve readiness before npm starts. No persistent cache or fallback.
    assert(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies));
    for (const [name, version] of Object.entries(dependencies)) {
      const record = await metadata(port, name);
      assert(record.versions[version]?.name === name && record.versions[version]?.version === version);
      values.set(name, record);
    }
  }
  const counts = { metadata: 0, denied: 0 };
  const server = http.createServer(dependencies === undefined ? handler(value, counts) :
    metadataHandler(port, values, counts));
  server.requestTimeout = 3000; server.headersTimeout = 3000;
  server.on('error', () => process.exit(1));
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  process.once('message', message => {
    if (message !== 'stop') return process.exit(1);
    server.close(() => { process.send(counts, () => process.disconnect()); });
    server.closeAllConnections();
  });
  process.once('disconnect', () => { server.closeAllConnections(); server.close(); });
}
module.exports = { metadata, handler, metadataPath, metadataHandler, serve };
if (require.main === module) serve(Number(process.argv[2]),
  process.argv[3] === undefined ? undefined : JSON.parse(process.argv[3])).catch(() => {
  console.error('official-registry-unavailable'); process.exitCode = 1;
  if (process.connected) process.disconnect();
});
