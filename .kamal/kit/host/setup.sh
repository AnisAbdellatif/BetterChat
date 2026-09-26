#!/usr/bin/env bash
# deploy-kit host setup: turns a fresh Debian/Ubuntu VPS into a host Kamal
# can deploy to as an unprivileged user. Idempotent: safe to run again,
# e.g. to add a key or a port. Runs as root:
#
#   kit host remote root@<host> --ssh-key "$(cat ~/.ssh/id_ed25519.pub)"
#   kit host cloud-init --ssh-key-file ~/.ssh/id_ed25519.pub > user-data.yaml
#   curl … | sudo bash -s -- [options]      (or copy it over and run it)
#
# What it does (each part can be turned off):
#   user        a deploy user (default "deploy"), in the docker group, with
#               your SSH keys; no password, no sudo
#   docker      Docker Engine from Docker's apt repository, its signing key
#               checked against the published fingerprint
#   ssh         keys only, no passwords, root by key only (or not at all
#               with --admin-user), fewer auth tries, no forwarding for
#               the deploy user
#   firewall    ufw: deny incoming except SSH (rate limited) and --ports
#   upgrades    unattended security upgrades
#   swap        a swap file when there is none (--swap 2G; 0 to skip)
#   fail2ban    optional (--fail2ban)
#   age         optional: an age key for the deploy user, for secrets
#               decrypted on the server (--age)
#
# Note: ports Docker publishes bypass ufw (Docker writes its own iptables
# rules). Kamal's proxy publishes 80/443 on purpose; anything else should
# be published on 127.0.0.1 or kept on Docker's network. docs/host.md.
set -euo pipefail

DEPLOY_USER=deploy
SSH_KEYS=()
SSH_PORT=22
PORTS="80,443"
TIMEZONE=""
SWAP=2G
ADMIN_USER=""
ADMIN_KEYS=()
DO_DOCKER=true
DO_SSH=true
DO_FIREWALL=true
DO_UPGRADES=true
DO_FAIL2BAN=false
DO_AGE=false
DIRS=()

# Docker's apt repository signing key (https://docs.docker.com/engine/install/).
DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

usage() {
  cat <<'EOF'
host/setup.sh [options]   (as root)
  --user NAME             deploy user (default: deploy)
  --ssh-key "KEY"         public key for the deploy user (repeatable)
  --ssh-key-file FILE     public keys file for the deploy user (repeatable)
  --admin-user NAME       also create a sudo user for humans; root login is then disabled
  --admin-key "KEY"       public key for the admin user (repeatable; default: the deploy keys)
  --ssh-port PORT         SSH port kept open in the firewall (default: 22; doesn't move sshd)
  --ports LIST            other TCP ports to open, comma separated (default: 80,443)
  --timezone ZONE         e.g. UTC or Europe/Paris
  --swap SIZE             swap file size when there is no swap (default: 2G; 0: none)
  --dir PATH              a directory owned by the deploy user (repeatable), e.g. /srv/app
  --fail2ban              install fail2ban for sshd
  --age                   give the deploy user an age key (prints the public key)
  --no-docker --no-ssh-hardening --no-firewall --no-auto-upgrades
EOF
}

log() { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!!  %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31mxx  %s\033[0m\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case $1 in
    --user) DEPLOY_USER=$2 && shift ;;
    --ssh-key) SSH_KEYS+=("$2") && shift ;;
    --ssh-key-file)
      [ -r "$2" ] || die "can't read $2"
      while IFS= read -r line; do [ -n "$line" ] && SSH_KEYS+=("$line"); done <"$2"
      shift
      ;;
    --admin-user) ADMIN_USER=$2 && shift ;;
    --admin-key) ADMIN_KEYS+=("$2") && shift ;;
    --ssh-port) SSH_PORT=$2 && shift ;;
    --ports) PORTS=$2 && shift ;;
    --timezone) TIMEZONE=$2 && shift ;;
    --swap) SWAP=$2 && shift ;;
    --dir) DIRS+=("$2") && shift ;;
    --fail2ban) DO_FAIL2BAN=true ;;
    --age) DO_AGE=true ;;
    --no-docker) DO_DOCKER=false ;;
    --no-ssh-hardening) DO_SSH=false ;;
    --no-firewall) DO_FIREWALL=false ;;
    --no-auto-upgrades) DO_UPGRADES=false ;;
    -h | --help) usage && exit 0 ;;
    *) die "unknown option $1 (--help)" ;;
  esac
  shift
