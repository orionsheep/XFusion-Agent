#!/usr/bin/env bash
set -euo pipefail

VERSION="${NODE_EXPORTER_VERSION:-1.10.2}"
INSTALL_DIR="/opt/node_exporter"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root."
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) TARGET_ARCH="amd64" ;;
  aarch64|arm64) TARGET_ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

useradd --system --no-create-home --shell /usr/sbin/nologin node_exporter 2>/dev/null || true

curl -fsSL -o "$TMP_DIR/node_exporter.tar.gz" \
  "https://github.com/prometheus/node_exporter/releases/download/v${VERSION}/node_exporter-${VERSION}.linux-${TARGET_ARCH}.tar.gz"
tar -xzf "$TMP_DIR/node_exporter.tar.gz" -C "$TMP_DIR"
mkdir -p "$INSTALL_DIR"
install -m 0755 "$TMP_DIR/node_exporter-${VERSION}.linux-${TARGET_ARCH}/node_exporter" "$INSTALL_DIR/node_exporter"

cat >/etc/systemd/system/node_exporter.service <<'EOF'
[Unit]
Description=Prometheus Node Exporter
After=network-online.target
Wants=network-online.target

[Service]
User=node_exporter
Group=node_exporter
Type=simple
ExecStart=/opt/node_exporter/node_exporter
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now node_exporter

if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=9100/tcp || true
  firewall-cmd --reload || true
fi

echo "Node Exporter installed. Metrics endpoint: http://<host>:9100/metrics"

