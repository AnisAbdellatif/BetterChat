# Project hook steps

Executables in `hooks.d/<hook>/` run after the kit's steps for that hook
(`KIT_HOOK_<HOOK>` in `.kamal/kit.env`), in name order: `10-migrate`,
`20-warm-cache`. A non-zero exit stops the Kamal command (for `pre-*`
hooks).

Hooks: `pre-connect`, `pre-build`, `pre-deploy`, `post-deploy`,
`pre-app-boot`, `post-app-boot`, `pre-proxy-reboot`, `post-proxy-reboot`,
`docker-setup`.

They get Kamal's variables (`KAMAL_VERSION`, `KAMAL_DESTINATION`,
`KAMAL_ROLES`, `KAMAL_COMMAND`, …, and Kamal's secrets: never print the
environment), the kit's configuration (`KIT_*`), and `KIT` (the kit's
command). Calls to `kamal` from a step don't run hooks again.

Example, `pre-deploy/10-migrate`:

```sh
#!/bin/sh
set -e
# Migrations from the image being deployed, before any container switches.
kamal app exec -H -p -q ${KAMAL_DESTINATION:+-d "$KAMAL_DESTINATION"} \
  --version "$KAMAL_VERSION" "bin/migrate"
```

A step reused across hooks can live in `.kamal/steps/<name>` and be listed
by name in `KIT_HOOK_*`; a project step with a kit step's name replaces it.
