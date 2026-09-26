#!/bin/sh
# The kit's image's entrypoint: gives the user it runs as an account, then
# runs the command. The kit runs the image as the user running the kit
# (`--user $(id -u):$(id -g)`), whose uid the image has never heard of,
# and OpenSSH's client refuses to run without a passwd entry ("No user
# exists for uid …"): git fetching over SSH (the require-pushed gate),
# hooks calling ssh. It also reads ~/.ssh from the entry's home, not $HOME,
# so the entry's home is $HOME (/home/kit, where ~/.ssh is mounted), even
# for a uid the image already has. Root is left as it is (the sandbox's
# server runs sshd as root, with root's own home). The Dockerfile leaves
# /etc/passwd and /etc/group writable for this; in an image that doesn't,
# nothing changes.
set -u
uid=$(id -u)
gid=$(id -g)
home=${HOME:-/home/kit}

if [ "$uid" != 0 ] && [ -w /etc/passwd ] &&
  [ "$(getent passwd "$uid" | cut -d: -f6)" != "$home" ]; then
  others=$(grep -v "^[^:]*:[^:]*:$uid:" /etc/passwd)
  printf '%s\nkit:x:%s:%s:deploy-kit:%s:/bin/sh\n' "$others" "$uid" "$gid" "$home" >/etc/passwd
fi
if ! getent group "$gid" >/dev/null && [ -w /etc/group ]; then
  printf 'kit:x:%s:\n' "$gid" >>/etc/group
fi

exec "$@"
