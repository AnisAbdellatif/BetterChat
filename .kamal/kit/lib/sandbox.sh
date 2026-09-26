# shellcheck shell=bash
# kit sandbox: the project's deploy path (the kit, Kamal, groups, hooks,
# smoke tests) run against a "server" on this machine, with the services
# on localhost. docs/sandbox.md explains it; this is the engine. Sourced
# after core.sh, notify.sh, kamal.sh and runner.sh.
#
# The parts, all on this machine's Docker:
#   registry   registry:2 on 127.0.0.1:<registry port>; the working tree's
#              images are built here and pushed to it
#   server     sshd on 127.0.0.1:<ssh port> with a Docker CLI on this
#              machine's Docker: what Kamal deploys to
#   deployer   Kamal and the kit in a container, playing the machine that
#              deploys (so Kamal needn't be installed here)
# Kamal deploys through the "sandbox" destination: each Kamal config has an
# overlay, <config>.sandbox.yml, pointing its roles, SSH and registry at
# the sandbox (`kit sandbox init` writes them).
#
# Safety: the deployer never sees .kamal/kit.local.env (the real server's
# settings), and before anything is deployed, Kamal itself is asked where
# the sandbox destination deploys: every host must be 127.0.0.1 on the
# sandbox's SSH port, every image from the sandbox's registry.

KIT_SANDBOX_REGISTRY_PASSWORD_VALUE=sandbox # registry:2 without auth accepts any

# ------------------------------------------------------------------ setup

# kit_sandbox_load: configuration and names. KIT_SANDBOX_* settings come
# from .kamal/sandbox/sandbox.env over the kit's (destination "sandbox").
kit_sandbox_load() {
  kit_load_config sandbox
  SANDBOX_DIR="$KIT_CONFIG_DIR/sandbox"
  if [ -f "$SANDBOX_DIR/sandbox.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$SANDBOX_DIR/sandbox.env"
    set +a
  fi
  SANDBOX_WORK="$SANDBOX_DIR/.work"
  local name
  name=$(kit_conf KIT_SANDBOX_NAME "")
  [ -n "$name" ] || name=$(basename "$KIT_PROJECT_DIR")
  SANDBOX_NAME=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/-*$//')
  SANDBOX_SERVER="kit-sandbox-$SANDBOX_NAME-server"
  SANDBOX_REGISTRY="kit-sandbox-$SANDBOX_NAME-registry"
  SANDBOX_SSH_PORT=$(kit_conf KIT_SANDBOX_SSH_PORT 2222)
  SANDBOX_REGISTRY_ADDR="127.0.0.1:$(kit_conf KIT_SANDBOX_REGISTRY_PORT 5555)"
  SANDBOX_SERVER_PATH=$(kit_conf KIT_SANDBOX_SERVER_PATH /srv/sandbox)
  SANDBOX_IMAGE=$(kit_conf KIT_SANDBOX_IMAGE "")
  [ -n "$SANDBOX_IMAGE" ] || SANDBOX_IMAGE=$(kit_conf KIT_RUNNER_IMAGE "")
  export SANDBOX_DIR SANDBOX_WORK SANDBOX_NAME SANDBOX_SERVER_PATH
}

# kit_sandbox_configs: the Kamal configs the sandbox deploys, in order.
kit_sandbox_configs() {
  local configs
  configs=$(kit_conf KIT_SANDBOX_CONFIGS "")
  [ -n "$configs" ] || configs=$(kit_config_file "${KIT_PROJECT_KAMAL_CONFIG_FILE:-}")
  kit_words "$configs"
}

# kit_sandbox_overlay CONFIG: its sandbox destination file, as Kamal names it.
kit_sandbox_overlay() { printf '%s.sandbox.yml\n' "${1%.yml}"; }

_sbx_docker() { kit_docker "$@"; }

_sbx_exists() { [ -n "$(_sbx_docker ps -aq --filter "name=^$1\$" 2>/dev/null)" ]; }
_sbx_running() { [ -n "$(_sbx_docker ps -q --filter "name=^$1\$" 2>/dev/null)" ]; }

# ---------------------------------------------------------------- deployer

# kit_sandbox_deployer COMMAND...: runs COMMAND in the deployer container
# (the kit's runner, lib/runner.sh, at the checkout's root), with the
# sandbox's SSH key and the host's network, the variables of
# KIT_SANDBOX_ENV, and an empty .kamal/kit.local.env over the real one.
# KIT_SANDBOX_DEPLOYER=local runs it here instead (the tests; or Kamal
# installed on this machine).
kit_sandbox_deployer() {
  local env=() assign
  env+=(KIT_SANDBOX=1 KIT_IN_RUNNER=1 "KIT_SANDBOX_REGISTRY_PASSWORD=$KIT_SANDBOX_REGISTRY_PASSWORD_VALUE"
    "KIT_BIN=$KIT_BIN" "KIT_PROJECT_DIR=$KIT_PROJECT_DIR")
  # The project's smoke URLs are production's: the sandbox checks only
  # KIT_SMOKE_URLS_SANDBOX (empty unless set). And it notifies no one,
  # unless KIT_SANDBOX_NOTIFY is on.
  env+=("KIT_SMOKE_URLS_SANDBOX=${KIT_SMOKE_URLS_SANDBOX:-}")
  kit_is_true "$(kit_conf KIT_SANDBOX_NOTIFY false)" || env+=(KIT_NOTIFY_LEVELS=)
  for assign in $(kit_words "$(kit_conf KIT_SANDBOX_ENV "")"); do
    case $assign in *=*) env+=("$assign") ;; *) kit_die "KIT_SANDBOX_ENV: '$assign' isn't NAME=value" ;; esac
  done

  if [ "${KIT_SANDBOX_DEPLOYER:-docker}" = local ]; then
    env "${env[@]}" "$@"
    return
  fi

  kit_sandbox_image
  kit_runner_base "$KIT_PROJECT_DIR"
  local args=("${KIT_RUNNER_ARGS[@]}" --network host -v "$SANDBOX_WORK/ssh:/home/kit/.ssh")
  # The real server's settings must not reach the sandbox's kit.
  [ -f "$KIT_CONFIG_DIR/kit.local.env" ] && args+=(-v "/dev/null:$KIT_CONFIG_DIR/kit.local.env:ro")
  for assign in "${env[@]}"; do args+=(-e "$assign"); done
  _sbx_docker "${args[@]}" "$SANDBOX_IMAGE" "$@"
}

