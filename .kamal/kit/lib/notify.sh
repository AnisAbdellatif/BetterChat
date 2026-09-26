# shellcheck shell=bash
# Notifications: Telegram, a generic webhook (Slack, Discord, Mattermost…),
# ntfy, a command of your own, or a notifier script in .kamal/notifiers/.
# Sourced after core.sh.
#
# Rules: a notification never fails the caller (a broken alert channel
# must not hide the error being reported), and says so when it went
# nowhere. Secret URLs and tokens are handed to curl on stdin, not on its
# command line, so they don't show in `ps`.

# kit_notify LEVEL MESSAGE: LEVEL is info, success, warning or error. Sent
# only when LEVEL is in KIT_NOTIFY_LEVELS.
kit_notify() {
  local level=$1 message=$2 text channels channel sent=0 levels
  levels=$(kit_conf KIT_NOTIFY_LEVELS "success warning error")
  kit_in_list "$level" "$levels" || return 0

  text="$(_kit_notify_icon "$level") $(_kit_notify_prefix)$message"
  channels=$(kit_conf KIT_NOTIFY "")
  [ -n "$channels" ] || channels=$(_kit_notify_configured)

  for channel in $(kit_words "$channels"); do
    if _kit_notify_send "$channel" "$level" "$text" "$message"; then
      sent=$((sent + 1))
    else
      kit_warn "could not notify via $channel"
    fi
  done

  if [ "$sent" -eq 0 ] && [ "$level" != info ] && [ "$level" != success ]; then
    kit_warn "no notification channel configured: this $level went nowhere"
  fi
  return 0
}

# kit_ping URL: a heartbeat (dead man's switch, e.g. healthchecks.io). Never fails.
kit_ping() {
  [ -n "${1:-}" ] || return 0
  _kit_curl_secret_url "$1" -fsS -m 20 -o /dev/null || kit_warn "could not ping the heartbeat URL"
  return 0
}

# ----------------------------------------------------------------- private

_kit_notify_icon() {
  case $1 in
    success) printf '✅' ;;
    warning) printf '⚠️' ;;
    error) printf '🔴' ;;
    *) printf 'ℹ️' ;;
  esac
}

# "[app/destination] ", from KIT_NOTIFY_PREFIX or Kamal's service name.
_kit_notify_prefix() {
  local prefix
  prefix=$(kit_conf KIT_NOTIFY_PREFIX "")
  if [ -z "$prefix" ]; then
    prefix=${KAMAL_SERVICE:-$(basename "$(kit_project_dir)")}
    [ -n "${KIT_DESTINATION:-}" ] && prefix="$prefix/$KIT_DESTINATION"
  fi
  printf '[%s] ' "$prefix"
}

# The channels whose settings are present.
_kit_notify_configured() {
  [ -n "$(kit_conf KIT_TELEGRAM_BOT_TOKEN)" ] && [ -n "$(kit_conf KIT_TELEGRAM_CHAT_ID)" ] && echo telegram
  [ -n "$(kit_conf KIT_WEBHOOK_URL)" ] && echo webhook
  [ -n "$(kit_conf KIT_NTFY_URL)" ] && echo ntfy
  [ -n "$(kit_conf KIT_NOTIFY_COMMAND)" ] && echo command
  return 0
}

_kit_notify_send() {
  local channel=$1 level=$2 text=$3 message=$4 script
  case $channel in
    telegram)
      _kit_curl_secret_url "https://api.telegram.org/bot$(kit_conf KIT_TELEGRAM_BOT_TOKEN)/sendMessage" \
        -fsS -m 20 -o /dev/null \
        --data-urlencode "chat_id=$(kit_conf KIT_TELEGRAM_CHAT_ID)" \
        --data-urlencode "text=$text"
      ;;
    webhook)
      local json
      json=$(_kit_json_string "$text")
      _kit_curl_secret_url "$(kit_conf KIT_WEBHOOK_URL)" -fsS -m 20 -o /dev/null \
        -H 'content-type: application/json' \
        -d "{\"text\":$json,\"content\":$json}"
      ;;
    ntfy)
      local token priority
      local args=(-fsS -m 20 -o /dev/null)
      token=$(kit_conf KIT_NTFY_TOKEN)
      case $level in error) priority=high ;; warning) priority=default ;; *) priority=low ;; esac
      args+=(-H "Priority: $priority" -H "Tags: deploy,$level")
      KIT_CURL_SECRET_HEADER=${token:+"Authorization: Bearer $token"} \
        _kit_curl_secret_url "$(kit_conf KIT_NTFY_URL)" "${args[@]}" --data-binary "$text"
      ;;
    command)
      KIT_NOTIFY_LEVEL=$level KIT_NOTIFY_MESSAGE=$message KIT_NOTIFY_TEXT=$text \
        bash -c "$(kit_conf KIT_NOTIFY_COMMAND)" </dev/null >/dev/null 2>&1
      ;;
    *)
      # A notifier of the project's own: .kamal/notifiers/<channel> LEVEL TEXT
      script="${KIT_CONFIG_DIR:-.kamal}/notifiers/$channel"
      if [ -x "$script" ]; then
        KIT_NOTIFY_LEVEL=$level KIT_NOTIFY_MESSAGE=$message KIT_NOTIFY_TEXT=$text \
          "$script" "$level" "$text" </dev/null >/dev/null 2>&1
      else
        kit_warn "unknown notification channel '$channel' (no $script)"
        return 1
      fi
      ;;
  esac
}

# _kit_curl_secret_url URL CURL-ARGS...: curl with the URL (and the header
# in KIT_CURL_SECRET_HEADER, if any) passed in a config on stdin, so they
# aren't visible in the process list.
_kit_curl_secret_url() {
  local url=$1
  shift
  command -v curl >/dev/null 2>&1 || {
    kit_warn "curl missing: notification not sent"
    return 1
  }
  {
    printf 'url = "%s"\n' "$(_kit_curl_quote "$url")"
    if [ -n "${KIT_CURL_SECRET_HEADER:-}" ]; then
      printf 'header = "%s"\n' "$(_kit_curl_quote "$KIT_CURL_SECRET_HEADER")"
    fi
  } | curl -K - "$@" >/dev/null 2>&1
}

_kit_curl_quote() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# _kit_json_string TEXT: TEXT as a JSON string literal.
_kit_json_string() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -Rs .
  else
    printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r\t' '   ')"
  fi
}
