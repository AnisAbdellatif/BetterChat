# shellcheck shell=bash
# The hook dispatcher: `kit hook <name>`, which every .kamal/hooks/<name>
# shim runs. Sourced after core.sh and notify.sh.
#
# A hook runs, in order:
#   1. the steps listed in KIT_HOOK_<NAME> (e.g. KIT_HOOK_PRE_DEPLOY), each
#      a project step (.kamal/steps/<step>), a kit step (steps/<step>), or a
#      path relative to the project;
#   2. every executable in .kamal/hooks.d/<name>/, in name order.
# The first failing step fails the hook (and so Kamal's command), after a
# notification saying which step failed and why.
#
# Kamal hands hooks its secrets in the environment: steps must never print
# or send the environment.

# kit_hook_run NAME: runs hook NAME. Unknown hook names work too (a hook
# Kamal adds later just needs a shim and a KIT_HOOK_ list).
kit_hook_run() {
  local hook=$1 var steps step path skip reason rc started

  # A kamal command run from inside a step (a migration through `kamal app
  # exec`, say) would run pre-connect again: the outer command's hooks
  # already ran, so nested ones do nothing.
  if [ -n "${KIT_IN_HOOK:-}" ]; then
    return 0
  fi
  export KIT_IN_HOOK=$hook

  var="KIT_HOOK_$(kit_upper "$hook")"
  steps=$(kit_conf "$var" "")
  skip=$(kit_conf KIT_SKIP "")
  reason=$(kit_conf KIT_SKIP_REASON "")

  for step in $(kit_words "$steps") $(_kit_hook_local_steps "$hook"); do
    if kit_in_list "$(basename "$step")" "$skip"; then
      kit_skip_reason_check || return 1
      kit_warn "$hook: skipping $step (KIT_SKIP${reason:+: $reason})"
      # Once per kit run: each group's deploy runs the hooks again.
      if _kit_skip_first "$(basename "$step")"; then
        kit_notify warning "$hook: step $(basename "$step") skipped by KIT_SKIP${reason:+ (\"$reason\")}, by ${KAMAL_PERFORMER:-${USER:-unknown}}"
      fi
      continue
    fi

    path=$(_kit_hook_resolve "$step") || {
      kit_error "$hook: no step named '$step' (looked in .kamal/steps/, the kit's steps/, and as a path)"
      kit_notify error "$hook: no step named '$step'"
      return 1
    }

    if _kit_hook_cached "$hook" "$step"; then
      kit_info "$hook: $step already passed in this run"
      continue
    fi

    started=$SECONDS
    rc=0
    KIT_HOOK=$hook KIT_STEP=$step kit_timeout "$(kit_conf KIT_STEP_TIMEOUT 600)" "$path" || rc=$?
    if [ "$rc" -ne 0 ]; then
      if [ "$rc" -eq 124 ]; then
        kit_error "$hook: $step timed out after $((SECONDS - started))s"
      else
        kit_error "$hook: $step failed (exit $rc)"
      fi
      kit_notify error "${KAMAL_COMMAND:-deploy} stopped: $hook step '$step' failed (version ${KAMAL_SERVICE_VERSION:-${KAMAL_VERSION:-?}}, by ${KAMAL_PERFORMER:-unknown})"
      return "$rc"
    fi
    _kit_hook_cache "$hook" "$step"
  done
  return 0
}

# kit_skip_reason_check: when KIT_SKIP skips anything, KIT_SKIP_REASON must
# say why if KIT_SKIP_REASON_REQUIRED (e.g. _PRODUCTION) is on.
kit_skip_reason_check() {
  [ -n "$(kit_conf KIT_SKIP "")" ] || return 0
  [ -z "$(kit_conf KIT_SKIP_REASON "")" ] || return 0
  kit_is_true "$(kit_conf KIT_SKIP_REASON_REQUIRED false)" || return 0
  kit_error "skipping steps${KIT_DESTINATION:+ on $KIT_DESTINATION} needs a reason: KIT_SKIP_REASON=\"why\" (KIT_SKIP_REASON_REQUIRED)"
  return 1
}

# _kit_skip_first STEP: true the first time STEP is skipped in this kit run
# (always, outside one).
_kit_skip_first() {
  [ -n "${KIT_RUN_DIR:-}" ] && [ -d "$KIT_RUN_DIR" ] || return 0
  [ ! -f "$KIT_RUN_DIR/skipped-$1" ] || return 1
  : >"$KIT_RUN_DIR/skipped-$1"
}

# The project's own scripts for this hook, in name order.
_kit_hook_local_steps() {
  local dir="$KIT_CONFIG_DIR/hooks.d/$1" file
  [ -d "$dir" ] || return 0
  for file in "$dir"/*; do
    [ -f "$file" ] && [ -x "$file" ] && printf '%s\n' "$file"
  done
  return 0
}

# _kit_hook_resolve STEP: the executable to run for STEP.
_kit_hook_resolve() {
  local step=$1
  case $step in
    /*) [ -x "$step" ] && printf '%s\n' "$step" && return 0 ;;
    */*) [ -x "$KIT_PROJECT_DIR/$step" ] && printf '%s\n' "$KIT_PROJECT_DIR/$step" && return 0 ;;
    *)
      if [ -x "$KIT_CONFIG_DIR/steps/$step" ]; then
        printf '%s\n' "$KIT_CONFIG_DIR/steps/$step"
        return 0
      fi
      if [ -x "$KIT_HOME/steps/$step" ]; then
        printf '%s\n' "$KIT_HOME/steps/$step"
        return 0
      fi
      ;;
  esac
  return 1
}

# Within one `kit deploy` (KIT_RUN_DIR set), a gate that passed for this
# version isn't run again by the next `kamal deploy -r …` of the same run:
# CI is asked once, and the confirmation is asked once.
_kit_hook_cache_file() {
  printf '%s/passed-%s-%s' "$KIT_RUN_DIR" "$(basename "$2")" "${KAMAL_VERSION:-none}"
}

_kit_hook_cached() {
  [ -n "${KIT_RUN_DIR:-}" ] || return 1
  kit_in_list "$(basename "$2")" "$(kit_conf KIT_CACHED_STEPS "")" || return 1
  [ -f "$(_kit_hook_cache_file "$1" "$2")" ]
}

_kit_hook_cache() {
  [ -n "${KIT_RUN_DIR:-}" ] && [ -d "$KIT_RUN_DIR" ] || return 0
  kit_in_list "$(basename "$2")" "$(kit_conf KIT_CACHED_STEPS "")" || return 0
  : >"$(_kit_hook_cache_file "$1" "$2")"
}
