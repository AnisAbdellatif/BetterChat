# shellcheck shell=bash
# Groups: roles deployed together by a strategy instead of all at once.
# Sourced after core.sh, notify.sh and kamal.sh. docs/groups.md explains
# them; this is the engine.
#
# A group is a folder, .kamal/groups/<name>/, holding group.env and,
# optionally, scripts the strategy calls:
#
#   active     exit 0 if $KIT_ROLE is the active one (standby: required)
#   healthy    exit 0 if $KIT_ROLE is healthy (default: its container runs)
#   handover   make $KIT_TO active instead of $KIT_FROM (default: restart
#              $KIT_FROM in place on its own build; its clean stop hands over)
#   before, after              around the whole group deploy
#   before-role, after-role    around each role's deploy ($KIT_ROLE)
#
# Instead of a script, group.env may set KIT_GROUP_<SCRIPT>_CMD to a shell
# one-liner (KIT_GROUP_ACTIVE_CMD, KIT_GROUP_BEFORE_ROLE_CMD…).
#
# Strategies:
#   standby   two roles, one active. A deploy updates the standby only,
#             waits until it's healthy, then hands over; the old active
#             stays on the previous build as the new standby, so rolling
#             back is handing back (`kit group switch`).
#   rolling   any number of roles (alias: pair), updated one at a time,
#             each healthy before the next; the rest keep serving.
#
# Each group runs in its own `kit` process, so one group's settings never
# leak into another's.

# kit_group_dir NAME
kit_group_dir() { printf '%s/groups/%s\n' "$KIT_CONFIG_DIR" "$1"; }

