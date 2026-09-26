# shellcheck shell=bash disable=SC2153 # R_* are set by kit_runner_settings' eval
# The kit in its image (sandbox/Dockerfile: Kamal, bash, curl, gh, sops,
# age) instead of on this machine. With KIT_RUNNER=docker, the commands
# that run Kamal re-run themselves there (docs/runner.md): Kamal, the kit
# and its hooks all in one container, for machines without Kamal (or its
# Ruby). The sandbox's deployer is the same container, with the sandbox's
# SSH key and network (lib/sandbox.sh). Sourced after core.sh.

# The commands that run Kamal, and so run in the image with KIT_RUNNER=docker.
KIT_RUNNER_COMMANDS="deploy group role-exec kamal doctor"

# kit_docker ARGS...: Docker (KIT_DOCKER: another command, for the tests).
kit_docker() {
  local docker=()
  read -r -a docker <<<"${KIT_DOCKER:-${KIT_SANDBOX_DOCKER:-docker}}"
  "${docker[@]}" "$@"
}

# kit_require_docker: stops unless Docker is here and its daemon answers.
kit_require_docker() {
  local docker=()
  read -r -a docker <<<"${KIT_DOCKER:-${KIT_SANDBOX_DOCKER:-docker}}"
  command -v "${docker[0]:-docker}" >/dev/null 2>&1 || kit_die "needs Docker: '${docker[*]}' isn't here"
  kit_docker info >/dev/null 2>&1 || kit_die "Docker isn't answering (\`${docker[*]} info\` failed): is it running?"
}

# kit_runner_image [IMAGE]: IMAGE (KIT_RUNNER_IMAGE when empty, else
# deploy-kit:<version>), built from sandbox/Dockerfile when it's the
# kit's own and isn't here yet. Prints its name.
kit_runner_image() {
  local image=${1:-}
  if [ -z "$image" ]; then
    image="deploy-kit:$(cat "$KIT_HOME/VERSION")"
    if ! kit_docker image inspect "$image" >/dev/null 2>&1; then
      kit_info "building $image (Kamal and the kit's tools; once per kit version)"
      kit_docker build -q -t "$image" "$KIT_HOME/sandbox" >/dev/null || kit_die "could not build $image"
    fi
  fi
  printf '%s\n' "$image"
}

