#!/system/bin/sh
set -eu

action=${1:---help}
if test "$action" = --help; then
  printf 'Usage: phone-native.sh install|check|start|stop|status|web-access TAILSCALE_IP LAN_IP\n'
  exit 0
fi

export PATH=/data/data/com.termux/files/usr/bin:/system/bin:/system/xbin
launcher_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
launcher=$launcher_directory/${0##*/}
base=${CCTVSPOOFER_BASE:-$launcher_directory}
rootfs=$base/rootfs
service=$rootfs/var/lib/cctvspoofer/service
umask 077

require_root() {
  if test "$(id -u)" != 0; then
    printf 'Run this action from an explicitly authorized root shell.\n' >&2
    exit 1
  fi
}

require_install() {
  if ! test -f "$rootfs/.cctvspoofer-installed"; then
    printf 'Complete install first.\n' >&2
    exit 1
  fi
}

case "$action" in
  web-access)
    require_root
    require_install
    unset LD_PRELOAD LD_LIBRARY_PATH
    chroot "$rootfs" /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --input-type=module - "${2:?Specify the Tailscale IPv4 address}" "${3:?Specify the LAN IPv4 address}" <<'CONFIG'
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, stat, chown, rename, mkdtemp, rm, constants } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { isIPv4 } from 'node:net';
const [address, lanAddress] = process.argv.slice(2);
assert.ok(isIPv4(address) && address.split('.')[0] === '100'
  && Number(address.split('.')[1]) >= 64 && Number(address.split('.')[1]) <= 127,
  'Use a Tailscale IPv4 address in 100.64.0.0/10.');
const [first, second] = lanAddress.split('.').map(Number);
assert.ok(isIPv4(lanAddress) && (first === 10 || (first === 172 && second >= 16 && second <= 31)
  || (first === 192 && second === 168)), 'Use a private LAN IPv4 address.');
const filename = '/app/.env';
const contents = await readFile(filename, 'utf8');
const info = await stat(filename);
const settings = parseEnv(contents);
const currentAddress = settings.WEB_LISTEN_ADDRESS && settings.WEB_LISTEN_ADDRESS !== '0.0.0.0'
  ? settings.WEB_LISTEN_ADDRESS : '127.0.0.1';
const origin = `http://${currentAddress}:3000`;
const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
  headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ password: settings.DASHBOARD_PASSWORD }), signal: AbortSignal.timeout(10000) });
