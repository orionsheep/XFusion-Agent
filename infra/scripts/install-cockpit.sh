#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root."
  exit 1
fi

install_pkg() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y cockpit
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y cockpit
  elif command -v yum >/dev/null 2>&1; then
    yum install -y cockpit
  else
    echo "Unsupported package manager. Install Cockpit manually."
    exit 1
  fi
}

install_pkg
systemctl enable --now cockpit.socket

if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=cockpit || true
  firewall-cmd --reload || true
fi

echo "Cockpit installed. Open https://<host>:9090"

