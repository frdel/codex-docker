# Codex Docker

A Debian bookworm image with Node.js 22, Git, Bubblewrap, npm-installed Codex,
PM2, Spynel, Cloud Commander and Gritty. Interactive Bash retains its terminal
color settings and the full-access Codex alias.

## Usage

```sh
docker build -t codex .
docker run -d --name codex --restart unless-stopped --stop-timeout 30 \
  -p 127.0.0.1:8080:80 \
  -v "$PWD:/workspace" -v codex-home:/root codex
docker exec -it codex bash
```

Inside the container, run `codex` to start Codex with full workspace access.
Open <http://127.0.0.1:8080> for Cloud Commander. Its intentionally public demo
username and password are **admin / admin**. These grant filesystem access and
a shell as the container's root user. Keep this host publication on loopback;
choose private credentials before explicitly publishing to another interface.
Authentication uses HTTP Basic and the upstream terminal protocol, without TLS.

`EXPOSE 80` documents the container port; `-p` actually publishes it. Cloud
Commander binds container port 80 on all container interfaces. Other exposed
ports are retained from the original image and are not published by this example.

Spynel runs `spynel serve` from `/workspace`. If the workspace is not initialized,
the error is expected: PM2 retries every five seconds without creating or
overwriting `.spynel/config.yaml`. Initialize deliberately when ready:

```sh
docker exec -it codex spynel init --dir /workspace --no-start
docker logs --tail 50 codex
```

The next retry picks up the initialized workspace. PM2 starts one Spynel instance
in fork mode with `interpreter: 'none'`, so the npm launcher/native binary is not
mistaken for a Node script. `min_uptime: '0s'` disables counting unstable starts;
numeric zero is discarded by PM2 7.0.4's configuration parser. This removes the
unstable-restart cutoff, independently of the five-second retry delay.
`pm2-runtime --no-auto-exit` stays in the foreground even while services fail.
PM2 retries only while this supervisor is alive; Docker's host restart policy
handles container exits/host restarts, and cannot recover a stopped host itself.

These changes take effect in newly built/recreated containers. Editing this repo
does not update, replace or restart an existing container. Preserve mounted data
when you deliberately recreate one.

## Initialization order

The image's `/usr/local/bin/codex-startup` reads `/etc/codex-init.d` in alphabetical
order with `LC_ALL=C`. It runs non-hidden executable regular files (including
symlinks to such files), regardless of extension, using their shebangs. It ignores
subdirectories and non-executable files. A nonzero exit stops startup immediately;
an empty selection exits with an error. Scripts run separately, so exported shell
variables do not carry into subsequent scripts.

The defaults are:

- `10-cloudcmd.cjs`: create or validate Cloud Commander's private configuration.
- `99-services.sh`: remove first-launch Cloud Commander ENV overrides and **exec**
  the foreground PM2 runtime with the single image process declaration.

The runner **execs the last selected script**; that script must exec its foreground
process. Earlier scripts must finish before services start. There is no tail or
detached supervisor holding the container open. SIGTERM reaches PM2, which stops
its children with SIGINT and allows up to ten seconds per app before force-kill;
the example gives Docker thirty seconds to stop the container.

Add a script before `99-services.sh`, for example in a derived image:

```dockerfile
FROM codex
COPY --chmod=755 my-init.sh /etc/codex-init.d/20-project.sh
```

Or `chmod +x my-init.sh` on the host and add this option to `docker run`:

```sh
--mount type=bind,src="$PWD/my-init.sh",dst=/etc/codex-init.d/20-project.sh,readonly
```

Mounting a whole directory over `/etc/codex-init.d` replaces the defaults: include
both default scripts or supply your own complete sequence and final foreground
holder. Do not sort extra scripts after the default holder. For isolated checks,
`codex-startup /another/init-directory` selects a different directory.

## Cloud Commander credentials and storage

`USERNAME` and `PASSWORD` override the demo defaults **only when
`/root/.cloudcmd.json` is first created**. Supply them through the environment,
without putting a password in a command argument:

```sh
read -r -p 'Cloud Commander username: ' USERNAME
read -r -s -p 'Cloud Commander password: ' PASSWORD
printf '\n'
export USERNAME PASSWORD
# Add these options to the docker run command above:
#   -e USERNAME -e PASSWORD
unset USERNAME PASSWORD
```

Use a new home volume for a first launch with different credentials. Docker stores
ENV values in container metadata, so keep access to the Docker host private.
Empty first-launch values are rejected. HTTP Basic usernames cannot contain `:`;
other characters are JSON-encoded safely and the password is stored as the upstream
SHA-512 hash, never as plaintext or a process argument. The hash is itself sensitive
because Cloud Commander's terminal uses it for authentication.

