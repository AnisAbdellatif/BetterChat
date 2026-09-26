# shellcheck shell=bash
# Sourced by every step: the kit's libraries and the configuration (already
# loaded and exported when the step runs from `kit hook`).
set -euo pipefail
KIT_HOME=${KIT_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
# shellcheck source=../lib/core.sh
. "$KIT_HOME/lib/core.sh"
# shellcheck source=../lib/notify.sh
. "$KIT_HOME/lib/notify.sh"
[ -n "${KIT_LOADED:-}" ] || kit_load_config
