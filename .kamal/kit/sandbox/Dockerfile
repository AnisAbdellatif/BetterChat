# deploy-kit's image: Kamal, and what the kit needs beside it. Built on
# first use as deploy-kit:<version> (the folder keeps its first name,
# sandbox/, so older kits can still `kit update` to this one). Used as:
# - the kit's runner (KIT_RUNNER=docker, docs/runner.md): Kamal and the
#   kit run here instead of on this machine; bash for the kit and its
#   hooks, curl for smoke tests and notifications, gh for the CI and
#   attestation gates, sops and age for secrets;
# - the sandbox's deployer (the same, playing the machine that deploys) and
#   its server: sshd and a Docker CLI on this machine's Docker, where the
#   deployer's Kamal deploys to (docs/sandbox.md).
ARG KAMAL_VERSION=v2.12.0
FROM ghcr.io/basecamp/kamal:${KAMAL_VERSION}
RUN apk add --no-cache bash curl github-cli sops age openssh-server openssh-sftp-server \
 && ssh-keygen -A \
 && mkdir -p /root/.ssh && chmod 700 /root/.ssh \
 && mkdir -p /home/kit && chmod 1777 /home/kit \
 && chmod 666 /etc/passwd /etc/group
# The container runs as the user running the kit, who has no account here:
# a home anyone can write to (~/.ssh is mounted into it), and an account
# the entrypoint adds, since OpenSSH's client won't run without one. Hence
# /etc/passwd and /etc/group writable: the container is thrown away after
# each run, has no setuid programs to make use of an account, and its user
# already holds Docker's socket.
ENV HOME=/home/kit
COPY entrypoint.sh /usr/local/bin/deploy-kit-entrypoint
# Kamal's image runs `kamal` by default; here the command is given, after
# the entrypoint (run by sh: a copied file may have lost its mode).
ENTRYPOINT ["/bin/sh", "/usr/local/bin/deploy-kit-entrypoint"]
CMD ["bash"]