# kit_sandbox_kit WORDS... ARGS...: the kit, in the deployer, aimed at the
# sandbox destination.
kit_sandbox_kit() {
  case ${1:-} in
    group) kit_sandbox_deployer "$KIT_BIN" group "$2" -d sandbox "${@:3}" ;;
    *) kit_sandbox_deployer "$KIT_BIN" "$1" -d sandbox "${@:2}" ;;
  esac
}

# kit_sandbox_kamal_config CONFIG: `kamal config` for the sandbox destination.
kit_sandbox_kamal_config() {
  local kamal=()
  read -r -a kamal <<<"$(kit_conf KIT_KAMAL kamal)"
  kit_sandbox_deployer "${kamal[@]}" config -c "$1" -d sandbox
}

# kit_sandbox_check_target CONFIG: refuses unless Kamal would deploy the
# sandbox destination of CONFIG to this machine's sandbox server, with
# images from the sandbox's registry.
kit_sandbox_check_target() {
  local config=$1 out hosts port repository host bad=""
  out=$(kit_sandbox_kamal_config "$config") ||
    kit_die "could not read $config for the sandbox destination (kit sandbox init writes $(kit_sandbox_overlay "$config"))"
  hosts=$(kit_kamal_config_get hosts "$out") || exit 1
  port=$(kit_kamal_config_get ssh_options.port "$out") || exit 1
  repository=$(kit_kamal_config_get repository "$out") || exit 1
  [ -n "$hosts" ] || bad="no hosts"
  for host in $hosts; do
    [ "$host" = 127.0.0.1 ] || bad="$bad host $host"
  done
  [ "$port" = "$SANDBOX_SSH_PORT" ] || bad="$bad ssh port ${port:-22} (not $SANDBOX_SSH_PORT)"
  case $repository in "$SANDBOX_REGISTRY_ADDR"/*) ;; *) bad="$bad registry of $repository" ;; esac
  if [ -n "$bad" ]; then
    kit_die "$config's sandbox destination doesn't point at this machine's sandbox (${bad# }): nothing deployed. See $(kit_sandbox_overlay "$config")"
  fi
}

# -------------------------------------------------------------- the pieces

kit_sandbox_image() {
  SANDBOX_IMAGE=$(kit_runner_image "$SANDBOX_IMAGE") || exit 1
}

kit_sandbox_ssh_key() {
  mkdir -p "$SANDBOX_WORK/ssh"
  chmod 700 "$SANDBOX_WORK/ssh"
  [ -f "$SANDBOX_WORK/ssh/id_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C "kit-sandbox" -f "$SANDBOX_WORK/ssh/id_ed25519"
  printf 'Host 127.0.0.1\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n' >"$SANDBOX_WORK/ssh/config"
}

kit_sandbox_registry_up() {
  if _sbx_running "$SANDBOX_REGISTRY"; then return 0; fi
  if _sbx_exists "$SANDBOX_REGISTRY"; then
    _sbx_docker start "$SANDBOX_REGISTRY" >/dev/null
  else
    kit_info "starting the sandbox registry on $SANDBOX_REGISTRY_ADDR"
    _sbx_docker run -d --name "$SANDBOX_REGISTRY" -p "$SANDBOX_REGISTRY_ADDR:5000" \
      -v "$SANDBOX_REGISTRY:/var/lib/registry" registry:2 >/dev/null
  fi
  kit_wait_until 30 1 curl -sf -o /dev/null "http://$SANDBOX_REGISTRY_ADDR/v2/" ||
    kit_die "the sandbox registry didn't answer on $SANDBOX_REGISTRY_ADDR"
}

# The server: on this machine's network, as a real server's Docker CLI is
# (`docker login` runs in the CLI and must reach the registry on
# 127.0.0.1); outside Docker's user namespace, where the image's files
# aren't root's, so sshd is given them first.
kit_sandbox_server_up() {
  mkdir -p "$SANDBOX_WORK/server"
  if ! _sbx_running "$SANDBOX_SERVER"; then
    if _sbx_exists "$SANDBOX_SERVER"; then
      _sbx_docker start "$SANDBOX_SERVER" >/dev/null
    else
      kit_info "starting the sandbox server (sshd on 127.0.0.1:$SANDBOX_SSH_PORT, this machine's Docker)"
      _sbx_docker run -d --name "$SANDBOX_SERVER" --network host --userns=host \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$SANDBOX_WORK/server:$SANDBOX_SERVER_PATH" \
        -v "$SANDBOX_WORK/ssh/id_ed25519.pub:/keys/id.pub:ro" \
        "$SANDBOX_IMAGE" sh -c "chown -R root:root /var/empty /etc/ssh /root \
          && install -m 600 /keys/id.pub /root/.ssh/authorized_keys \
          && exec /usr/sbin/sshd -D -e -p $SANDBOX_SSH_PORT -o ListenAddress=127.0.0.1" >/dev/null
    fi
  fi
  kit_wait_until 30 1 _sbx_sshd_answers ||
    kit_die "the sandbox server didn't answer on 127.0.0.1:$SANDBOX_SSH_PORT (docker logs $SANDBOX_SERVER)"
}

# sshd greets with "SSH-2.0-…" as soon as it accepts connections. (Read
# here over bash's /dev/tcp: no client, key or container needed for each
# try, only whether sshd is up.)
_sbx_sshd_answers() {
  local banner=""
  { exec 3<>"/dev/tcp/127.0.0.1/$SANDBOX_SSH_PORT"; } 2>/dev/null || return 1
  IFS= read -r -t 3 banner <&3 || true
  exec 3<&- 3>&-
  case $banner in SSH-2.0-*) return 0 ;; *) return 1 ;; esac
}

# kit_sandbox_hook NAME: the project's .kamal/sandbox/NAME, if it has one.
kit_sandbox_hook() {
  local hook="$SANDBOX_DIR/$1"
  [ -x "$hook" ] || return 0
  kit_info "sandbox: $1"
  KIT_SANDBOX_WORK=$SANDBOX_WORK KIT_SANDBOX_SERVER_DIR="$SANDBOX_WORK/server" \
    KIT_SANDBOX_SERVER_PATH=$SANDBOX_SERVER_PATH KIT_SANDBOX_NAME=$SANDBOX_NAME \
    KIT_SANDBOX_VERSION=${SANDBOX_VERSION:-} KIT_SANDBOX_REGISTRY=$SANDBOX_REGISTRY_ADDR \
    "$hook" || {
    # urls only prints where things are: its failing stops nothing.
    [ "$1" = urls ] && kit_warn "sandbox: .kamal/sandbox/urls failed" && return 0
    kit_die "sandbox: .kamal/sandbox/$1 failed"
  }
}

# kit_sandbox_next_version: sandbox-1, sandbox-2… (images of the working
# tree, uncommitted changes included, so never a commit's name).
kit_sandbox_next_version() {
  local n=0
  [ -f "$SANDBOX_WORK/version" ] && n=$(cat "$SANDBOX_WORK/version")
  kit_is_int "$n" || n=0
  n=$((n + 1))
  printf '%s\n' "$n" >"$SANDBOX_WORK/version"
  printf 'sandbox-%s\n' "$n"
}

# kit_sandbox_build CONFIG VERSION: the config's image from the working
# tree, as its Kamal builder describes it (context, dockerfile, target,
# args), labelled for Kamal, pushed to the sandbox registry.
kit_sandbox_build() {
  local config=$1 version=$2 out repository service context dockerfile target build_args args=() line
  out=$(kit_sandbox_kamal_config "$config") || kit_die "could not read $config for the sandbox destination"
  repository=$(kit_kamal_config_get repository "$out") || exit 1
  service=$(kit_config_service "$config")
  [ -n "$service" ] || kit_die "$config names no service"
  context=$(kit_kamal_config_get builder.context "$out") || exit 1
  dockerfile=$(kit_kamal_config_get builder.dockerfile "$out") || exit 1
  target=$(kit_kamal_config_get builder.target "$out") || exit 1
  build_args=$(kit_kamal_config_get builder.args "$out") || exit 1
  while IFS= read -r line; do
    [ -n "$line" ] && args+=(--build-arg "$line")
  done <<<"$build_args"
  context=${context:-.}
  kit_info "building $service from the working tree ($context) as $repository:$version"
  (cd "$KIT_PROJECT_DIR" && _sbx_docker build -q -t "$repository:$version" --label "service=$service" \
    ${dockerfile:+-f "$dockerfile"} ${target:+--target "$target"} ${args[@]+"${args[@]}"} "$context") >/dev/null ||
    kit_die "building $service failed"
  _sbx_docker push -q "$repository:$version" >/dev/null || kit_die "pushing $repository:$version to the sandbox registry failed"
}

# kit_sandbox_services: the Kamal services of the sandbox's configs.
kit_sandbox_services() {
  local config service
  for config in $(kit_sandbox_configs); do
    service=$(kit_config_service "$config")
    [ -n "$service" ] || kit_die "$config names no service"
    printf '%s\n' "$service"
  done
}

# _sbx_ps [DOCKER-PS-OPTIONS...]: `docker ps` of this sandbox's Kamal-run
# containers, those of its own services only: other projects' sandboxes
# on this machine carry the same destination label.
_sbx_ps() {
  local services service
  services=$(kit_sandbox_services) || exit 1
  for service in $services; do
    _sbx_docker ps "$@" --filter label=destination=sandbox --filter "label=service=$service" 2>/dev/null
  done
}

# The running Kamal-run containers of the sandbox.
kit_sandbox_containers() { _sbx_ps -q; }

# kamal-proxy, when a config's sandbox destination runs it: one per
# machine, and the sandbox's is the one bound to the sandbox's proxy port.
# (Its configured bindings, which a stopped container keeps; `docker ps`
# shows no ports for it once stopped.)
kit_sandbox_proxy() {
  local port bindings
  port=$(kit_conf KIT_SANDBOX_PROXY_PORT 8080)
  bindings=$(_sbx_docker inspect -f '{{json .HostConfig.PortBindings}}' kamal-proxy 2>/dev/null) || return 0
  case $bindings in
    *'"HostIp":"127.0.0.1","HostPort":"'"$port"'"'*) _sbx_docker inspect -f '{{.Id}}' kamal-proxy ;;
  esac
}

# ---------------------------------------------------------------- commands

kit_sandbox_up() {
  local config
  kit_require ssh-keygen
  mkdir -p "$SANDBOX_WORK"
  kit_sandbox_image
  kit_sandbox_ssh_key
  kit_sandbox_registry_up
  kit_sandbox_server_up

  if [ -f "$SANDBOX_WORK/deployed" ]; then
    # Up again after `down`: what ran is started again, not redeployed.
    kit_sandbox_hook services-up
    local id proxy
    proxy=$(kit_sandbox_proxy)
    [ -z "$proxy" ] || _sbx_docker start "$proxy" >/dev/null
    if [ -f "$SANDBOX_WORK/stopped" ]; then
      while read -r id; do
        [ -n "$id" ] && _sbx_docker start "$id" >/dev/null 2>&1
      done <"$SANDBOX_WORK/stopped"
      rm -f "$SANDBOX_WORK/stopped"
    fi
    kit_ok "sandbox up again (kit sandbox deploy to deploy the working tree)"
    kit_sandbox_hook urls
    return 0
  fi

  kit_sandbox_hook secrets
  kit_sandbox_hook services-up
  for config in $(kit_sandbox_configs); do kit_sandbox_check_target "$config"; done
  SANDBOX_VERSION=$(kit_sandbox_next_version)
  export SANDBOX_VERSION
  for config in $(kit_sandbox_configs); do kit_sandbox_build "$config" "$SANDBOX_VERSION"; done
  for config in $(kit_sandbox_configs); do
    kit_sandbox_kit deploy -c "$config" --skip-push --version "$SANDBOX_VERSION" --bootstrap ||
      kit_die "the first deploy of $config failed"
  done
  : >"$SANDBOX_WORK/deployed"
  kit_sandbox_hook seed
  kit_ok "sandbox up: $SANDBOX_VERSION deployed"
  kit_sandbox_hook urls
}

# kit_sandbox_deploy [-c CONFIG] [--group NAME]... [KIT-DEPLOY-ARGS...]:
# the working tree, built and deployed through the kit (every config, or
# -c's; with --group, only those holding the groups).
kit_sandbox_deploy() {
  local configs="" groups="" args=() config g owner selected groups_of=()
  while [ $# -gt 0 ]; do
    case $1 in
      -c | --config-file) configs="$configs $(kit_config_file "$2")" && shift ;;
      --group)
        [ $# -ge 2 ] || kit_die "--group needs a group"
        groups="$groups $2"
        shift
        ;;
      --group=*) groups="$groups ${1#--group=}" ;;
      *) args+=("$1") ;;
    esac
    shift
  done
  if [ -z "$configs" ]; then
    for config in $(kit_sandbox_configs); do configs="$configs $(kit_config_file "$config")"; done
  fi
  # --group: only the configs holding those groups are built and deployed,
  # each given its own groups (kit deploy refuses a group of another config).
  if [ -n "$groups" ]; then
    for g in $groups; do
      [ -f "$(kit_group_dir "$g")/group.env" ] || kit_die "no group '$g' (.kamal/groups/$g/group.env)"
      owner=$(kit_group_config_file "$g")
      kit_in_list "$owner" "$configs" || kit_die "group $g belongs to $owner, which this deploy doesn't cover (${configs# })"
    done
    selected=""
    for config in $configs; do
      for g in $groups; do
        if [ "$(kit_group_config_file "$g")" = "$config" ]; then
          selected="$selected $config"
          break
        fi
      done
    done
    configs=$selected
  fi
  [ -f "$SANDBOX_WORK/deployed" ] || kit_die "no sandbox yet: kit sandbox up"
  _sbx_running "$SANDBOX_SERVER" || kit_die "the sandbox is down: kit sandbox up"
  kit_sandbox_registry_up
  for config in $configs; do kit_sandbox_check_target "$config"; done
  SANDBOX_VERSION=$(kit_sandbox_next_version)
  export SANDBOX_VERSION
  for config in $configs; do kit_sandbox_build "$config" "$SANDBOX_VERSION"; done
  for config in $configs; do
    groups_of=()
    for g in $groups; do
      [ "$(kit_group_config_file "$g")" = "$config" ] && groups_of+=(--group "$g")
    done
    kit_sandbox_kit deploy -c "$config" --skip-push --version "$SANDBOX_VERSION" \
      ${groups_of[@]+"${groups_of[@]}"} ${args[@]+"${args[@]}"} ||
      kit_die "deploying $config to the sandbox failed"
  done
  kit_ok "sandbox: $SANDBOX_VERSION deployed"
}

kit_sandbox_status() {
  if ! _sbx_running "$SANDBOX_SERVER"; then
    if [ -f "$SANDBOX_WORK/deployed" ]; then
      kit_info "the sandbox is down: kit sandbox up starts it again"
    else
      kit_info "no sandbox yet: kit sandbox up creates it"
    fi
    return 0
  fi
  kit_sandbox_kit group status 2>/dev/null || true
  printf '\ncontainers:\n'
  _sbx_ps --format '  {{.Names}}  {{.Status}}' | sort
  kit_sandbox_hook urls
}

# kit_sandbox_role_container ROLE: the running container of a sandbox role.
kit_sandbox_role_container() {
  local id
  id=$(_sbx_ps -q --filter "label=role=$1" | head -n 1)
  [ -n "$id" ] || kit_die "no running sandbox container for role $1"
  printf '%s\n' "$id"
}

kit_sandbox_down() {
  local ids
  ids=$(kit_sandbox_containers) || exit 1
  if [ -n "$ids" ]; then printf '%s\n' "$ids"; fi >"$SANDBOX_WORK/stopped.new"
  if [ -s "$SANDBOX_WORK/stopped.new" ]; then
    # shellcheck disable=SC2046 # one id per word
    _sbx_docker stop $(cat "$SANDBOX_WORK/stopped.new") >/dev/null
    mv "$SANDBOX_WORK/stopped.new" "$SANDBOX_WORK/stopped"
  else
    rm -f "$SANDBOX_WORK/stopped.new"
  fi
  local proxy
  proxy=$(kit_sandbox_proxy)
  [ -z "$proxy" ] || _sbx_docker stop "$proxy" >/dev/null
  kit_sandbox_hook services-down
  _sbx_docker stop "$SANDBOX_SERVER" "$SANDBOX_REGISTRY" >/dev/null 2>&1 || true
  kit_ok "sandbox down (its data kept; kit sandbox up to start it again, reset to wipe it)"
}

kit_sandbox_reset() {
  local ids proxy
  ids=$(_sbx_ps -aq) || exit 1
  # shellcheck disable=SC2086 # one id per word
  [ -z "$ids" ] || _sbx_docker rm -f $ids >/dev/null
  proxy=$(kit_sandbox_proxy)
  [ -z "$proxy" ] || _sbx_docker rm -f "$proxy" >/dev/null
  kit_sandbox_hook reset
  _sbx_docker rm -f "$SANDBOX_SERVER" "$SANDBOX_REGISTRY" >/dev/null 2>&1 || true
  _sbx_docker volume rm "$SANDBOX_REGISTRY" >/dev/null 2>&1 || true
  rm -rf "$SANDBOX_WORK"
  kit_ok "sandbox reset: its containers, registry and work files are gone"
}

# kit_sandbox_init: .kamal/sandbox/ from the kit's template, and a sandbox
# destination overlay for each Kamal config (never overwritten).
kit_sandbox_init() {
  local config overlay file
  mkdir -p "$SANDBOX_DIR"
  for file in "$KIT_HOME"/templates/sandbox/*; do
    [ -e "$SANDBOX_DIR/$(basename "$file")" ] || cp -p "$file" "$SANDBOX_DIR/"
  done
  [ -f "$SANDBOX_DIR/.gitignore" ] || printf '# kit sandbox: generated keys, secrets and state.\n.work/\n' >"$SANDBOX_DIR/.gitignore"
  if [ ! -f "$KIT_CONFIG_DIR/secrets.sandbox" ]; then
    printf '# Kamal secrets for the sandbox destination (kit sandbox): its local registry\n# takes any password. Not a secret.\nKIT_SANDBOX_REGISTRY_PASSWORD=%s\n' \
      "$KIT_SANDBOX_REGISTRY_PASSWORD_VALUE" >"$KIT_CONFIG_DIR/secrets.sandbox"
    kit_ok "wrote .kamal/secrets.sandbox"
  fi
  if [ ! -f "$KIT_CONFIG_DIR/kit.sandbox.env" ]; then
    cat >"$KIT_CONFIG_DIR/kit.sandbox.env" <<EOF
# deploy-kit settings for the sandbox destination (kit sandbox, docs/sandbox.md).
# The kit's own gates (branch, CI, attestation, freeze...) skip themselves
# in the sandbox. Remove from this list your own steps that can't run
# locally (anything reaching GitHub or a real server's checkout):
KIT_HOOK_PRE_DEPLOY="$(kit_conf KIT_HOOK_PRE_DEPLOY "")"

# Checked after each sandbox deploy (the project's other smoke URLs are
# production's, and never used here):
# KIT_SMOKE_URLS_SANDBOX="http://localhost:8080/up"
EOF
    kit_ok "wrote .kamal/kit.sandbox.env: check its pre-deploy steps"
  fi
  for config in $(kit_sandbox_configs); do
    overlay=$(kit_sandbox_overlay "$config")
    if [ -f "$KIT_PROJECT_DIR/$overlay" ]; then
      kit_info "$overlay exists: left as it is"
      continue
    fi
    [ -f "$KIT_PROJECT_DIR/$config" ] || kit_die "no $config (KIT_SANDBOX_CONFIGS in .kamal/sandbox/sandbox.env)"
    kit_sandbox_write_overlay "$config" >"$KIT_PROJECT_DIR/$overlay"
    kit_ok "wrote $overlay: read it, and add what your roles need locally"
  done
  kit_ok "sandbox set up in .kamal/sandbox/ (its README.md says what to fill in)"
}

# kit_sandbox_roles CONFIG: the config's roles, read from the file itself
# (`servers:` as a list means one role, web).
kit_sandbox_roles() {
  local file="$KIT_PROJECT_DIR/$1"
  case $(kit_yaml_type servers "$file") in
    list) printf 'web\n' ;;
    map) kit_yaml_keys servers "$file" ;;
    *) kit_die "$1: could not read its servers" ;;
  esac
}

# kit_sandbox_write_overlay CONFIG: the sandbox destination for CONFIG.
kit_sandbox_write_overlay() {
  local config=$1 role roles hosts_key=host proxy_port
  roles=$(kit_sandbox_roles "$config") || exit 1
  proxy_port=$(kit_conf KIT_SANDBOX_PROXY_PORT 8080)
  # The proxy's host key must be the one the config uses (Kamal refuses both).
  kit_yaml_type proxy.hosts "$KIT_PROJECT_DIR/$config" >/dev/null 2>&1 && hosts_key=hosts
  cat <<EOF
# The "sandbox" destination of $config, for \`kit sandbox\` (deploy-kit,
# docs/sandbox.md): what Kamal deploys to on this machine. Merged over
# $config by \`-d sandbox\`. Generated by \`kit sandbox init\`; yours to extend
# (options a role needs only locally, like an extra host).
#
# kit sandbox refuses to deploy unless every host is 127.0.0.1, SSH is on
# the sandbox's port and the images come from the sandbox's registry.
servers:
EOF
  for role in $roles; do
    printf '  %s:\n    hosts: [127.0.0.1]\n' "$role"
  done
  cat <<EOF

ssh:
  user: root
  port: $(kit_conf KIT_SANDBOX_SSH_PORT 2222)

registry:
  server: 127.0.0.1:$(kit_conf KIT_SANDBOX_REGISTRY_PORT 5555)
  username: sandbox
  password: [KIT_SANDBOX_REGISTRY_PASSWORD]

# For roles behind kamal-proxy: it answers for localhost on plain HTTP, on
# 127.0.0.1:$proxy_port only. (No effect on roles with proxy: false.)
proxy:
EOF
  if [ "$hosts_key" = hosts ]; then printf '  hosts: [localhost]\n'; else printf '  host: localhost\n'; fi
  cat <<EOF
  ssl: false
  run:
    http_port: $proxy_port
    https_port: $(kit_conf KIT_SANDBOX_PROXY_TLS_PORT 8443)
    bind_ips: [127.0.0.1]
EOF
}
