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
    assert.ok(filename, `${name} must be npm-installed and on PATH`);
    return fs.realpathSync(filename);
};

test('real npm services authenticate files/PTY, retry past the PM2 budget, recover, and stop', { timeout: 150000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-services-'));
    const home = path.join(dir, 'home');
    const workspace = path.join(dir, 'workspace');
    const bin = path.join(dir, 'bin');
    for (const folder of [home, workspace, bin]) fs.mkdirSync(folder);
    const env = { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', PM2_HOME: path.join(dir, 'pm2') };
    const pm2Runtime = executablePath('pm2-runtime');
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
    fs.writeFileSync(configFile, JSON.stringify(config));
    fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'file-access-verified');
    const ecosystem = require(path.join(root, 'ecosystem.config.js'));
    for (const app of ecosystem.apps) app.cwd = workspace;
    const cloud = ecosystem.apps.find((app) => app.name === 'cloudcmd');
    cloud.env.IP = '127.0.0.1';
    assert.equal(cloud.env.PORT, '80');
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
    const basic = (password) => ({ Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` });
    let response;
    for (let i = 0; i < 100; i++) {
        assert.equal(child.exitCode, null, 'foreground supervisor must remain alive');
        try { response = await fetch(base, { signal: AbortSignal.timeout(500) }); } catch {}
        if (response) break;
        await delay(100);
    }
    assert.equal(response?.status, 401, 'unauthenticated file UI must reject requests');
    assert.equal((await fetch(base, { headers: basic('incorrect') })).status, 401);
    const authorized = await fetch(base, { headers: basic('admin') });
    assert.equal(authorized.status, 200);
    assert.ok((await authorized.text()).includes('fixture.txt'), 'file UI lists the isolated workspace');
    const fileURL = `${base}/api/v1/fs/fixture.txt`;
    assert.equal((await fetch(fileURL)).status, 401);
    assert.equal((await fetch(fileURL, { headers: basic('incorrect') })).status, 401);
    assert.equal(await (await fetch(fileURL, { headers: basic('admin') })).text(), 'file-access-verified');
    assert.equal((await fetch(`${base}/api/v1/config`, { method: 'PATCH', headers: basic('admin'), body: '{"auth":false}' })).status, 404);

    const socket = async () => {
        const client = io(`${base}/gritty`, { transports: ['websocket'], reconnection: false, timeout: 2000 });
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
    const terminal = await socket();
    const allowed = once(terminal, 'accept');
    terminal.emit('auth', 'admin', config.password);
    await allowed;
    let terminalOutput = '';
    terminal.on('data', (data) => { terminalOutput += data; });
    terminal.emit('terminal', { command: "bash -c 'pwd; printf PTY_VERIFIED > terminal-proof.txt; sleep 10'", autoRestart: false });
    for (let i = 0; !fs.existsSync(path.join(workspace, 'terminal-proof.txt')) && i < 100; i++) await delay(25);
    assert.equal(fs.readFileSync(path.join(workspace, 'terminal-proof.txt'), 'utf8'), 'PTY_VERIFIED');
    assert.ok(terminalOutput.includes(workspace), 'terminal starts in the isolated workspace');
    assert.equal(await (await fetch(`${base}/api/v1/fs/terminal-proof.txt`, { headers: basic('admin') })).text(), 'PTY_VERIFIED');
    terminal.disconnect();

    api = new PM2.custom({ pm2_home: env.PM2_HOME });
    await new Promise((resolve, reject) => api.connect((error) => error ? reject(error) : resolve()));
    const list = () => new Promise((resolve, reject) => api.list((error, apps) => error ? reject(error) : resolve(apps)));
    const attempts = new Set();
    const budget = require(path.join(pm2Root, 'lib/API/schema.json')).max_restarts.docDefault;
    let apps;
    let spynel;
    const deadline = Date.now() + 100000;
    while (Date.now() < deadline) {
        apps = await list();
        assert.equal(apps.length, 2);
        assert.equal(apps.filter((app) => app.name === 'spynel').length, 1);
        spynel = apps.find((app) => app.name === 'spynel');
        assert.equal(spynel.pm2_env.min_uptime, 0);
        assert.equal(spynel.pm2_env.restart_delay, 5000);
        assert.equal(spynel.pm2_env.exec_interpreter, 'none');
        assert.equal(spynel.pm2_env.pm_cwd, workspace);
        assert.notEqual(spynel.pm2_env.status, 'errored');
        attempts.add(spynel.pm2_env.pm_uptime);
        if (spynel.pm2_env.restart_time > budget) break;
        await delay(250);
    }
    assert.ok(spynel.pm2_env.restart_time > budget, 'Spynel must retry beyond the ordinary unstable-start budget');
    const times = [...attempts].sort((a, b) => a - b);
    assert.ok(times.length > budget, 'observe more starts than the default restart budget');
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 4900, 'restarts must be delayed');
    assert.ok(output.includes('not initialized'), 'real uninitialized Spynel failed as expected');
    assert.equal(fs.existsSync(path.join(workspace, '.spynel/config.yaml')), false);

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
    fs.copyFileSync(path.join(root, 'init.d/99-services.sh'), path.join(init, '99-services.sh'));
    // Only the test root changes: never serve the active workspace.
    fs.writeFileSync(path.join(init, '20-test-root.cjs'), `#!/usr/bin/env node
        const fs = require('node:fs');
        const file = require('node:path').join(require('node:os').homedir(), '.cloudcmd.json');
        const config = JSON.parse(fs.readFileSync(file));
        config.root = process.env.TEST_WORKSPACE;
        fs.writeFileSync(file, JSON.stringify(config));`, { mode: 0o755 });
    fs.writeFileSync(isolatedConfig, `module.exports = ${JSON.stringify({ apps: [cloud] })};`);
    const customUsername = 'override"\\雪';
    const customPassword = 'fixture"\n\\雪:$()';
    output = '';
    child = spawn(path.join(root, 'startup.sh'), [init], { env: {
        ...env, HOME: customHome, PM2_HOME: path.join(dir, 'custom-pm2'), PATH: `${bin}:${env.PATH}`,
        REAL_RUNTIME: pm2Runtime, TEST_ECOSYSTEM: isolatedConfig, TEST_WORKSPACE: workspace,
        USERNAME: customUsername, PASSWORD: customPassword, CLOUDCMD_AUTH: 'false',
    } });
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const customExited = once(child, 'exit');
    response = null;
    for (let i = 0; i < 100; i++) {
        try { response = await fetch(base, { signal: AbortSignal.timeout(500) }); } catch {}
        if (response) break;
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
    console.log(`Verified ${times.length} delayed starts past budget ${budget}, native recovery, authenticated port-80 files/PTY, and SIGTERM cleanup.`);
});
