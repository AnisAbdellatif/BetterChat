# This project's sandbox

`kit sandbox` runs this project's deploy path (the kit, Kamal, the groups,
the hooks, the smoke tests) against a "server" on this machine, with the
services on localhost. The kit's docs/sandbox.md explains it all.

    kit sandbox up        # build the working tree, start everything, first deploy
    kit sandbox deploy    # rebuild and deploy (--group, -c as for kit deploy)
    kit sandbox status    # groups, containers, URLs
    kit sandbox down      # stop, keep the data
    kit sandbox reset     # remove it and its data

## What to fill in

1. `sandbox.env`: which Kamal configs, and the variables your Kamal
   configs read from the environment (`KIT_SANDBOX_ENV`).
2. Each Kamal config's sandbox overlay (`<config>.sandbox.yml`, written by
   `kit sandbox init` next to it): add what a role needs only locally.
3. The hooks your project needs. Rename `X.example` to `X` and make it
   executable (`chmod +x`); each runs on this machine, with:

   | Variable | |
   |---|---|
   | `KIT_SANDBOX_SERVER_DIR` | a folder here that is `KIT_SANDBOX_SERVER_PATH` on the "server" (env files your roles' `env-file` options name, etc.) |
   | `KIT_SANDBOX_WORK` | the sandbox's own folder (git-ignored), for anything to keep between runs |
   | `KIT_SANDBOX_VERSION` | the version being deployed (`sandbox-N`) |
   | `KIT_SANDBOX_NAME` | this sandbox's name, for naming your own containers |
   | `KIT_SANDBOX_REGISTRY` | the sandbox registry's address |

   | Hook | When |
   |---|---|
   | `secrets` | before the first deploy: write the secrets the containers read |
   | `services-up` | before the first deploy, and on each `up`: what Kamal doesn't run (a database, a queue, a proxy in front, fakes of outside services) |
   | `seed` | after the first deploy |
   | `urls` | printed by `up` and `status`: where things are |
   | `services-down` | on `down` |
   | `reset` | on `reset`: remove your services and their data |

4. `.kamal/kit.sandbox.env`: the kit's settings for the sandbox
   destination. Drop your own pre-deploy steps that can't work locally
   (anything reaching GitHub or a real server's checkout); the kit's gates
   already skip themselves. Smoke tests: `KIT_SMOKE_URLS_SANDBOX`.
