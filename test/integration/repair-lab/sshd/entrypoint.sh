#!/bin/sh
# Repair Integration Lab (TF-044): Host-Keys zur Laufzeit erzeugen (nie im Repo/Image) und sshd im Vordergrund starten.
#   LAB_MODE=modern  → Ed25519 + ECDSA + RSA (Server bietet ssh-ed25519, ecdsa-sha2-nistp256, rsa-sha2-512/256)
#   LAB_MODE=legacy  → NUR RSA mit HostKeyAlgorithms ssh-rsa (SHA-1) – Jarvis darf sich hier nie verbinden.
set -eu
MODE="${LAB_MODE:-modern}"
D=/etc/ssh/lab
mkdir -p "$D"
rm -f "$D"/ssh_host_*
if [ "$MODE" = "legacy" ]; then
  ssh-keygen -q -t rsa -b 3072 -N "" -f "$D/ssh_host_rsa_key"
  KEYS="HostKey $D/ssh_host_rsa_key"
  ALGS="HostKeyAlgorithms ssh-rsa"
else
  ssh-keygen -q -t ed25519 -N "" -f "$D/ssh_host_ed25519_key"
  ssh-keygen -q -t ecdsa -b 256 -N "" -f "$D/ssh_host_ecdsa_key"
  ssh-keygen -q -t rsa -b 3072 -N "" -f "$D/ssh_host_rsa_key"
  KEYS="HostKey $D/ssh_host_ed25519_key
HostKey $D/ssh_host_ecdsa_key
HostKey $D/ssh_host_rsa_key"
  ALGS=""
fi
cat > "$D/sshd_config" <<EOF
Port 22
$KEYS
$ALGS
PermitRootLogin no
AllowUsers labuser
PasswordAuthentication yes
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
PermitEmptyPasswords no
AllowTcpForwarding no
AllowAgentForwarding no
AllowStreamLocalForwarding no
PermitTunnel no
X11Forwarding no
LogLevel VERBOSE
# Lab: die Testsuite öffnet absichtlich Dutzende Pre-Auth-Verbindungen (Discovery je Test). Produktion: eine Discovery je Auftrag
# (≤ 5 Verbindungen) bleibt unter der OpenSSH-Schwelle; der Unit-Test prüft diese Obergrenze + den Cache.
PerSourcePenalties no
Subsystem sftp internal-sftp -l INFO
PidFile /run/sshd.pid
EOF
exec /usr/sbin/sshd -D -e -f "$D/sshd_config"