# kit_runner_base [WORKDIR]: KIT_RUNNER_ARGS, the `docker run` options
# every run of the kit in its image shares: as this user, in this checkout
# (at the same path, so the kit, hooks and git see what they see here), in
# WORKDIR (default: here, if within the checkout, else its root), with a
# home of its own.
kit_runner_base() {
  local git_dir workdir=${1:-$PWD} email name
  case $workdir/ in "$KIT_PROJECT_DIR"/*) ;; *) workdir=$KIT_PROJECT_DIR ;; esac
  # Kamal names the deployer from git (locks, audit lines on the servers).
  email=$(git config user.email 2>/dev/null || true)
  name=$(git config user.name 2>/dev/null || true)
  # --userns=host: a daemon remapping user namespaces would otherwise give
  # the container another uid, locked out of this checkout (and refused
  # the host's network, which the sandbox uses).
  # --init: signals (Ctrl-C) reach the kit, not a shell as PID 1 ignoring them.
  KIT_RUNNER_ARGS=(run --rm --init --userns=host --user "$(id -u):$(id -g)"
    -e HOME=/home/kit -e KIT_IN_RUNNER=1
    -e GIT_CONFIG_COUNT=3 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*'
    -e GIT_CONFIG_KEY_1=user.email -e "GIT_CONFIG_VALUE_1=${email:-kit@localhost}"
    -e GIT_CONFIG_KEY_2=user.name -e "GIT_CONFIG_VALUE_2=${name:-kit}"
    -v "$KIT_PROJECT_DIR:$KIT_PROJECT_DIR" -w "$workdir")
  [ -t 0 ] && [ -t 1 ] && KIT_RUNNER_ARGS+=(-it)
  # The kit itself, when it lives outside the checkout (not vendored).
  case $KIT_HOME/ in "$KIT_PROJECT_DIR"/*) ;; *) KIT_RUNNER_ARGS+=(-v "$KIT_HOME:$KIT_HOME:ro") ;; esac
  # A git worktree: its repository lives elsewhere (the gates fetch into it).
  git_dir=$(git -C "$KIT_PROJECT_DIR" rev-parse --git-common-dir 2>/dev/null || true)
  if [ -n "$git_dir" ]; then
    case $git_dir in /*) ;; *) git_dir=$(cd "$KIT_PROJECT_DIR/$git_dir" 2>/dev/null && pwd) || git_dir="" ;; esac
    case $git_dir/ in "$KIT_PROJECT_DIR"/* | /) ;; *) [ -d "$git_dir" ] && KIT_RUNNER_ARGS+=(-v "$git_dir:$git_dir") ;; esac
  fi
  return 0
}

# kit_runner_settings: the KIT_RUNNER* settings (not per destination), and
# the project, read in a subshell: loading the configuration here would
# export it, and the command's own load (with its destination) would then
# take the files' values for the environment's.
kit_runner_settings() {
  local out var vars="KIT_PROJECT_DIR KIT_RUNNER KIT_RUNNER_IMAGE KIT_RUNNER_NETWORK KIT_RUNNER_SSH_DIR
    KIT_RUNNER_SSH_AGENT KIT_RUNNER_DOCKER_SOCKET KIT_RUNNER_ENV"
  for var in $vars; do eval "R_$var="; done
  out=$(
    kit_load_config >/dev/null 2>&1 || exit 0
    for var in $vars; do printf 'R_%s=%q\n' "$var" "$(kit_conf "$var" "")"; done
  ) || out=""
  eval "$out"
}

# kit_runner_maybe_exec COMMAND ARGS...: with KIT_RUNNER=docker, and for a
# command that runs Kamal, runs `kit COMMAND ARGS...` in the kit's image
# instead (and doesn't return). Otherwise returns, and the command runs here.
kit_runner_maybe_exec() {
  [ -z "${KIT_IN_RUNNER:-}" ] || return 0
  kit_in_list "$1" "$KIT_RUNNER_COMMANDS" || return 0
  local exported
  exported=$(compgen -e) # before anything is loaded: what the caller set
  kit_runner_settings
  case $R_KIT_RUNNER in
    local | "") return 0 ;;
    docker) ;;
    *) kit_die "KIT_RUNNER=$R_KIT_RUNNER: local or docker" ;;
  esac
  kit_runner_exec "$exported" "$@"
}

# kit_runner_exec EXPORTED COMMAND ARGS...: `kit COMMAND ARGS...` in the
# kit's image, with what it needs from this machine: the SSH agent and
# ~/.ssh (Kamal reaching the servers, the gates fetching), Docker (builds),
# gh's token (the CI and attestation gates), the age key (sops), git's
# config, and the variables EXPORTED names that the kit reads (KIT_*,
# KAMAL_*, and KIT_RUNNER_ENV's), passed by name: values never appear on
# a command line.
kit_runner_exec() {
  local exported=$1 image args name dir sock gid key token os seen=" "
  shift
  kit_require_docker
  KIT_PROJECT_DIR=$R_KIT_PROJECT_DIR
  [ -n "$KIT_PROJECT_DIR" ] || KIT_PROJECT_DIR=$(kit_project_dir)
  image=$(kit_runner_image "$R_KIT_RUNNER_IMAGE") || exit 1
  kit_runner_base
  args=("${KIT_RUNNER_ARGS[@]}")
  os=$(uname -s)

  [ -z "$R_KIT_RUNNER_NETWORK" ] || args+=(--network "$R_KIT_RUNNER_NETWORK")

  # ~/.ssh: keys, config, known_hosts (Kamal adds new hosts to it, as it
  # would here). Also at its own path, for configs naming files by it.
  dir=${R_KIT_RUNNER_SSH_DIR:-$HOME/.ssh}
  if [ -d "$dir" ]; then
    dir=$(cd "$dir" && pwd)
    args+=(-v "$dir:/home/kit/.ssh")
    [ "$dir" = /home/kit/.ssh ] || args+=(-v "$dir:$dir")
  fi

  # The SSH agent. Docker Desktop (and OrbStack) on a Mac can't mount the
  # agent's own socket, and offer theirs at a fixed path.
  sock=${R_KIT_RUNNER_SSH_AGENT:-auto}
  if [ "$sock" = auto ]; then
    sock=""
    if [ "$os" = Darwin ]; then sock=/run/host-services/ssh-auth.sock
    elif [ -S "${SSH_AUTH_SOCK:-}" ]; then sock=$SSH_AUTH_SOCK; fi
  fi
  if [ -n "$sock" ] && [ "$sock" != none ]; then
    args+=(-v "$sock:/run/kit/ssh-agent.sock" -e SSH_AUTH_SOCK=/run/kit/ssh-agent.sock)
  fi

  # Docker, for Kamal's builds (none needed with KIT_DEPLOY_SKIP_PUSH).
  sock=${R_KIT_RUNNER_DOCKER_SOCKET-/var/run/docker.sock}
  [ -n "$sock" ] || sock=/var/run/docker.sock
  if [ "$sock" != none ] && { [ "$os" = Darwin ] || [ -S "$sock" ]; }; then
    gid=0
    [ "$os" = Darwin ] || gid=$(stat -c %g "$sock" 2>/dev/null || stat -f %g "$sock")
    args+=(-v "$sock:/var/run/docker.sock" --group-add "$gid")
  fi

  # git's own config (url rewrites, identities); credential helpers that
  # need this machine's keychain won't work there: prefer SSH remotes.
  [ -f "$HOME/.gitconfig" ] && args+=(-v "$HOME/.gitconfig:/home/kit/.gitconfig:ro")

  # gh's token, when gh here is logged in and none is set: gh keeps it in
  # the system keychain, out of the container's reach.
  if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
    token=$(gh auth token 2>/dev/null || true)
    [ -z "$token" ] || export GH_TOKEN=$token
  fi

  # The age key sops reads.
  key=${SOPS_AGE_KEY_FILE:-}
  if [ -z "$key" ]; then
    if [ "$os" = Darwin ]; then key="$HOME/Library/Application Support/sops/age/keys.txt"
    else key="${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt"; fi
  fi
  [ -f "$key" ] && args+=(-v "$key:/run/kit/age-keys.txt:ro" -e SOPS_AGE_KEY_FILE=/run/kit/age-keys.txt)

  # The variables, by name (docker copies each value from its environment).
  for name in $exported $(kit_words "$R_KIT_RUNNER_ENV") GH_TOKEN GITHUB_TOKEN SOPS_AGE_KEY TERM NO_COLOR; do
    case $name in
      KIT_BIN | KIT_HOME | KIT | KIT_LOADED | KIT_IN_RUNNER | KIT_DOCKER | KIT_SANDBOX_DOCKER) continue ;;
      GH_TOKEN | GITHUB_TOKEN | SOPS_AGE_KEY | TERM | NO_COLOR) ;;
      KIT_* | KAMAL_*) ;;
      *) kit_in_list "$name" "$R_KIT_RUNNER_ENV" || continue ;;
    esac
    kit_is_name "$name" || continue
    [ -n "${!name+set}" ] || continue
    case $seen in *" $name "*) continue ;; esac
    seen="$seen$name "
    export "${name?}"
    args+=(-e "$name")
  done

  kit_docker "${args[@]}" "$image" "$KIT_BIN" "$@"
  exit $?
}
