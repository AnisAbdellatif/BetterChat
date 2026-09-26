# shellcheck shell=bash
# sops helpers. Sourced after core.sh.
#
# With Kamal, secrets are read on the machine that deploys, in
# .kamal/secrets[.<destination>], which may run commands:
#
#   DATABASE_URL=$(.kamal/kit/bin/kit sops get config/secrets/production.sops.env DATABASE_URL)
#
# kit_sops_decrypt_dir is for files decrypted on a server (cron scripts,
# a compose stack next to Kamal), written so a failed decryption leaves the
# running configuration as it was.

# The --input-type/--output-type sops needs for FILE (dotenv files are
# named *.env; others go by their extension, which sops recognises).
_kit_sops_types() {
  case $1 in
    *.env) printf '%s\n' "--input-type dotenv --output-type dotenv" ;;
    *) printf '\n' ;;
  esac
}

# kit_sops_env FILE: FILE decrypted, to stdout.
kit_sops_env() {
  local file=$1 types
  kit_require sops "https://github.com/getsops/sops"
  [ -f "$file" ] || kit_die "no such file: $file"
  types=$(_kit_sops_types "$file")
  # shellcheck disable=SC2086
  sops --decrypt $types "$file"
}

# kit_sops_get FILE KEY: one value from an encrypted dotenv file. Fails if
# KEY isn't there (a secret missing must not become an empty string).
kit_sops_get() {
  local file=$1 key=$2 plain value
  kit_is_name "$key" || kit_die "not a variable name: $key"
  plain=$(kit_sops_env "$file") || kit_die "could not decrypt $file (is your age key in place?)"
  if ! printf '%s\n' "$plain" | grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*="; then
    kit_die "$key isn't set in $file"
  fi
  value=$(printf '%s\n' "$plain" | sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}${key}[[:space:]]*=//p" | tail -n 1)
  case $value in
    \"*\") value=${value#\"} && value=${value%\"} ;;
    \'*\') value=${value#\'} && value=${value%\'} ;;
  esac
  printf '%s\n' "$value"
}

# kit_sops_decrypt_dir DIR: every DIR/*.sops.* becomes the same name without
# ".sops" (app.sops.env -> app.env), mode 0600. All are decrypted to
# temporary files first; only if every one worked are they moved into place.
kit_sops_decrypt_dir() {
  local dir=$1 file out outs="" failed=0
  kit_require sops "https://github.com/getsops/sops"
  for file in "$dir"/*.sops.*; do
    [ -f "$file" ] || continue
    out=$(printf '%s' "$file" | sed 's/\.sops\././')
    if (umask 077 && kit_sops_env "$file" >"$out.new"); then
      outs="$outs $out"
    else
      kit_error "could not decrypt $file"
      rm -f "$out.new"
      failed=1
    fi
  done
  if [ "$failed" -ne 0 ]; then
    for out in $outs; do rm -f "$out.new"; done
    kit_die "nothing replaced: the configuration in place is unchanged"
  fi
  for out in $outs; do
    mv "$out.new" "$out"
    kit_ok "decrypted ${out#"$dir"/}"
  done
}
