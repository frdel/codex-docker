const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const executablePath = (name) => {
    const filename = process.env.PATH.split(path.delimiter)
        .map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file));
    assert.ok(filename, `${name} must be installed and on PATH`);
    return fs.realpathSync(filename);
};

test('real proxied services authenticate files/PTY, throttle failures, retry, recover, and stop', { timeout: 180000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-services-'));
    const home = path.join(dir, 'home');
    const workspace = path.join(dir, 'workspace');
    const bin = path.join(dir, 'bin');
    for (const folder of [home, workspace, bin]) fs.mkdirSync(folder);
    const env = { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', PM2_HOME: path.join(dir, 'pm2') };
    const pm2Runtime = executablePath('pm2-runtime');
    const haproxyBinary = executablePath('haproxy');
    const pm2Root = path.dirname(path.dirname(pm2Runtime));
    const PM2 = require(pm2Root);
    const { io } = createRequire(executablePath('cloudcmd'))('socket.io-client');
    const clients = [];
    let api;
    let child;
    let output = '';
    t.after(async () => {
        for (const client of clients) client.disconnect();
        if (api) api.disconnect();
        if (child && child.exitCode === null) {
            child.kill('SIGTERM');
            await Promise.race([once(child, 'exit'), delay(12000)]);
            if (child.exitCode === null) child.kill('SIGKILL');
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    assert.equal(spawnSync(path.join(root, 'init.d/10-cloudcmd.cjs'), [], { env }).status, 0);
    const configFile = path.join(home, '.cloudcmd.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    config.root = workspace;
    // Saved public settings must lose to the shared service's private listener.
    config.port = 80;
    config.ip = '0.0.0.0';
    fs.writeFileSync(configFile, JSON.stringify(config));
    fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'file-access-verified');
    const ecosystem = require(path.join(root, 'ecosystem.config.js'));
    for (const app of ecosystem.apps) app.cwd = workspace;
    const cloud = ecosystem.apps.find((app) => app.name === 'cloudcmd');
    assert.deepEqual(cloud.env, { PORT: '8081', IP: '127.0.0.1' });
    const proxy = ecosystem.apps.find((app) => app.name === 'haproxy');
    assert.equal(proxy.script, '/usr/sbin/haproxy');
    assert.deepEqual(proxy.args, ['-db', '-f', '/etc/haproxy/haproxy.cfg']);
    const proxyConfig = path.join(dir, 'haproxy.cfg');
    // Keep tests private; all production rules, ports and policy durations stay unchanged.
    const proxyText = fs.readFileSync(path.join(root, 'haproxy.cfg'), 'utf8')
        .replace('bind :80', 'bind 127.0.0.1:80').replace('bind :::80', 'bind [::1]:80');
    fs.writeFileSync(proxyConfig, proxyText);
    assert.equal(spawnSync(haproxyBinary, ['-c', '-f', path.join(root, 'haproxy.cfg')], { env }).status, 0);
    assert.equal(spawnSync(haproxyBinary, ['-c', '-f', proxyConfig], { env }).status, 0);
    proxy.script = haproxyBinary;
    proxy.args = ['-db', '-f', proxyConfig];
    const isolatedConfig = path.join(dir, 'ecosystem.config.js');
    fs.writeFileSync(isolatedConfig, `module.exports = ${JSON.stringify(ecosystem)};`);
    // Exercise the production final script; redirect only its fixed image config path into the fixture.
    fs.writeFileSync(path.join(bin, 'pm2-runtime'), '#!/bin/bash\nexec "$REAL_RUNTIME" --no-auto-exit "$TEST_ECOSYSTEM"\n', { mode: 0o755 });
    child = spawn(path.join(root, 'init.d/99-services.sh'), [], { env: {
        ...env, PATH: `${bin}:${env.PATH}`, REAL_RUNTIME: pm2Runtime, TEST_ECOSYSTEM: isolatedConfig,
        CLOUDCMD_AUTH: 'false', USERNAME: 'ignored', PASSWORD: 'ignored',
    } });
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const exited = once(child, 'exit');
    const base = 'http://127.0.0.1:80';
    const basic = (password, scheme = 'Basic ') => ({ Authorization: `${scheme}${Buffer.from(`admin:${password}`).toString('base64')}` });
    let response;
    for (let i = 0; i < 100; i++) {
        assert.equal(child.exitCode, null, 'foreground supervisor must remain alive');
        try { response = await fetch(base, { signal: AbortSignal.timeout(500) }); } catch {}
        if (response?.status === 401) break;
        await delay(100);
    }
    assert.equal(response?.status, 401, 'unauthenticated file UI must reject requests');
    const authorized = await fetch(base, { headers: basic('admin') });
    assert.equal(authorized.status, 200);
    assert.ok((await authorized.text()).includes('fixture.txt'), 'file UI lists the isolated workspace');
    const fileURL = `${base}/api/v1/fs/fixture.txt`;
    assert.equal((await fetch(fileURL)).status, 401);
    assert.equal(await (await fetch(fileURL, { headers: basic('admin') })).text(), 'file-access-verified');
    for (const scheme of ['Basic ,', 'Basic\u00a0 ']) {
        assert.equal((await fetch(fileURL, { headers: basic('admin', scheme) })).status, 200, 'upstream decodes alternate credential syntax');
    }
    const uploadURL = `${base}/api/v1/fs/upload.txt`;
    assert.equal((await fetch(uploadURL, { method: 'PUT', headers: basic('admin'), body: 'upload-verified' })).status, 200);
    assert.equal(await (await fetch(uploadURL, { headers: basic('admin') })).text(), 'upload-verified');
    const hostAddress = Object.values(os.networkInterfaces()).flat().find((address) => address.family === 'IPv4' && !address.internal)?.address;
    assert.ok(hostAddress, 'Linux network interface is needed for backend exposure check');
    await assert.rejects(fetch(`http://${hostAddress}:8081`, { signal: AbortSignal.timeout(1000) }));
    assert.equal((await fetch('http://127.0.0.1:8081')).status, 401, 'backend exists only on loopback and retains auth');
    assert.equal((await fetch(`${base}/api/v1/config`, { method: 'PATCH', headers: basic('admin'), body: '{"auth":false}' })).status, 404);

    const socket = async (transports = ['websocket']) => {
        const client = io(`${base}/gritty`, { transports, reconnection: false, timeout: 2000 });
        clients.push(client);
        await Promise.race([once(client, 'connect'), delay(2500).then(() => { throw new Error('terminal connection timed out'); })]);
        return client;
    };
    const unauthenticated = await socket();
    let accepted = false;
    unauthenticated.on('accept', () => { accepted = true; });
    unauthenticated.emit('terminal', { command: "bash -c 'touch unauthorized-terminal'", autoRestart: false });
    await delay(250);
    assert.equal(accepted, false);
    assert.equal(fs.existsSync(path.join(workspace, 'unauthorized-terminal')), false);
    const rejected = once(unauthenticated, 'reject');
    unauthenticated.emit('auth', 'admin', 'incorrect');
    await rejected;
    assert.equal(accepted, false);
    unauthenticated.disconnect();
    const polling = await socket(['polling']);
    const pollingAllowed = once(polling, 'accept');
    polling.emit('auth', 'admin', config.password);
    await pollingAllowed;
    polling.disconnect();
    const terminal = await socket();
    const allowed = once(terminal, 'accept');
    terminal.emit('auth', 'admin', config.password);
    await allowed;
    let terminalOutput = '';
    terminal.on('data', (data) => { terminalOutput += data; });
    terminal.emit('terminal', { command: 'bash', autoRestart: false });
    terminal.emit('data', 'pwd; printf PTY_VERIFIED > terminal-proof.txt; sleep 120\r');
    for (let i = 0; !fs.existsSync(path.join(workspace, 'terminal-proof.txt')) && i < 100; i++) await delay(25);
    assert.equal(fs.readFileSync(path.join(workspace, 'terminal-proof.txt'), 'utf8'), 'PTY_VERIFIED');
    assert.ok(terminalOutput.includes(workspace), 'terminal starts in the isolated workspace');
    assert.equal(await (await fetch(`${base}/api/v1/fs/terminal-proof.txt`, { headers: basic('admin') })).text(), 'PTY_VERIFIED');

    const spoof = (i) => ({
        'X-Forwarded-For': `198.51.100.${i}, 2001:db8::${i}`,
        Forwarded: `for="[2001:db8::${i}]"`, 'X-Real-IP': `203.0.113.${i}`,
        'X-Client-IP': `192.0.2.${i}`,
    });
    for (let i = 1; i <= 8; i++) {
        const challenge = await fetch(base, { headers: spoof(i) });
        assert.equal(challenge.status, 401);
        assert.match(challenge.headers.get('www-authenticate'), /^Basic /);
        assert.equal((await fetch(base, { headers: basic('incorrect', 'Basic  ') })).status, 401, 'upstream does not parse a token after two spaces');
        const logout = await fetch(`${base}/logout`, { headers: { ...basic('incorrect'), ...spoof(i) } });
        assert.equal(logout.status, 401);
        assert.equal(logout.headers.get('www-authenticate'), null);
        assert.equal((await fetch(base, { headers: basic('admin', 'Basic ,') })).status, 200);
    }
    const schemes = ['Basic ', 'Basic ,', 'Basic\u00a0 '];
    for (let i = 1; i <= 5; i++) {
        assert.equal((await fetch(fileURL, { headers: { ...basic('incorrect', schemes[(i - 1) % schemes.length]), ...spoof(i) } })).status, 401);
        if (i < 5) assert.equal((await fetch(fileURL, { headers: basic('admin') })).status, 200);
    }
    const blockedAt = Date.now();
    const blocked = await fetch(base, { headers: { ...basic('admin'), ...spoof(99) } });
    assert.equal(blocked.status, 429, 'ordinary, comma-prefixed, and accepted-whitespace failures share the five-attempt budget');
    assert.equal(blocked.headers.get('retry-after'), '60');
    await assert.rejects(socket(), 'a fresh WebSocket handshake from a blocked peer is rejected');
    const ipv6 = 'http://[::1]:80';
    assert.equal((await fetch(ipv6)).status, 401);
    assert.equal((await fetch(ipv6, { headers: basic('admin') })).status, 200, 'IPv6 has a distinct TCP identity');
    for (let i = 1; i <= 5; i++) assert.equal((await fetch(ipv6, { headers: { ...basic('incorrect', 'Basic ,'), ...spoof(i) } })).status, 401);
    assert.equal((await fetch(ipv6, { headers: basic('admin') })).status, 429, 'IPv6 failures cannot bypass the table');

    api = new PM2.custom({ pm2_home: env.PM2_HOME });
    await new Promise((resolve, reject) => api.connect((error) => error ? reject(error) : resolve()));
    const list = () => new Promise((resolve, reject) => api.list((error, apps) => error ? reject(error) : resolve(apps)));
    const attempts = new Set();
    const budget = require(path.join(pm2Root, 'lib/API/schema.json')).max_restarts.docDefault;
    let apps;
    let spynel;
    const deadline = performance.now() + 110000;
    while (performance.now() < deadline) {
        apps = await list();
        assert.equal(apps.length, 3);
        assert.equal(apps.filter((app) => app.name === 'spynel').length, 1);
        spynel = apps.find((app) => app.name === 'spynel');
        assert.equal(spynel.pm2_env.min_uptime, 0);
        assert.equal(spynel.pm2_env.restart_delay, 5000);
        assert.equal(spynel.pm2_env.exec_interpreter, 'none');
        assert.equal(spynel.pm2_env.pm_cwd, workspace);
        assert.notEqual(spynel.pm2_env.status, 'errored');
        attempts.add(spynel.pm2_env.pm_uptime);
        if (Date.now() - blockedAt < 59000) {
            assert.equal((await fetch(base, { headers: { ...basic('incorrect'), ...spoof(100) } })).status, 429);
        }
        if (spynel.pm2_env.restart_time > budget) break;
        await delay(250);
    }
    assert.ok(spynel.pm2_env.restart_time > budget, `Spynel must retry beyond budget ${budget}; observed ${spynel.pm2_env.restart_time} restarts`);
    const times = [...attempts].sort((a, b) => a - b);
    assert.ok(times.length > budget, 'observe more starts than the default restart budget');
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 4900, 'restarts must be delayed');
    assert.ok(output.includes('not initialized'), 'real uninitialized Spynel failed as expected');
    assert.equal(fs.existsSync(path.join(workspace, '.spynel/config.yaml')), false);
    assert.ok(Date.now() - blockedAt >= 61000, 'observe the production sixty-second block');
    assert.equal((await fetch(base, { headers: basic('admin') })).status, 200, 'requests during a block do not extend it');
    assert.equal((await fetch(ipv6, { headers: basic('admin') })).status, 200, 'IPv6 block expires too');
    assert.equal((await fetch(base, { headers: basic('incorrect') })).status, 401, 'expired window starts a new failure budget');
    assert.equal((await fetch(base, { headers: basic('admin') })).status, 200);
    assert.equal(terminal.connected, true, 'an existing terminal survives the block and ordinary HTTP timeouts');
    terminal.emit('data', '\u0003');
    await delay(100);
    terminal.emit('data', "printf 'LONG_%s_PTY\\n' LIVED\r");
    for (let i = 0; !terminalOutput.includes('LONG_LIVED_PTY') && i < 100; i++) await delay(25);
    assert.ok(terminalOutput.includes('LONG_LIVED_PTY'), 'terminal still transports data after the block');
    terminal.disconnect();

    const proxyApp = apps.find((app) => app.name === 'haproxy');
    const rss = fs.readFileSync(`/proc/${proxyApp.pid}/status`, 'utf8').match(/^VmRSS:\s+(.*)$/m)?.[1];
    console.log(`Isolated HAProxy resident memory after HTTP/socket checks: ${rss}.`);
    const cloudApp = apps.find((app) => app.name === 'cloudcmd');
    process.kill(cloudApp.pid, 'SIGKILL');
    await delay(100);
    assert.equal((await fetch(base)).status, 503, 'backend failure never bypasses the proxy');
    const cloudDeadline = Date.now() + 10000;
    while (Date.now() < cloudDeadline) {
        if ((await fetch(base)).status === 401) break;
        await delay(200);
    }
    assert.equal((await fetch(base)).status, 401, 'Cloud Commander recovers independently');
    // Invalid protection after a crash keeps the public listener closed until repaired.
    fs.writeFileSync(proxyConfig, 'invalid protection configuration\n');
    process.kill(proxyApp.pid, 'SIGKILL');
    await delay(5500);
    await assert.rejects(fetch(base, { signal: AbortSignal.timeout(1000) }));
    apps = await list();
    const failedProxy = apps.find((app) => app.name === 'haproxy');
    assert.equal(failedProxy.pm2_env.restart_delay, 5000);
    assert.equal(failedProxy.pm2_env.min_uptime, 0);
    assert.notEqual(failedProxy.pm2_env.status, 'errored');
    assert.ok(failedProxy.pm2_env.restart_time > 0);
    assert.equal((await fetch('http://127.0.0.1:8081')).status, 401);
    fs.writeFileSync(proxyConfig, proxyText);
    const proxyDeadline = Date.now() + 10000;
    while (Date.now() < proxyDeadline) {
        try { if ((await fetch(base)).status === 401) break; } catch {}
        await delay(200);
    }
    assert.equal((await fetch(base)).status, 401, 'HAProxy retries and recovers after config repair');

    const initialized = spawnSync(executablePath('spynel'), ['init', '--dir', workspace, '--no-start'], { env, encoding: 'utf8' });
    assert.equal(initialized.status, 0, 'isolated explicit workspace initialization succeeds');
    const recoveryDeadline = Date.now() + 15000;
    let serving = false;
    while (Date.now() < recoveryDeadline) {
        apps = await list();
        spynel = apps.find((app) => app.name === 'spynel');
        serving = spynel.pm2_env.status === 'online' && Date.now() - spynel.pm2_env.pm_uptime > 1500;
        if (serving) break;
        await delay(200);
    }
    assert.equal(serving, true, 'PM2 automatically recovers after initialization');
    const status = spawnSync(executablePath('spynel'), ['status'], { cwd: workspace, env, encoding: 'utf8' });
    assert.equal(status.status, 0, 'recovered service responds to the native status command');
    const pids = apps.map((app) => app.pid);
    const nativePids = fs.readFileSync(`/proc/${spynel.pid}/task/${spynel.pid}/children`, 'utf8')
        .trim().split(/\s+/).filter(Boolean).map(Number);
    assert.ok(nativePids.length, 'npm Spynel launcher owns a native child');
    for (const pid of pids) {
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        assert.equal(argv.includes('admin'), false, 'credentials must not appear in process arguments');
    }
    assert.equal(output.includes(config.password), false, 'password hash must not appear in logs');
    api.disconnect();
    api = null;
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null]);
    for (const pid of [...pids, ...nativePids]) assert.equal(fs.existsSync(`/proc/${pid}`), false, 'PM2 stops managed processes and the native child');
    await assert.rejects(fetch(base, { signal: AbortSignal.timeout(1000) }));

    const customHome = path.join(dir, 'custom-home');
    const init = path.join(dir, 'init');
    fs.mkdirSync(customHome);
    fs.mkdirSync(init);
    fs.copyFileSync(path.join(root, 'init.d/10-cloudcmd.cjs'), path.join(init, '10-cloudcmd.cjs'));
    fs.copyFileSync(path.join(root, 'init.d/20-haproxy.sh'), path.join(init, '20-haproxy.sh'));
    fs.copyFileSync(path.join(root, 'init.d/99-services.sh'), path.join(init, '99-services.sh'));
    // Only the test root changes: never serve the active workspace.
    fs.writeFileSync(path.join(init, '20-test-root.cjs'), `#!/usr/bin/env node
        const fs = require('node:fs');
        const file = require('node:path').join(require('node:os').homedir(), '.cloudcmd.json');
        const config = JSON.parse(fs.readFileSync(file));
        config.root = process.env.TEST_WORKSPACE;
        fs.writeFileSync(file, JSON.stringify(config));`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'haproxy'), '#!/bin/bash\nexec "$REAL_HAPROXY" -c -f "$TEST_PROXY_CONFIG"\n', { mode: 0o755 });
    fs.writeFileSync(isolatedConfig, `module.exports = ${JSON.stringify({ apps: [cloud, proxy] })};`);
    const customUsername = 'override"\\雪';
    const customPassword = 'fixture"\n\\雪:$()';
    output = '';
    child = spawn(path.join(root, 'startup.sh'), [init], { env: {
        ...env, HOME: customHome, PM2_HOME: path.join(dir, 'custom-pm2'), PATH: `${bin}:${env.PATH}`,
        REAL_RUNTIME: pm2Runtime, TEST_ECOSYSTEM: isolatedConfig, TEST_WORKSPACE: workspace,
        REAL_HAPROXY: haproxyBinary, TEST_PROXY_CONFIG: proxyConfig,
        USERNAME: customUsername, PASSWORD: customPassword, CLOUDCMD_AUTH: 'false',
    } });
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const customExited = once(child, 'exit');
    response = null;
    for (let i = 0; i < 100; i++) {
        try { response = await fetch(base, { signal: AbortSignal.timeout(500) }); } catch {}
        if (response?.status === 401) break;
        await delay(100);
    }
    assert.equal(response?.status, 401, 'ENV cannot disable initialized auth');
    assert.equal((await fetch(base, { headers: basic('admin') })).status, 401, 'old defaults are rejected after an ENV override');
    const customAuth = { Authorization: `Basic ${Buffer.from(`${customUsername}:${customPassword}`).toString('base64')}` };
    assert.equal((await fetch(base, { headers: customAuth })).status, 200, 'arbitrary-character first-launch credentials work upstream');
    const customConfig = JSON.parse(fs.readFileSync(path.join(customHome, '.cloudcmd.json')));
    const customTerminal = await socket();
    const customAllowed = once(customTerminal, 'accept');
    customTerminal.emit('auth', customUsername, customConfig.password);
    await customAllowed;
    customTerminal.disconnect();
    assert.equal(output.includes(customPassword) || output.includes(customConfig.password), false);
    child.kill('SIGTERM');
    assert.deepEqual(await customExited, [0, null]);
    console.log(`Verified ${times.length} delayed starts past budget ${budget}, proxy/Cloud Commander recovery, HTTP blocking/expiry, authenticated files/PTY, and SIGTERM cleanup.`);
});