The initializer writes the native `~/.cloudcmd.json` with mode `0600`. Existing
configuration content is preserved on subsequent starts, its permissions are
restricted, and `USERNAME`/`PASSWORD` are removed before PM2 starts. Native upstream
`CLOUDCMD_*`/`cloudcmd_*` settings are also removed so they cannot override saved
configuration. Invalid JSON, disabled/missing authentication, empty credentials,
invalid hash format or unsupported hash algorithms abort startup; no unauthenticated
fallback is launched.
The config dialog is disabled initially to prevent accidental auth changes. Edit
the private config deliberately for later settings/credential changes; a password
must be hashed with its configured algorithm. Do not print the config or use
`cloudcmd --show-config` in shared logs.

The `codex-home` volume above retains this configuration and Codex's home state
across container recreation. `/workspace` remains a separate bind mount. Existing
settings and credentials survive ordinary container restarts; deleting the home
volume loses them. PM2 keeps logs on container stdout/stderr.

Gritty is installed through npm and its actual `gritty --path` result is saved as
`terminalPath`; `terminal: true` enables the terminal integration. Cloud Commander
starts file browsing and terminals in `/workspace`. Press **Shift + ~** to open
the terminal. Upstream public static assets/socket handshakes can be downloaded
without login; file operations and terminal session creation require authentication.
This is root-level administration, not a filesystem or shell security sandbox.

## Updates and checks

Infrastructure npm versions are pinned in the Dockerfile to the releases tested
here. Change those pins and rebuild/recreate to update the image. The canonical
npm update commands, for an installation you intend to update, are:

```sh
npm install -g @openai/codex@latest spynel@latest cloudcmd@latest gritty@latest
npm install -g pm2@latest
```

Running processes retain loaded code until restarted. A conventional background
PM2 daemon needs `pm2 update` after updating the PM2 npm package. This image uses
foreground `pm2-runtime` as its main process: recreate/restart the container to
load the new runtime, rather than launching a competing daemon. Prefer image
rebuilds because npm changes made inside a container disappear on recreation.

Run focused checks with Node.js 22. The service check requires the image's npm
packages on PATH, free loopback port 80, and permission to bind it; it uses temporary
homes/workspaces and explicitly initializes only its test workspace:

```sh
node --test tests/startup.test.cjs
node --test tests/services.test.cjs
```

The real service check waits past PM2's ordinary sixteen-restart budget, verifies
five-second retry spacing and recovery, tests rejected and authorized file/PTY
access, and stops the actual foreground runtime with SIGTERM. When running outside
the image, install the Dockerfile's npm versions into an isolated prefix and add
`<prefix>/node_modules/.bin` to PATH; no global installation is necessary.

To check the installed packages in an image without starting its default services:

```sh
docker run --rm --entrypoint node -v "$PWD:/tests:ro" -w /tests codex \
  --test tests/startup.test.cjs tests/services.test.cjs
```

Host image smoke check (run only when you intend to create a new test container):

```sh
docker build -t codex .
smoke_workspace="$(mktemp -d)"
docker run -d --name codex-smoke --stop-timeout 30 \
  -p 127.0.0.1:8080:80 -v "$smoke_workspace:/workspace" codex
curl -o /dev/null -s -w '%{http_code}\n' http://127.0.0.1:8080/ # expect 401
curl -u admin -o /dev/null -s -w '%{http_code}\n' http://127.0.0.1:8080/ # enter admin; expect 200
docker exec codex-smoke pm2 list
docker exec codex-smoke node -e 'console.log(require("node:fs").readFileSync("/proc/1/cmdline", "utf8").replaceAll("\0", " "))'
docker stop --time 30 codex-smoke
docker rm codex-smoke
rm -rf "$smoke_workspace"
```

Open the UI and terminal before stopping for a browser smoke check. This task's
isolated checks used Debian bookworm/Node.js 22 and real npm tools; no Docker engine
was available, so Docker layer installation, actual PID 1 behavior, mount/port
publication and host restart-policy behavior still require this host validation.

Upstream references: [Cloud Commander configuration and terminal](https://cloudcmd.io/),
[PM2 process declaration](https://pm2.keymetrics.io/docs/usage/application-declaration/),
[PM2 container runtime](https://pm2.keymetrics.io/docs/usage/docker-pm2-nodejs/) and
[PM2 updates](https://pm2.keymetrics.io/docs/usage/quick-start/).
