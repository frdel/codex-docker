const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const runner = path.join(root, 'startup.sh');
const initializer = path.join(root, 'init.d/10-cloudcmd.cjs');
const proxyInitializer = path.join(root, 'init.d/20-haproxy.sh');
const finalScript = path.join(root, 'init.d/99-services.sh');
const hash = (value) => createHash('sha512').update(value).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-startup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function executable(filename, text) {
    fs.writeFileSync(filename, text, { mode: 0o755 });
}
function environment(home) {
    return { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color' };
}

test('runner orders executable files, skips other entries, and stops on failure/empty directory', (t) => {
    const dir = temp(t);
    const output = path.join(dir, '.order');
    const env = { ...environment(dir), OUTPUT: output, LC_ALL: 'C.UTF-8' };
    for (const name of ['20-b.sh', '10-A.sh', '99-end.sh']) {
        executable(path.join(dir, name), `#!/bin/bash\nprintf '%s:%s\\n' '${name}' "$LC_ALL" >> "$OUTPUT"\n`);
    }
    executable(path.join(dir, '.hidden'), '#!/bin/bash\nexit 50\n');
    fs.mkdirSync(path.join(dir, '15-directory'));
    fs.writeFileSync(path.join(dir, '05-not-executable'), 'ignored');
    assert.equal(spawnSync(runner, [dir], { env }).status, 0);
    assert.equal(fs.readFileSync(output, 'utf8'), '10-A.sh:C\n20-b.sh:C\n99-end.sh:C\n');
    fs.writeFileSync(output, '');
    executable(path.join(dir, '15-fail.sh'), '#!/bin/bash\nexit 23\n');
    assert.equal(spawnSync(runner, [dir], { env }).status, 23);
    assert.equal(fs.readFileSync(output, 'utf8'), '10-A.sh:C\n');
    assert.equal(spawnSync(runner, [temp(t)], { env }).status, 1);
});

test('runner initializes credentials, clears ENV, execs the foreground holder, and delivers SIGTERM', async (t) => {
    const dir = temp(t);
    const init = path.join(dir, 'init');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(init);
    fs.mkdirSync(bin);
    fs.copyFileSync(initializer, path.join(init, '10-cloudcmd.cjs'));
    fs.copyFileSync(proxyInitializer, path.join(init, '20-haproxy.sh'));
    fs.copyFileSync(finalScript, path.join(init, '99-services.sh'));
    executable(path.join(bin, 'gritty'), '#!/bin/bash\nprintf /fixture/gritty\n');
    executable(path.join(bin, 'haproxy'), '#!/bin/bash\n[[ "$*" == "-c -f /etc/haproxy/haproxy.cfg" ]]\n');
    const holder = path.join(dir, 'holder.cjs');
    fs.writeFileSync(holder, `const fs = require('node:fs');
        if (['USERNAME', 'PASSWORD', 'CLOUDCMD_USERNAME', 'CLOUDCMD_PASSWORD', 'cloudcmd_auth']
            .some((name) => name in process.env)) process.exit(42);
        const config = JSON.parse(fs.readFileSync(require('node:path').join(process.env.HOME, '.cloudcmd.json')));
        if (config.username !== 'fixture' || config.password !== '${hash('fixture')}') process.exit(44);
        if (process.argv.slice(2).join(' ') !== '--no-auto-exit /usr/local/lib/codex-docker/ecosystem.config.js') process.exit(43);
        fs.writeFileSync(process.env.PID_FILE, String(process.pid));
        process.on('SIGTERM', () => { fs.writeFileSync(process.env.SIGNAL_FILE, 'SIGTERM'); process.exit(0); });
        setInterval(() => {}, 1000);`);
    executable(path.join(bin, 'pm2-runtime'), '#!/bin/bash\nexec node "$HOLDER" "$@"\n');
    const pidFile = path.join(dir, 'pid');
    const signalFile = path.join(dir, 'signal');
    const child = spawn(runner, [init], { env: {
        ...environment(dir), PATH: `${bin}:${process.env.PATH}`, HOLDER: holder,
        PID_FILE: pidFile, SIGNAL_FILE: signalFile, USERNAME: 'fixture', PASSWORD: 'fixture',
        CLOUDCMD_USERNAME: 'native', CLOUDCMD_PASSWORD: 'native', cloudcmd_auth: 'false',
    } });
    const exited = once(child, 'exit');
    t.after(() => child.kill('SIGKILL'));
    for (let i = 0; !fs.existsSync(pidFile) && i < 100; i++) await delay(20);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), String(child.pid));
    child.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null]);
    assert.equal(fs.readFileSync(signalFile, 'utf8'), 'SIGTERM');
});

