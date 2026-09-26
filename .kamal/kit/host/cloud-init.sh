#!/usr/bin/env bash
# Prints cloud-init user data that runs host/setup.sh with the given
# options on a new VPS's first boot. Paste it in the provider's "user
# data" / "cloud-init" field when creating the server:
#
#   kit host cloud-init --ssh-key-file ~/.ssh/id_ed25519.pub --timezone UTC > user-data.yaml
#
# Takes host/setup.sh's options. Key files are read here, on your machine,
# and their keys passed on (the server can't read your files). The script
# is embedded (base64), so what runs is exactly this checkout's version.
# Progress on the server: /var/log/kit-host-setup.log.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
args=()
while [ $# -gt 0 ]; do
  case $1 in
    --ssh-key-file | --admin-key-file)
      opt=--ssh-key
      [ "$1" = --admin-key-file ] && opt=--admin-key
      [ -r "${2:-}" ] || {
        echo "can't read ${2:-}" >&2
        exit 1
      }
      while IFS= read -r line; do [ -n "$line" ] && args+=("$opt" "$line"); done <"$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) args+=("$1") && shift ;;
  esac
done

# YAML single-quoted string: ' doubled.
yaml_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

script_b64=$(base64 <"$here/setup.sh" | tr -d '\n')

printf '#cloud-config\n'
printf '# deploy-kit host setup (%s); the script runs once, on first boot.\n' "$(cat "$here/../VERSION" 2>/dev/null || echo dev)"
printf 'write_files:\n'
printf '  - path: /root/kit-host-setup.sh\n'
printf '    permissions: "0700"\n'
printf '    encoding: b64\n'
printf '    content: %s\n' "$script_b64"
printf 'runcmd:\n'
printf '  - - bash\n'
printf '    - -c\n'
printf '    - %s\n' "$(yaml_quote 'bash /root/kit-host-setup.sh "$@" >>/var/log/kit-host-setup.log 2>&1')"
printf '    - kit-host-setup\n'
for arg in ${args[@]+"${args[@]}"}; do
  printf '    - %s\n' "$(yaml_quote "$arg")"
done
