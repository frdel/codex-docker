# Codex Docker

A Debian bookworm image with Node.js 22, Git, Bubblewrap, npm-installed Codex,
PM2, Spynel, Cloud Commander and Gritty, plus APT-installed HAProxy.
Interactive Bash retains its terminal color settings and the full-access Codex alias.

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
Commander is behind HAProxy, which binds port 80 on IPv4 and IPv6. Cloud Commander
listens only on `127.0.0.1:8081`, enforced by PM2 even for older saved configs.
Do not publish a backend port or start another Cloud Commander listener. Other
exposed ports are retained from the original image and are not published by this example.

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

## HTTP authentication protection

Five rejected HTTP Basic credential attempts within a fixed sixty-second window
starting at the first failure block that TCP peer IP for sixty seconds. The fifth
failure returns the normal `401`; subsequent HTTP requests and new WebSocket
handshakes get `429` with `Retry-After: 60`. Requests during the block do not extend
its end. Timestamps have one-second resolution. Browser challenges without an
Authorization token, successful requests, and intentional logout responses do not
consume the budget: counting requires a credential-bearing Basic request and a
backend `401` with a Basic `WWW-Authenticate` challenge. Logout has no such header.
Detection follows the pinned upstream parser and reads the complete first
Authorization header; comma-prefixed tokens and its accepted whitespace share
the same failure budget. Malformed headers with no parsed token do not count.
Protection applies across paths, including saved URL prefixes, without logging
headers, credentials or file content. Cloud Commander's separate general request
limiter still applies.

Identity comes only from the TCP connection, for both IPv4 and IPv6. HAProxy
replaces `X-Forwarded-For` with that address and removes `Forwarded`, `X-Real-IP`,
`X-Client-IP`, and forwarded host/protocol headers. It does not accept the PROXY
protocol or trust upstream forwarding headers. The documented Docker publication
connects directly to HAProxy; Docker NAT/userland/rootless networking or an external
TLS proxy may make several clients appear as one peer and share a budget. Behind
such a proxy the proxy's address is throttled, not a claimed original client IP.
Verify the actual peer in your host topology before exposing it. Supporting trusted
original-client forwarding would require an explicit constrained trust design.
HTTP stays unencrypted unless you already provide external TLS.

This is a small per-IP deterrent, not account lockout: rotating addresses can avoid
it and shared addresses can affect other users. A bounded table keeps at most
10,000 peers; idle entries expire after two minutes and may be evicted when full.
Counters are in memory and reset on HAProxy restart. The single worker thread
allows at most 256 concurrent connections. File transfers have five-minute idle
timeouts; upgraded sockets have a one-hour idle timeout. Active traffic refreshes
these timeouts. An unavailable backend returns `503`; an unavailable/invalid proxy
leaves no public listener or direct fallback.

Existing upgraded sockets continue during an IP block. Cloud Commander/Gritty
authenticates terminal sessions inside Socket.IO after the HTTP handshake, using
the saved username and hash. Those rejection events are not HTTP Basic `401`
responses and are **not counted by this throttle**, including on polling sessions.
Native terminal authentication remains required; keep credentials strong and
access private even with this HTTP protection.

## Initialization order

The image's `/usr/local/bin/codex-startup` reads `/etc/codex-init.d` in alphabetical
order with `LC_ALL=C`. It runs non-hidden executable regular files (including
symlinks to such files), regardless of extension, using their shebangs. It ignores
subdirectories and non-executable files. A nonzero exit stops startup immediately;
an empty selection exits with an error. Scripts run separately, so exported shell
variables do not carry into subsequent scripts.

The defaults are:

- `10-cloudcmd.cjs`: create or validate Cloud Commander's private configuration.
- `20-haproxy.sh`: validate the HAProxy configuration; failure stops startup.
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
all three default scripts or supply your own complete sequence and final foreground
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
Listener settings in saved files remain intact, but PM2 always overrides them to
loopback port 8081. The config dialog is disabled initially to prevent accidental
auth changes. Edit the private config deliberately for later settings/credential changes; a password
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

Run focused checks with Node.js 22. The service check requires HAProxy and the
image's npm packages on PATH, free loopback ports 80 and 8081 (IPv4/IPv6), and
permission to bind them. It uses temporary homes/workspaces and explicitly
initializes only its test workspace:

```sh
node --test tests/startup.test.cjs
node --test tests/proxy.test.cjs
node --test tests/services.test.cjs
```

The real service check waits past PM2's ordinary sixteen-restart budget, verifies
five-second retry spacing and recovery, tests rejected and authorized file/uploads/PTY
and polling/WebSocket access, verifies the real sixty-second IPv4/IPv6 block and
recovery despite blocked traffic, crashes/retries both proxy and backend, and stops
the foreground runtime with SIGTERM. Proxy fixtures also check rewritten headers,
failure-window expiry and malformed configuration. When running outside
the image, install the Dockerfile's npm versions into an isolated prefix and add
`<prefix>/node_modules/.bin` to PATH; no global npm installation is necessary.
Use Debian bookworm's HAProxy 2.6 package; the rules are validated against
`2.6.12-1+deb12u3`. APT may supply a newer security revision on later builds.

To check the installed packages in an image without starting its default services:

```sh
docker run --rm --entrypoint node -v "$PWD:/tests:ro" -w /tests codex \
  --test tests/startup.test.cjs tests/proxy.test.cjs tests/services.test.cjs
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
[PM2 updates](https://pm2.keymetrics.io/docs/usage/quick-start/) and
[HAProxy 2.6 configuration](https://docs.haproxy.org/2.6/configuration.html).
