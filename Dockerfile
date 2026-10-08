FROM debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    bash \
    git \
    bubblewrap \
    haproxy \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g @openai/codex pm2@7.0.4 spynel@0.12.14 cloudcmd@19.21.1 gritty@10.2.1 \
 && echo '' >> /root/.bashrc \
 && echo '# Auto-Warpify' >> /root/.bashrc \
 && echo '[[ "$-" == *i* ]] && printf '\''\eP$f{"hook": "SourcedRcFileForWarp", "value": { "shell": "bash", "uname": "'"'"'$(uname)'"'"'", "tmux": false }}\x9c'\''' >> /root/.bashrc \
 && echo '' >> /root/.bashrc \
 && echo '# Preserve terminal color capabilities in interactive Docker exec shells.' >> /root/.bashrc \
 && echo 'if [[ -t 1 ]]; then' >> /root/.bashrc \
 && echo '    [[ -z "${TERM:-}" || "$TERM" == dumb ]] && export TERM=xterm-256color' >> /root/.bashrc \
 && echo '    export COLORTERM="${COLORTERM:-truecolor}"' >> /root/.bashrc \
 && echo '    unset NO_COLOR' >> /root/.bashrc \
 && echo 'fi' >> /root/.bashrc \
 && echo '' >> /root/.bashrc \
 && echo '# Codex full access by default' >> /root/.bashrc \
 && echo 'alias codex="codex -a never -s danger-full-access"' >> /root/.bashrc \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY startup.sh /usr/local/bin/codex-startup
COPY init.d/ /etc/codex-init.d/
COPY ecosystem.config.js /usr/local/lib/codex-docker/ecosystem.config.js
COPY haproxy.cfg /etc/haproxy/haproxy.cfg
RUN chmod +x /usr/local/bin/codex-startup /etc/codex-init.d/*

EXPOSE 22 80 3000 5000 8000 9000 9001 9002 9003 9004 9005 9006 9007 9008 9009

CMD ["/usr/local/bin/codex-startup"]