test('config uses public defaults, safely encodes overrides, preserves settings, and fails closed', (t) => {
    const dir = temp(t);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    executable(path.join(bin, 'gritty'), '#!/bin/bash\nprintf /fixture/gritty\n');
    const run = (home, values = {}) => spawnSync(initializer, [], { env: {
        ...environment(home), PATH: `${bin}:${process.env.PATH}`, ...values,
    }, encoding: 'utf8' });
    const home = temp(t);
    const filename = path.join(home, '.cloudcmd.json');
    assert.equal(run(home).status, 0);
    let config = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(config.username, 'admin');
    assert.equal(config.password, hash('admin'));
    assert.equal(config.auth, true);
    assert.equal(config.port, 8081);
    assert.equal(config.ip, '127.0.0.1');
    assert.equal(config.root, '/workspace');
    assert.equal(config.terminal, true);
    assert.equal(config.configDialog, false);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    const retiredHome = temp(t);
    assert.equal(run(retiredHome, { CLOUDCMD_USERNAME: 'retired', CLOUDCMD_PASSWORD: 'retired' }).status, 0);
    const retiredConfig = JSON.parse(fs.readFileSync(path.join(retiredHome, '.cloudcmd.json'), 'utf8'));
    assert.equal(retiredConfig.username, 'admin');
    assert.equal(retiredConfig.password, hash('admin'));
    const customHome = temp(t);
    const customFile = path.join(customHome, '.cloudcmd.json');
    const username = 'user "\\\n雪';
    const password = 'test "\\\n雪:$()';
    const result = run(customHome, { USERNAME: username, PASSWORD: password });
    assert.equal(result.status, 0);
    assert.equal(result.stdout + result.stderr, '');
    config = JSON.parse(fs.readFileSync(customFile, 'utf8'));
    assert.equal(config.username, username);
    assert.equal(config.password, hash(password));
    config.theme = 'dark';
    fs.writeFileSync(customFile, JSON.stringify(config));
    fs.chmodSync(customFile, 0o644);
    const original = fs.readFileSync(customFile);
    assert.equal(run(customHome, { USERNAME: 'ignored', PASSWORD: '' }).status, 0);
    assert.deepEqual(fs.readFileSync(customFile), original);
    assert.equal(fs.statSync(customFile).mode & 0o777, 0o600);
    for (const values of [{ USERNAME: '' }, { PASSWORD: '' }, { USERNAME: 'a:b' }]) {
        const emptyHome = temp(t);
        assert.equal(run(emptyHome, values).status, 1);
        assert.equal(fs.existsSync(path.join(emptyHome, '.cloudcmd.json')), false);
    }
    for (const data of ['{ secret fixture malformed', 'null', '{}', JSON.stringify({ ...config, auth: false }),
        JSON.stringify({ ...config, password: '' }), JSON.stringify({ ...config, algo: 'invalid' })]) {
        fs.writeFileSync(customFile, data);
        const bad = run(customHome);
        assert.equal(bad.status, 1);
        assert.equal(bad.stdout, '');
        assert.match(bad.stderr, /^Cloud Commander configuration could not be securely/);
        assert.equal(bad.stderr.includes('fixture'), false);
        assert.equal(fs.readFileSync(customFile, 'utf8'), data);
    }
});

test('invalid HAProxy config stops ordered startup before the foreground holder', (t) => {
    const dir = temp(t);
    const bin = path.join(dir, 'bin');
    const init = path.join(dir, 'init');
    fs.mkdirSync(bin);
    fs.mkdirSync(init);
    fs.copyFileSync(proxyInitializer, path.join(init, '20-haproxy.sh'));
    fs.copyFileSync(finalScript, path.join(init, '99-services.sh'));
    executable(path.join(bin, 'haproxy'), '#!/bin/bash\nexit 23\n');
    executable(path.join(bin, 'pm2-runtime'), '#!/bin/bash\ntouch "$HOME/started"\n');
    assert.equal(spawnSync(runner, [init], { env: {
        ...environment(dir), PATH: `${bin}:${process.env.PATH}`,
    } }).status, 23);
    assert.equal(fs.existsSync(path.join(dir, 'started')), false);
});
