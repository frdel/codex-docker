module.exports = {
    apps: [
        {
            name: 'spynel',
            script: 'spynel',
            args: ['serve'],
            interpreter: 'none',
            cwd: '/workspace',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            restart_delay: 5000,
            // '0s' disables the unstable-start budget; PM2 discards numeric 0.
            min_uptime: '0s',
            kill_timeout: 10000,
        },
        {
            name: 'cloudcmd',
            script: 'cloudcmd',
            interpreter: 'none',
            cwd: '/workspace',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            restart_delay: 5000,
            min_uptime: '0s',
            kill_timeout: 10000,
            env: { PORT: '80', IP: '0.0.0.0' },
        },
    ],
};
