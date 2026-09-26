# shellcheck shell=bash
# Reading YAML: what `kamal config` prints (Kamal's view of a config, with
# its destination merged and its ERB evaluated), and Kamal configs as
# written. lib/yaml.awk does the reading, and describes what it reads and
# what it refuses. Sourced by core.sh.
#
# Each function reads FILE, or stdin without one. Exit status: 0 found,
# 1 PATH isn't there, 3 it can't be read (the reader says why on stderr).
# PATH is keys joined with dots (builder.args); Ruby's symbol keys
# (":ssh_options:") are named without their colon.

# kit_yaml_get PATH [FILE]: a value; a list's values, one per line; or a
# map's values, as KEY=VALUE lines.
kit_yaml_get() { _kit_yaml get "$@"; }

# kit_yaml_keys PATH [FILE]: a map's keys, one per line.
kit_yaml_keys() { _kit_yaml keys "$@"; }

# kit_yaml_type PATH [FILE]: map, list, value or alias.
kit_yaml_type() { _kit_yaml type "$@"; }

_kit_yaml() {
  local mode=$1 path=$2
  shift 2
  awk -v mode="$mode" -v path="$path" -f "$KIT_HOME/lib/yaml.awk" "$@"
}
