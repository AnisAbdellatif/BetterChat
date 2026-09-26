# shellcheck shell=bash
# Core helpers shared by every deploy-kit command and step: logging, lists,
# configuration loading, timeouts and waiting. Sourced, never run.
#
# Portable to bash 3.2 (macOS's /bin/bash): no associative arrays, no
# ${var,,}, no mapfile. Deploys are often run from a Mac.

KIT_HOME=${KIT_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
export KIT_HOME

# shellcheck source=yaml.sh
. "$KIT_HOME/lib/yaml.sh"

# ---------------------------------------------------------------- logging

_kit_color() {
  if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then printf '\033[%sm' "$1"; fi
}

kit_log() { printf '%skit%s %s\n' "$(_kit_color 2)" "$(_kit_color 0)" "$*" >&2; }
kit_info() { kit_log "$*"; }
kit_ok() { printf '%skit ✓%s %s\n' "$(_kit_color 32)" "$(_kit_color 0)" "$*" >&2; }
kit_warn() { printf '%skit !%s %s\n' "$(_kit_color 33)" "$(_kit_color 0)" "$*" >&2; }
kit_error() { printf '%skit ✗%s %s\n' "$(_kit_color 31)" "$(_kit_color 0)" "$*" >&2; }
kit_die() {
  kit_error "$*"
  exit 1
}

# kit_gate_die MESSAGE: a gate refusing, and how to go past it once, on
# purpose (the step's name comes from the hook running it: KIT_STEP).
kit_gate_die() {
  local hint=""
  [ -z "${KIT_STEP:-}" ] ||
    hint=" To go past it once, on purpose: KIT_SKIP=$(basename "$KIT_STEP") KIT_SKIP_REASON=\"why\" before the command (warned and notified)"
  kit_die "$1.$hint"
}

# ------------------------------------------------------------------ values

# kit_is_true VALUE: 1, true, yes, on (any case).
kit_is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

# kit_upper TEXT: upper case, with - and . turned into _ (for variable names).
kit_upper() { printf '%s' "$1" | tr '[:lower:].-' '[:upper:]__'; }

# kit_words LIST: one item per line; items separated by spaces, commas or
# newlines. Empty items are dropped.
kit_words() {
  printf '%s\n' "${1:-}" | tr ',\t' '  ' | tr ' ' '\n' | sed '/^$/d'
}

# kit_in_list ITEM LIST: whether ITEM is one of LIST's words.
kit_in_list() {
  local item=$1 word
  for word in $(kit_words "${2:-}"); do
    [ "$word" = "$item" ] && return 0
  done
  return 1
}

# kit_is_name VALUE: a valid variable name (safe inside a regex).
kit_is_name() { [[ ${1:-} =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; }

# kit_is_int VALUE: a non-negative integer.
kit_is_int() { case "${1:-}" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# ------------------------------------------------------------ configuration
#
# Configuration is shell variables named KIT_*, read from, in order (later
# wins):
#
#   $KIT_HOME/lib/defaults.sh           the kit's defaults
#   .kamal/kit.env                      the project's settings (committed)
#   .kamal/kit.<destination>.env        per destination (committed)
#   .kamal/kit.local.env                personal overrides (git-ignored)
#   the environment                     KIT_*=… kit deploy …, or any variable
#                                       the files set (KT_HOST=… …)
#
# A value can also be given per destination inside any of these with a
# suffix: KIT_DEPLOY_BRANCH_STAGING=dev beats KIT_DEPLOY_BRANCH for
# `-d staging` (see kit_conf). Everything read is exported, so steps and
# group scripts see the same configuration.

# kit_project_dir: the project's root (the git top level, else the current
# directory), unless KIT_PROJECT_DIR says otherwise.
kit_project_dir() {
  if [ -n "${KIT_PROJECT_DIR:-}" ]; then
    printf '%s\n' "$KIT_PROJECT_DIR"
  else
    git rev-parse --show-toplevel 2>/dev/null || pwd
  fi
}

# kit_load_config [DESTINATION]: loads the files above. DESTINATION defaults
# to KIT_DESTINATION, then KAMAL_DESTINATION (set by Kamal for hooks).
kit_load_config() {
  local dest=${1:-${KIT_DESTINATION:-${KAMAL_DESTINATION:-}}}
  local saved="" var file

  # What the environment says wins over the files, for every variable: a
  # script that sets KT_HOST (the sandbox, a rehearsal) must never lose to
  # the real server's address in kit.local.env. Remember the environment
  # (and any KIT_* set in this shell), then put it back after the files.
  for var in $( (compgen -e; compgen -v KIT_) 2>/dev/null | sort -u); do
    case $var in KIT_HOME | KIT_LOADED | PWD | OLDPWD | SHLVL | _ | BASH_* | FUNCNAME) continue ;; esac
    kit_is_name "$var" || continue
    saved="$saved$(printf '%s=%q' "$var" "${!var-}")"$'\n'
  done

  KIT_PROJECT_DIR=$(kit_project_dir)
  KIT_CONFIG_DIR=${KIT_CONFIG_DIR:-$KIT_PROJECT_DIR/.kamal}

  set -a
  # shellcheck source=defaults.sh
  . "$KIT_HOME/lib/defaults.sh"
  for file in \
    "$KIT_CONFIG_DIR/kit.env" \
    ${dest:+"$KIT_CONFIG_DIR/kit.$dest.env"} \
    "$KIT_CONFIG_DIR/kit.local.env"; do
    if [ -f "$file" ]; then
      # shellcheck disable=SC1090
      . "$file"
    fi
  done
  # The project's own Kamal config, before -c (which comes through the
  # environment) replaces it: groups that don't name a config belong to it.
  if [ -z "${KIT_PROJECT_KAMAL_CONFIG_FILE+set}" ]; then
    KIT_PROJECT_KAMAL_CONFIG_FILE=${KIT_KAMAL_CONFIG_FILE:-}
  fi
  eval "$saved"
  set +a

  KIT_DESTINATION=$dest
  KIT_LOADED=1
  export KIT_PROJECT_DIR KIT_CONFIG_DIR KIT_DESTINATION KIT_LOADED
}

# kit_conf NAME [DEFAULT]: NAME's value for the current destination:
# NAME_<DESTINATION> if set, else NAME if set, else DEFAULT. Set to empty
# counts as set (KIT_SMOKE_URLS_STAGING= turns smoke tests off for staging).
kit_conf() {
  local name=$1 default=${2:-} scoped
  if [ -n "${KIT_DESTINATION:-}" ]; then
    scoped="${name}_$(kit_upper "$KIT_DESTINATION")"
    if [ -n "${!scoped+set}" ]; then
      printf '%s\n' "${!scoped}"
      return
    fi
  fi
  if [ -n "${!name+set}" ]; then
    printf '%s\n' "${!name}"
  else
    printf '%s\n' "$default"
  fi
}

# kit_env_get KEY FILE: KEY's value in a dotenv file, parsed, never sourced
# (a value with spaces or $ would otherwise run). One pair of surrounding
# quotes is removed, as docker and Kamal do. The last assignment wins.
kit_env_get() {
  local key=$1 file=$2 value
  kit_is_name "$key" || kit_die "not a variable name: $key"
  [ -r "$file" ] || return 1
  value=$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}${key}[[:space:]]*=//p" "$file" | tail -n 1)
  case $value in
    \"*\") value=${value#\"} && value=${value%\"} ;;
    \'*\') value=${value#\'} && value=${value%\'} ;;
  esac
  printf '%s\n' "$value"
}

# -------------------------------------------------------------- processes

# kit_timeout SECONDS COMMAND...: runs COMMAND, killing it after SECONDS
# (0 or empty: no limit). Exit status 124 on timeout, like timeout(1),
# which macOS doesn't ship. COMMAND runs in the background, so its stdin
# is /dev/null: anything interactive must read /dev/tty.
kit_timeout() {
  local secs=$1 pid watcher rc
  shift
  if ! kit_is_int "$secs" || [ "$secs" -eq 0 ]; then
    "$@"
    return
  fi
  "$@" &
  pid=$!
  (
    sleep "$secs"
    kill -TERM "$pid" 2>/dev/null && sleep 5 && kill -KILL "$pid" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 3>&- &
  watcher=$!
  rc=0
  wait "$pid" || rc=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  case $rc in 137 | 143) rc=124 ;; esac
  return "$rc"
}

# kit_wait_until TIMEOUT INTERVAL COMMAND...: runs COMMAND every INTERVAL
# seconds until it succeeds (0) or TIMEOUT seconds have passed (1).
kit_wait_until() {
  local timeout=$1 interval=$2 deadline
  shift 2
  deadline=$((SECONDS + timeout))
  while :; do
    if "$@"; then return 0; fi
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep "$interval"
  done
}

# kit_require COMMAND [HINT]: fails with a clear message when a tool is missing.
kit_require() {
  command -v "$1" >/dev/null 2>&1 || kit_die "needs '$1'${2:+ ($2)}"
}

# kit_version_being_deployed: Kamal's version in a hook (a commit id by
# default, <sha>_uncommitted_<hash> for a dirty tree, or whatever VERSION /
# --version said), else HEAD's commit.
kit_version_being_deployed() {
  if [ -n "${KAMAL_VERSION:-}" ]; then
    printf '%s\n' "$KAMAL_VERSION"
  else
    git -C "$(kit_project_dir)" rev-parse HEAD
  fi
}

# kit_is_sha VALUE: a full or abbreviated (7+) hex commit id.
kit_is_sha() {
  case "${1:-}" in
    *[!0-9a-f]* | '') return 1 ;;
    *) [ "${#1}" -ge 7 ] ;;
  esac
}

# kit_is_rollback: this hook runs for `kamal rollback`.
kit_is_rollback() { [ "${KAMAL_COMMAND:-}" = rollback ]; }
