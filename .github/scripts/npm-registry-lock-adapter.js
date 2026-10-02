'use strict';
// #661 fixed metadata bridge, inside RootDirectory. No general HTTP forwarding.
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const assert = require('node:assert/strict');
const host = 'registry.npmjs.org';

function metadata(proxyPort) {
  assert(Number.isInteger(proxyPort) && proxyPort >= 1024 && proxyPort <= 65535);
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
      upstream = https.get({ hostname: host, path: '/is-number/7.0.0', agent,
        headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' } }, result => {
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
            assert.equal(value.name, 'is-number'); assert.equal(value.version, '7.0.0');
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

async function serve(port) {
  const value = await metadata(port);
  const counts = { metadata: 0, denied: 0 };
  const server = http.createServer(handler(value, counts));
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
module.exports = { metadata, handler, serve };
if (require.main === module) serve(Number(process.argv[2])).catch(() => {
  console.error('official-registry-unavailable'); process.exitCode = 1;
  if (process.connected) process.disconnect();
});
