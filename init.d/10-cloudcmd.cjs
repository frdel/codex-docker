#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { homedir } = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

try {
    const filename = path.join(homedir(), '.cloudcmd.json');
    let config;
    try {
        config = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const username = process.env.USERNAME ?? 'admin';
        const password = process.env.PASSWORD ?? 'admin';
        if (!username || username.includes(':') || !password) throw new Error();
        config = {
            auth: true,
            username,
            password: createHash('sha512').update(password).digest('hex'),
            algo: 'sha512',
            port: 80,
            root: '/workspace',
            open: false,
            terminal: true,
            terminalPath: execFileSync('gritty', ['--path'], { encoding: 'utf8' }).trim(),
            terminalCommand: 'bash',
            configDialog: false,
            log: false,
        };
        fs.writeFileSync(filename, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }

    const hashLength = createHash(config.algo ?? 'sha512WithRSAEncryption').digest('hex').length;
    if (config.auth !== true || typeof config.username !== 'string' || !config.username ||
        config.username.includes(':') || typeof config.password !== 'string' ||
        !new RegExp(`^[a-f0-9]{${hashLength}}$`, 'i').test(config.password)) throw new Error();
    fs.chmodSync(filename, 0o600);
} catch {
    console.error('Cloud Commander configuration could not be securely initialized or validated; refusing to start.');
    process.exit(1);
}
