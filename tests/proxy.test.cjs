const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('native HAProxy rewrites peer headers, isolates identities, and resets failure windows', { timeout: 15000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-'));
    let backendRequests = 0;
    const backend = http.createServer((req, res) => {
        backendRequests++;
        if (req.url === '/rejected') {
            res.setHeader('WWW-Authenticate', 'Basic realm="fixture"');
            res.statusCode = 401;
        } else if (req.url === '/logout') {
            res.statusCode = 401;
        }
        res.end(JSON.stringify({
            forwardedFor: req.headers['x-forwarded-for'],
            forwarded: req.headers.forwarded,
            realIP: req.headers['x-real-ip'],
            clientIP: req.headers['x-client-ip'],
            host: req.headers['x-forwarded-host'],
            proto: req.headers['x-forwarded-proto'],
        }));
    });
    let proxy;
    t.after(async () => {
        if (proxy && proxy.exitCode === null) {
            const exited = once(proxy, 'exit');
            proxy.kill('SIGINT');
            await exited;
        }
        backend.closeAllConnections();
        await new Promise((resolve) => backend.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    const reservation = net.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const config = path.join(dir, 'haproxy.cfg');
    // Only ports and durations change; the real service test exercises sixty seconds.
    fs.writeFileSync(config, fs.readFileSync(path.join(root, 'haproxy.cfg'), 'utf8')
        .replace('bind :80', `bind 127.0.0.1:${port}`)
        .replace('    bind :::80 v6only\n', '')
        .replace('127.0.0.1:8081', `127.0.0.1:${backend.address().port}`)
        .replaceAll('date(60)', 'date(2)'));
    assert.equal(spawnSync('haproxy', ['-c', '-f', config]).status, 0);
    const invalid = path.join(dir, 'invalid.cfg');
    fs.writeFileSync(invalid, 'invalid protection configuration\n');
    assert.notEqual(spawnSync('haproxy', ['-c', '-f', invalid]).status, 0);
    proxy = spawn('haproxy', ['-db', '-f', config], { stdio: 'ignore' });
    const request = (url, headers = {}, localAddress = '127.0.0.1') => new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: url, headers, localAddress, agent: false }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => req.destroy(new Error('fixture request timed out')));
    });
    let ready;
    for (let i = 0; i < 50; i++) {
        try { ready = await request('/ok'); } catch {}
        if (ready) break;
        await delay(20);
    }
    assert.equal(ready?.status, 200);
    const forged = {
        'X-Forwarded-For': ['198.51.100.1', '2001:db8::1'],
        Forwarded: 'for="[2001:db8::1]"', 'X-Real-IP': '203.0.113.1',
        'X-Client-IP': '192.0.2.1', 'X-Forwarded-Host': 'forged.invalid',
        'X-Forwarded-Proto': 'https',
    };
    assert.deepEqual(JSON.parse((await request('/ok', forged)).body), { forwardedFor: '127.0.0.1' });
    const credentials = { Authorization: 'bAsIc Zml4dHVyZTppbmNvcnJlY3Q=' };
    for (let i = 0; i < 6; i++) {
        assert.equal((await request('/rejected')).status, 401);
        assert.equal((await request('/rejected', { Authorization: ['Digest fixture', credentials.Authorization] })).status, 401);
        assert.equal((await request('/logout', credentials)).status, 401);
        assert.equal((await request('/ok', credentials)).status, 200);
    }
    for (let i = 0; i < 4; i++) assert.equal((await request('/rejected', credentials)).status, 401);
    await delay(2200);
    for (let i = 0; i < 4; i++) assert.equal((await request('/rejected', credentials)).status, 401);
    assert.equal((await request('/ok')).status, 200, 'failures from the expired window are cleared');
    assert.equal((await request('/rejected', { ...forged, Authorization: [credentials.Authorization, 'Digest fixture'] })).status, 401);
    const beforeBlock = backendRequests;
    assert.equal((await request('/ok', forged)).status, 429);
    assert.equal(backendRequests, beforeBlock, 'blocked requests never reach the backend');
    const otherPeer = await request('/ok', forged, '127.0.0.2');
    assert.equal(otherPeer.status, 200);
    assert.deepEqual(JSON.parse(otherPeer.body), { forwardedFor: '127.0.0.2' });
});
