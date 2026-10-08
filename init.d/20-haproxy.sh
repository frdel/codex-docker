#!/bin/bash
set -euo pipefail
haproxy -c -f /etc/haproxy/haproxy.cfg