# kit_group_names_all: every group, in KIT_GROUP_ORDER, then the rest
# alphabetically, whatever Kamal config it belongs to.
kit_group_names_all() {
  local dir name order seen=""
  order=$(kit_conf KIT_GROUP_ORDER "")
  for name in $(kit_words "$order"); do
    [ -f "$(kit_group_dir "$name")/group.env" ] || kit_die "KIT_GROUP_ORDER names '$name', which has no .kamal/groups/$name/group.env"
    printf '%s\n' "$name"
    seen="$seen $name"
  done
  for dir in "$KIT_CONFIG_DIR"/groups/*/; do
    [ -f "$dir/group.env" ] || continue
    name=$(basename "$dir")
    kit_in_list "$name" "$seen" || printf '%s\n' "$name"
  done
}

# kit_group_names: the groups of the Kamal config in use (KIT_KAMAL_CONFIG_FILE,
# -c). A group belongs to the config named by KIT_GROUP_KAMAL_CONFIG_FILE in
# its group.env; when unset, to the project's config (KIT_KAMAL_CONFIG_FILE
# in .kamal/kit.env, else Kamal's config/deploy.yml). A project with
# several Kamal configs (one per image, say) has groups for each.
kit_group_names() {
  local current name
  current=$(kit_config_file "$(kit_conf KIT_KAMAL_CONFIG_FILE "")")
  for name in $(kit_group_names_all); do
    [ "$(kit_group_config_file "$name")" = "$current" ] && printf '%s\n' "$name"
  done
  return 0
}

# kit_config_file [FILE]: a Kamal config path as the kit compares them
# (empty means Kamal's default, config/deploy.yml; a leading ./ dropped).
kit_config_file() {
  local file=${1:-config/deploy.yml}
  printf '%s\n' "${file#./}"
}

# kit_group_config_file NAME: the Kamal config the group belongs to.
kit_group_config_file() {
  local file
  file=$(kit_env_get KIT_GROUP_KAMAL_CONFIG_FILE "$(kit_group_dir "$1")/group.env" || true)
  kit_config_file "${file:-${KIT_PROJECT_KAMAL_CONFIG_FILE:-}}"
}

# kit_config_service FILE: the `service:` a Kamal config names (empty if the
# file can't be read). Kamal passes it to hooks as KAMAL_SERVICE.
kit_config_service() {
  local file=$1
  case $file in /*) ;; *) file="$KIT_PROJECT_DIR/$file" ;; esac
  [ -r "$file" ] || return 0
  kit_yaml_get service "$file" || true
}

# kit_group_roles_of NAME: a group's roles, read without loading it.
kit_group_roles_of() {
  kit_words "$(kit_env_get KIT_GROUP_ROLES "$(kit_group_dir "$1")/group.env")"
}

# kit_group_load NAME: reads group.env over the defaults and checks it.
kit_group_load() {
  local name=$1 dir count
  dir=$(kit_group_dir "$name")
  [ -f "$dir/group.env" ] || kit_die "no group '$name' (.kamal/groups/$name/group.env)"

  KIT_GROUP=$name
  KIT_GROUP_DIR=$dir
  set -a
  # shellcheck disable=SC1091
  . "$dir/group.env"
  set +a
  export KIT_GROUP KIT_GROUP_DIR
  # A group of another Kamal config brings its config along, so
  # `kit group deploy <name>` works without -c.
  if [ -n "${KIT_GROUP_KAMAL_CONFIG_FILE:-}" ]; then
    export KIT_KAMAL_CONFIG_FILE=$KIT_GROUP_KAMAL_CONFIG_FILE
  fi

  case "${KIT_GROUP_STRATEGY:-}" in
    standby) ;;
    rolling | pair) KIT_GROUP_STRATEGY=rolling ;;
    *) kit_die "group $name: KIT_GROUP_STRATEGY must be standby or rolling (is '${KIT_GROUP_STRATEGY:-}')" ;;
  esac

  count=$(kit_words "${KIT_GROUP_ROLES:-}" | wc -l | tr -d ' ')
  [ "$count" -ge 1 ] || kit_die "group $name: KIT_GROUP_ROLES is empty"
  if [ "$KIT_GROUP_STRATEGY" = standby ]; then
    [ "$count" -eq 2 ] || kit_die "group $name: a standby group has exactly two roles (has $count)"
    _kit_group_has active || kit_die "group $name: a standby group needs an 'active' script or KIT_GROUP_ACTIVE_CMD"
  fi
}

# ---------------------------------------------------------------- scripts

# _kit_group_has SCRIPT: the group defines SCRIPT.
_kit_group_has() {
  local var
  var="KIT_GROUP_$(kit_upper "$1")_CMD"
  [ -x "$KIT_GROUP_DIR/$1" ] || [ -n "${!var:-}" ]
}

# _kit_group_call SCRIPT [VAR=VALUE...]: runs the group's SCRIPT with the
# given variables. Returns 0 when the group doesn't define it.
_kit_group_call() {
  local script=$1 var
  shift
  var="KIT_GROUP_$(kit_upper "$script")_CMD"
  if [ -x "$KIT_GROUP_DIR/$script" ]; then
    env "$@" "$KIT_GROUP_DIR/$script"
  elif [ -n "${!var:-}" ]; then
    env "$@" bash -c "${!var}"
  else
    return 0
  fi
}

# kit_group_is_active ROLE
kit_group_is_active() { _kit_group_call active KIT_ROLE="$1" >/dev/null 2>&1; }

# kit_group_is_healthy ROLE: the group's check, else "its container runs".
kit_group_is_healthy() {
  if _kit_group_has healthy; then
    _kit_group_call healthy KIT_ROLE="$1" >/dev/null 2>&1
  else
    kit_role_exec "$1" true >/dev/null 2>&1
  fi
}

# kit_group_handover FROM TO: the group's handover, else restart FROM in
# place on the build it runs: its clean stop releases whatever makes it
# active (a lease, a lock) to TO, which must already be healthy.
kit_group_handover() {
  local from=$1 to=$2 from_version
  from_version=$(kit_role_version "$from")
  if _kit_group_has handover; then
    _kit_group_call handover KIT_FROM="$from" KIT_TO="$to" KIT_FROM_VERSION="$from_version"
  else
    [ -n "$from_version" ] || {
      kit_error "$from isn't running: nothing to hand over from"
      return 1
    }
    kit_kamal app stop -H -r "$from" &&
      kit_kamal app start -H -r "$from" --version "$from_version"
  fi
}

# ----------------------------------------------------------------- waiting

_kit_group_timeout() { kit_conf "$1" "$2"; }

kit_group_wait_healthy() {
  local role=$1
  kit_info "waiting for $role to be healthy…"
  kit_wait_until "$(_kit_group_timeout KIT_GROUP_HEALTH_TIMEOUT 180)" "$(kit_conf KIT_GROUP_INTERVAL 2)" \
    kit_group_is_healthy "$role"
}

_kit_group_switched_to() { kit_group_is_active "$1" && ! kit_group_is_active "$2"; }

kit_group_wait_switched() {
  local to=$1 from=$2
  kit_info "waiting for $to to take over from $from…"
  kit_wait_until "$(_kit_group_timeout KIT_GROUP_SWITCH_TIMEOUT 90)" "$(kit_conf KIT_GROUP_INTERVAL 2)" \
    _kit_group_switched_to "$to" "$from"
}

# kit_group_active_role: the one active role; fails (1: none, 2: several).
kit_group_active_role() {
  local role active="" count=0
  for role in $(kit_words "$KIT_GROUP_ROLES"); do
    if kit_group_is_active "$role"; then
      active=$role
      count=$((count + 1))
    fi
  done
  [ "$count" -eq 1 ] && printf '%s\n' "$active" && return 0
  [ "$count" -eq 0 ] && return 1
  return 2
}

_kit_group_other() {
  local role
  for role in $(kit_words "$KIT_GROUP_ROLES"); do
    [ "$role" != "$1" ] && printf '%s\n' "$role" && return 0
  done
}

# -------------------------------------------------------------- deploying

# _kit_group_deploy_role ROLE KAMAL-DEPLOY-ARGS...: stop first (if set),
# deploy ROLE alone, wait until healthy. The deploy runs Kamal's hooks (the
# gates); KIT_GROUP_DEPLOY tells the role guard this deploy is the group's.
_kit_group_deploy_role() {
  local role=$1
  shift
  _kit_group_call before-role KIT_ROLE="$role" || {
    kit_error "$KIT_GROUP: before-role failed for $role"
    return 1
  }
  if kit_is_true "$(kit_conf KIT_GROUP_STOP_FIRST true)" && [ -n "$(kit_role_version "$role")" ]; then
    kit_info "stopping $role before replacing it (no overlap on its volumes and ports)"
    kit_kamal app stop -H -r "$role" || return 1
  fi
  kit_info "deploying $role"
  KIT_GROUP_DEPLOY=$KIT_GROUP kit_kamal deploy -r "$role" "$@" || {
    kit_error "$KIT_GROUP: deploying $role failed"
    return 1
  }
  kit_group_wait_healthy "$role" || {
    kit_error "$KIT_GROUP: $role did not become healthy"
    return 1
  }
  _kit_group_call after-role KIT_ROLE="$role" || {
    kit_error "$KIT_GROUP: after-role failed for $role"
    return 1
  }
}

# kit_group_deploy [--bootstrap] [KAMAL-DEPLOY-ARGS...]
kit_group_deploy() {
  local bootstrap=false
  if [ "${1:-}" = --bootstrap ]; then
    bootstrap=true
    shift
  fi
  _kit_group_call before || kit_die "$KIT_GROUP: 'before' failed; nothing deployed"
  case $KIT_GROUP_STRATEGY in
    standby) _kit_group_deploy_standby "$bootstrap" "$@" || return 1 ;;
    # (--bootstrap means nothing to a rolling group: each role is deployed.)
    rolling) _kit_group_deploy_rolling "$@" || return 1 ;;
  esac
  _kit_group_call after || {
    kit_warn "$KIT_GROUP: 'after' failed (the deploy itself succeeded)"
    kit_notify warning "$KIT_GROUP: deployed, but its 'after' script failed"
  }
  return 0
}

_kit_group_deploy_standby() {
  local bootstrap=$1 active rc=0 standby previous version
  shift

  active=$(kit_group_active_role) || rc=$?
  if [ "$rc" -eq 2 ]; then
    kit_notify error "$KIT_GROUP: more than one role says it is active; not deploying"
    kit_die "$KIT_GROUP: more than one role says it is active (split brain?); fix that before deploying"
  fi

  if [ "$rc" -eq 1 ]; then
    if [ "$bootstrap" != true ]; then
      kit_notify error "$KIT_GROUP: no role is active; not deploying"
      kit_die "$KIT_GROUP: no role is active. First deploy? Run: kit group deploy $KIT_GROUP --bootstrap"
    fi
    local role
    for role in $(kit_words "$KIT_GROUP_ROLES"); do
      _kit_group_deploy_role "$role" "$@" || return 1
    done
    if kit_wait_until "$(_kit_group_timeout KIT_GROUP_SWITCH_TIMEOUT 90)" "$(kit_conf KIT_GROUP_INTERVAL 2)" \
      kit_group_active_role >/dev/null; then
      kit_ok "$KIT_GROUP: bootstrapped; $(kit_group_active_role) is active"
      return 0
    fi
    kit_error "$KIT_GROUP: both roles deployed, but none became active"
    return 1
  fi

  standby=$(_kit_group_other "$active")
  previous=$(kit_role_version "$standby")
  kit_info "$KIT_GROUP: $active is active; updating $standby"

  if ! _kit_group_deploy_role "$standby" "$@"; then
    _kit_group_restore "$standby" "$previous"
    kit_notify error "$KIT_GROUP: $standby failed to deploy; $active is still active on its build, nothing switched"
    return 1
  fi

  version=$(kit_role_version "$standby")
  kit_info "$KIT_GROUP: handing over from $active to $standby"
  if kit_group_handover "$active" "$standby" && kit_group_wait_switched "$standby" "$active"; then
    kit_ok "$KIT_GROUP: $standby is active on ${version:-the new build}; $active stands by on the previous build"
    return 0
  fi

  kit_error "$KIT_GROUP: $standby did not take over from $active"
  if [ "$(kit_conf KIT_GROUP_ON_SWITCH_FAILURE report)" = switch-back ]; then
    kit_warn "$KIT_GROUP: handing back to $active"
    kit_group_handover "$standby" "$active" && kit_group_wait_switched "$active" "$standby" &&
      kit_warn "$KIT_GROUP: $active is active again"
  fi
  kit_notify error "$KIT_GROUP: handover from $active to $standby failed; check \`kit group status $KIT_GROUP\`"
  return 1
}

# A role that failed on its new build goes back to its previous one, when
# KIT_GROUP_RESTORE_ON_FAILURE is set (off by default: a broken standby
# isn't active anyway, and its logs say why; for a rolling group, turn it
# on so the failed role serves again).
_kit_group_restore() {
  local role=$1 previous=$2
  kit_is_true "$(kit_conf KIT_GROUP_RESTORE_ON_FAILURE false)" || return 0
  [ -n "$previous" ] || return 0
  kit_warn "$KIT_GROUP: restoring $role to $previous"
  kit_group_rollback_role "$role" "$previous" ||
    kit_warn "$KIT_GROUP: could not restore $role to $previous"
}

# kit_group_rollback_role ROLE VERSION: puts ROLE (of the loaded group)
# back on VERSION. Kamal's rollback starts the old container before
# stopping the new one, so, as for a deploy, the role is stopped first when
# KIT_GROUP_STOP_FIRST is set: otherwise both want its published port. A
# role already on VERSION is left alone (rolling back onto the running
# build would replace a container with a copy of itself).
kit_group_rollback_role() {
  local role=$1 version=$2 current
  current=$(kit_role_version "$role")
  if [ "$current" = "$version" ]; then
    kit_info "$role already runs $version: nothing to roll back"
    return 0
  fi
  if kit_is_true "$(kit_conf KIT_GROUP_STOP_FIRST true)" && [ -n "$current" ]; then
    kit_kamal app stop -H -r "$role" || return 1
  fi
  KIT_GROUP_DEPLOY=$KIT_GROUP kit_kamal rollback -H -r "$role" "$version"
}

_kit_group_deploy_rolling() {
  local order="" role active=""
  if [ "$(kit_conf KIT_GROUP_ROLLING_ORDER listed)" = inactive-first ] && _kit_group_has active; then
    for role in $(kit_words "$KIT_GROUP_ROLES"); do
      if kit_group_is_active "$role"; then active="$active $role"; else order="$order $role"; fi
    done
    order="$order $active"
  else
    order=$KIT_GROUP_ROLES
  fi

  local done_roles="" previous
  for role in $(kit_words "$order"); do
    previous=$(kit_role_version "$role")
    if ! _kit_group_deploy_role "$role" "$@"; then
      _kit_group_restore "$role" "$previous"
      kit_notify error "$KIT_GROUP: rolling deploy stopped at $role;${done_roles:+ updated:$done_roles;} the rest keep their build"
      return 1
    fi
    done_roles="$done_roles $role"
  done
  kit_ok "$KIT_GROUP: updated$done_roles"
}

# kit_group_switch [TO]: hands over to TO (default: the standby). Standby only.
kit_group_switch() {
  local to=${1:-} active rc=0
  [ "$KIT_GROUP_STRATEGY" = standby ] || kit_die "$KIT_GROUP: switch is for standby groups"
  active=$(kit_group_active_role) || rc=$?
  [ "$rc" -eq 0 ] || kit_die "$KIT_GROUP: can't switch: $([ "$rc" -eq 1 ] && echo "no role is active" || echo "more than one role is active")"
  [ -n "$to" ] || to=$(_kit_group_other "$active")
  kit_in_list "$to" "$KIT_GROUP_ROLES" || kit_die "$KIT_GROUP: $to isn't one of its roles"
  if [ "$to" = "$active" ]; then
    kit_ok "$KIT_GROUP: $to is already active"
    return 0
  fi
  kit_group_is_healthy "$to" || kit_die "$KIT_GROUP: $to isn't healthy; not switching to it"
  if kit_group_handover "$active" "$to" && kit_group_wait_switched "$to" "$active"; then
    kit_ok "$KIT_GROUP: $to is active ($(kit_role_version "$to")); $active stands by"
    kit_notify success "$KIT_GROUP: switched to $to; $active stands by"
    return 0
  fi
  kit_notify error "$KIT_GROUP: switch from $active to $to failed"
  kit_die "$KIT_GROUP: $to did not take over from $active"
}

# kit_group_status: each role's version, health and (if known) activity.
kit_group_status() {
  local role version health activity
  printf '%s (%s)\n' "$KIT_GROUP" "$KIT_GROUP_STRATEGY"
  for role in $(kit_words "$KIT_GROUP_ROLES"); do
    version=$(kit_role_version "$role")
    if kit_group_is_healthy "$role"; then health=healthy; else health=unhealthy; fi
    activity=""
    if _kit_group_has active; then
      if kit_group_is_active "$role"; then activity=active; else activity=standby; fi
    fi
    printf '  %-20s %-14s %-10s %s\n' "$role" "${version:-(not running)}" "$health" "$activity"
  done
}