assert.equal(login.status, 303, 'Could not authenticate; no configuration changed.');
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const response = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) });
assert.equal(response.status, 200, 'Could not check replay state; no configuration changed.');
assert.equal((await response.json()).replay.phase, 'live', 'Stop recording/replay before changing web access.');
settings.WEB_HOSTS = `${lanAddress},${address}`;
settings.WEB_LISTEN_ADDRESS = '0.0.0.0';
const updated = Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
assert.deepEqual(parseEnv(updated), settings);
await copyFile(filename, '/app/.env.before-web-access', constants.COPYFILE_EXCL).catch(error => {
  if (error.code !== 'EEXIST') throw error;
});
const directory = await mkdtemp('/app/.web-config-');
try {
  const temporary = `${directory}/.env`;
  await writeFile(temporary, updated, { mode: 0o600 });
  await chown(temporary, info.uid, info.gid);
  await rename(temporary, filename);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(`Dashboard configured for http://${lanAddress}:3000 and http://${address}:3000; credentials and stream settings preserved.`);
CONFIG
    sv -w 30 restart "$service"
    ;;
  install)
    require_root
    test "$(uname -m)" = aarch64
    if test -e "$rootfs" || test -e "$base/rootfs.new"; then
      printf 'An installation or partial extraction already exists; nothing overwritten.\n' >&2
      exit 1
    fi
    cd "$base"
    sha256sum -c runtime.sha256
    for filename in .env proxy-config.json camera-inventory.json; do
      test -f "$base/$filename"
      test ! -L "$base/$filename"
    done
    app_uid=$(stat -c %u "$base")
    test "$app_uid" -ge 10000
    mkdir -m 755 "$base/rootfs.new"
    tar -xzpf runtime.tar.gz -C "$base/rootfs.new"
    target=$base/rootfs.new
    for filename in .env proxy-config.json camera-inventory.json; do
      cp "$base/$filename" "$target/app/$filename"
      chown "$app_uid:$app_uid" "$target/app/$filename"
      chmod 600 "$target/app/$filename"
    done
    mkdir -p "$target/var/lib/cctvspoofer/service/log" "$target/var/lib/cctvspoofer/recordings" "$target/var/log/cctvspoofer"
    printf '#!/bin/sh\nexec 2>&1\ncd /app\nexec /usr/local/bin/node --env-file=/app/.env src/proxy-fleet.js\n' > "$target/var/lib/cctvspoofer/service/run"
    printf '#!/bin/sh\nexec /usr/bin/svlogd -tt /var/log/cctvspoofer\n' > "$target/var/lib/cctvspoofer/service/log/run"
    printf 's1048576\nn5\n' > "$target/var/log/cctvspoofer/config"
    chmod 700 "$target/var/lib/cctvspoofer/service/run" "$target/var/lib/cctvspoofer/service/log/run"
    chown -R "$app_uid:$app_uid" "$target/var/lib/cctvspoofer" "$target/var/log/cctvspoofer"
    chmod 700 "$target/var/lib/cctvspoofer" "$target/var/log/cctvspoofer"
    mkdir -p "$target/dev" "$target/proc" "$target/sys" "$target/tmp"
    for device in null zero random urandom; do
      test ! -e "$target/dev/$device"
      touch "$target/dev/$device"
    done
    printf '127.0.0.1 localhost\n::1 localhost\n' > "$target/etc/hosts"
    chmod 644 "$target/etc/hosts"
    printf '%s\n' "$app_uid" > "$target/.cctvspoofer-installed"
    touch "$base/launcher.log"
    chown "$app_uid:$app_uid" "$base/launcher.log"
    chmod 600 "$base/launcher.log"
    mv "$target" "$rootfs"
    printf 'Native filesystem installed. No service or boot settings changed.\n'
    ;;
  check|_serve)
    require_root
    require_install
    command -v busybox >/dev/null
    app_uid=$(cat "$rootfs/.cctvspoofer-installed")
    unshare --mount --propagation private /system/bin/sh -s -- "$rootfs" "$app_uid" "$action" <<'NATIVE'
set -eu
rootfs=$1
app_uid=$2
action=$3
for directory in proc sys; do
  printf 'Bind-mounting /%s in the private namespace.\n' "$directory"
  busybox mount -i -o bind "/$directory" "$rootfs/$directory"
  printf 'Making the /%s bind read-only.\n' "$directory"
  busybox mount -i -o remount,bind,ro,nosuid,nodev,noexec "/$directory" "$rootfs/$directory"
done
for device in null zero random urandom; do
  busybox mount -i -o bind "/dev/$device" "$rootfs/dev/$device"
done
busybox mount -i -t tmpfs -o nosuid,nodev,size=64m,mode=1777 tmpfs "$rootfs/tmp"
ulimit -c 0
unset LD_PRELOAD LD_LIBRARY_PATH
if test "$action" = check; then
  exec chroot --userspec="$app_uid:$app_uid" --groups=3003 "$rootfs" /usr/bin/env -i HOME=/var/lib/cctvspoofer PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp LANG=C.UTF-8 PROXY_MEDIA_TEST=1 /bin/sh -c 'cd /app && node --version && mediamtx --version && node --test --test-reporter=dot'
fi
exec chroot --userspec="$app_uid:$app_uid" --groups=3003 "$rootfs" /usr/bin/env -i HOME=/var/lib/cctvspoofer PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp LANG=C.UTF-8 /usr/bin/nice -n 10 /usr/bin/runsv /var/lib/cctvspoofer/service
NATIVE
    ;;
  start)
    require_root
    require_install
    if sv status "$service" >/dev/null 2>&1; then
      sv up "$service"
    else
      nohup setsid /system/bin/sh "$launcher" _serve >> "$base/launcher.log" 2>&1 < /dev/null &
      printf 'Startup requested. Verify status and dashboard health before relying on it.\n'
    fi
    ;;
  stop)
    require_install
    sv -w 30 exit "$service"
    ;;
  status)
    require_install
    sv status "$service"
    ;;
  *)
    printf 'Unknown action. Use --help.\n' >&2
    exit 1
    ;;
esac