done

# ------------------------------------------------------------- preflight

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -r /etc/os-release ] || die "no /etc/os-release: Debian or Ubuntu only"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  debian | ubuntu) ;;
  *) die "Debian or Ubuntu only (this is ${ID:-unknown})" ;;
esac
[[ $DEPLOY_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "invalid user name: $DEPLOY_USER"
[ -z "$ADMIN_USER" ] || [[ $ADMIN_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "invalid user name: $ADMIN_USER"
[[ $SSH_PORT =~ ^[0-9]+$ ]] || die "invalid SSH port: $SSH_PORT"
[[ $PORTS =~ ^[0-9,]*$ ]] || die "--ports takes numbers separated by commas"
for key in ${SSH_KEYS[@]+"${SSH_KEYS[@]}"} ${ADMIN_KEYS[@]+"${ADMIN_KEYS[@]}"}; do
  [[ $key =~ ^(ssh-|ecdsa-|sk-) ]] || die "doesn't look like an SSH public key: ${key:0:30}…"
done

# Never lock ourselves out: hardening SSH needs a key that will still work.
if [ "$DO_SSH" = true ]; then
  if [ -n "$ADMIN_USER" ]; then
    [ ${#ADMIN_KEYS[@]} -gt 0 ] || [ ${#SSH_KEYS[@]} -gt 0 ] || [ -s "/home/$ADMIN_USER/.ssh/authorized_keys" ] ||
      die "--admin-user disables root login: give it a key (--admin-key or --ssh-key)"
  elif [ ${#SSH_KEYS[@]} -eq 0 ] && [ ! -s /root/.ssh/authorized_keys ] && [ ! -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ]; then
    die "SSH hardening turns passwords off, and no SSH key is set up anywhere: pass --ssh-key"
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt_install() { apt-get install -y -q --no-install-recommends "$@" >/dev/null; }

log "packages"
apt-get update -q >/dev/null
apt_install ca-certificates curl gnupg

if [ -n "$TIMEZONE" ]; then
  log "timezone $TIMEZONE"
  timedatectl set-timezone "$TIMEZONE" 2>/dev/null || ln -sf "/usr/share/zoneinfo/$TIMEZONE" /etc/localtime
fi

# ------------------------------------------------------------------ users

# add_keys USER KEYS...: appends keys not already there.
add_keys() {
  local user=$1 home dir file key
  shift
  home=$(getent passwd "$user" | cut -d: -f6)
  dir="$home/.ssh"
  file="$dir/authorized_keys"
  install -d -m 700 -o "$user" -g "$user" "$dir"
  touch "$file"
  for key in "$@"; do
    grep -qxF "$key" "$file" || printf '%s\n' "$key" >>"$file"
  done
  chown "$user:$user" "$file"
  chmod 600 "$file"
}

log "user $DEPLOY_USER"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
passwd -l "$DEPLOY_USER" >/dev/null 2>&1 || true # no password login, ever
[ ${#SSH_KEYS[@]} -eq 0 ] || add_keys "$DEPLOY_USER" "${SSH_KEYS[@]}"
for dir in ${DIRS[@]+"${DIRS[@]}"}; do
  install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$dir"
done

if [ -n "$ADMIN_USER" ]; then
  log "admin user $ADMIN_USER"
  apt_install sudo
  id "$ADMIN_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --groups sudo "$ADMIN_USER"
  usermod -aG sudo "$ADMIN_USER"
  if [ ${#ADMIN_KEYS[@]} -gt 0 ]; then
    add_keys "$ADMIN_USER" "${ADMIN_KEYS[@]}"
  elif [ ${#SSH_KEYS[@]} -gt 0 ]; then
    add_keys "$ADMIN_USER" "${SSH_KEYS[@]}"
  fi
  # Keys only, so sudo can't ask for a password the user doesn't have.
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$ADMIN_USER" >"/etc/sudoers.d/90-kit-$ADMIN_USER"
  chmod 440 "/etc/sudoers.d/90-kit-$ADMIN_USER"
  visudo -cf "/etc/sudoers.d/90-kit-$ADMIN_USER" >/dev/null || die "sudoers file invalid"
fi

# ----------------------------------------------------------------- docker

if [ "$DO_DOCKER" = true ]; then
  log "docker"
  if ! command -v docker >/dev/null 2>&1; then
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /tmp/docker.asc
    fingerprint=$(gpg --show-keys --with-colons /tmp/docker.asc 2>/dev/null | awk -F: '/^fpr:/ { print $10; exit }')
    [ "$fingerprint" = "$DOCKER_KEY_FINGERPRINT" ] ||
      die "Docker's signing key has fingerprint '$fingerprint', expected $DOCKER_KEY_FINGERPRINT: not installing"
    install -m 644 /tmp/docker.asc /etc/apt/keyrings/docker.asc
    rm -f /tmp/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
      "$(dpkg --print-architecture)" "$ID" "${VERSION_CODENAME:?}" >/etc/apt/sources.list.d/docker.list
    apt-get update -q >/dev/null
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  fi
  # Log rotation for every container, so logs can't fill the disk.
  if [ ! -f /etc/docker/daemon.json ]; then
    install -d /etc/docker
    printf '{\n  "log-driver": "local",\n  "log-opts": { "max-size": "20m", "max-file": "5" },\n  "live-restore": true\n}\n' >/etc/docker/daemon.json
    systemctl restart docker 2>/dev/null || true
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  # The docker group is root-equivalent: this user can do anything Docker
  # can. docs/host.md, "One user or one per project".
  usermod -aG docker "$DEPLOY_USER"
fi

# -------------------------------------------------------------------- ssh

if [ "$DO_SSH" = true ]; then
  log "ssh hardening"
  root_login=prohibit-password
  [ -n "$ADMIN_USER" ] && root_login=no
  # 00- so it comes before cloud images' own drop-ins (sshd keeps the first
  # value it reads, and some images set PasswordAuthentication yes).
  conf=/etc/ssh/sshd_config.d/00-kit.conf
  install -d /etc/ssh/sshd_config.d
  grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d/\*\.conf' /etc/ssh/sshd_config ||
    sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
  cat >"$conf.new" <<EOF
# Written by deploy-kit host setup.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin $root_login
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no

# The deploy user runs commands; it never needs tunnels or agents.
Match User $DEPLOY_USER
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTunnel no
EOF
  mv "$conf.new" "$conf"
  install -d -m 755 /run/sshd # sshd -t needs it; absent until sshd first starts
  if sshd -t 2>/tmp/sshd-test; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  else
    cat /tmp/sshd-test >&2
    rm -f "$conf"
    die "the SSH configuration didn't validate: removed it, sshd unchanged"
  fi
fi

# --------------------------------------------------------------- firewall

if [ "$DO_FIREWALL" = true ]; then
  log "firewall"
  apt_install ufw
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw limit "$SSH_PORT/tcp" comment ssh >/dev/null
  IFS=',' read -r -a ports <<<"$PORTS"
  for port in ${ports[@]+"${ports[@]}"}; do
    [ -n "$port" ] && ufw allow "$port/tcp" >/dev/null
  done
  ufw --force enable >/dev/null
fi

# --------------------------------------------------------------- upgrades

if [ "$DO_UPGRADES" = true ]; then
  log "unattended upgrades"
  apt_install unattended-upgrades
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
    >/etc/apt/apt.conf.d/20auto-upgrades
fi

# ------------------------------------------------------------------- swap

if [ "$SWAP" != 0 ] && [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
  log "swap $SWAP"
  if fallocate -l "$SWAP" /swapfile 2>/dev/null && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  else
    rm -f /swapfile
    warn "could not create swap (containers and some VPS types don't allow it)"
  fi
fi

# -------------------------------------------------------------- optionals

if [ "$DO_FAIL2BAN" = true ]; then
  log "fail2ban"
  apt_install fail2ban
  printf '[sshd]\nenabled = true\nport = %s\nbackend = systemd\n' "$SSH_PORT" >/etc/fail2ban/jail.d/kit-sshd.conf
  systemctl enable --now fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban >/dev/null 2>&1 || true
fi

if [ "$DO_AGE" = true ]; then
  log "age key for $DEPLOY_USER"
  apt_install age
  home=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
  keys="$home/.config/sops/age/keys.txt"
  if [ ! -f "$keys" ]; then
    install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.config" "$home/.config/sops" "$home/.config/sops/age"
    runuser -u "$DEPLOY_USER" -- age-keygen -o "$keys" 2>/dev/null
    chmod 600 "$keys"
  fi
  printf 'age public key (add it to .sops.yaml): %s\n' "$(grep -m1 '^# public key:' "$keys" | cut -d' ' -f4)"
fi

log "done: deploy as $DEPLOY_USER (ssh: user: $DEPLOY_USER in config/deploy.yml)"
