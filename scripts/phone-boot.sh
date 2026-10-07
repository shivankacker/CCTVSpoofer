#!/system/bin/sh
set -eu

prefix=/data/data/com.termux/files/usr
home=/data/data/com.termux/files/home
native=$home/cctvspoofer-native
boot=/data/adb/cctvspoofer
hook=/data/adb/service.d/90-cctvspoofer.sh
export HOME=$home PREFIX=$prefix PATH=$prefix/bin:/system/bin:/system/xbin
umask 077

action=${1:---help}
if test "$action" = --help; then
  printf 'Usage: phone-boot.sh install|check|run|disable\n'
  exit 0
fi
if test "$(id -u)" != 0; then
  printf 'This boot-management action requires an operator-authorized root shell.\n' >&2
  exit 1
fi

load_uid() {
  app_uid=$(cat "$native/rootfs/.cctvspoofer-installed")
  case "$app_uid" in ''|*[!0-9]*) return 1 ;; esac
  test "$app_uid" -ge 10000
}

as_termux() {
  su -p -g "$app_uid" -G 3003 -G 9997 -s /system/bin/sh "$app_uid" -c "$1"
}

sshd_running() {
  test -r "$prefix/var/run/sshd.pid" || return 1
  ssh_pid=$(cat "$prefix/var/run/sshd.pid")
  case "$ssh_pid" in ''|*[!0-9]*) return 1 ;; esac
  test "$(cat "/proc/$ssh_pid/comm" 2>/dev/null)" = sshd || return 1
  kill -0 "$ssh_pid" 2>/dev/null
}

case "$action" in
  install)
    source=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
    test -d /data/adb/service.d
    test -f "$source/phone-native.sh"
    if { test -e "$boot" || test -e "$hook"; } && ! test -f "$boot/.managed"; then
      printf 'Unrecognized existing boot files; nothing overwritten.\n' >&2
      exit 1
    fi
    load_uid
    for binary in sshd runsv sv svlogd; do test -x "$prefix/bin/$binary"; done
    as_termux "$prefix/bin/sshd -t"
    /system/bin/sh -n "$source/phone-native.sh"
    /system/bin/sh -n "$0"
    package=$(pm path com.tailscale.ipn)
    case "$package" in package:*) ;; *) printf 'Tailscale is not installed.\n' >&2; exit 1 ;; esac
    previous_vpn=$(settings --user 0 get secure always_on_vpn_app)
    lockdown=$(settings --user 0 get secure always_on_vpn_lockdown)
    case "$previous_vpn" in null|com.tailscale.ipn) ;; *) printf 'Another always-on VPN is configured; no changes made.\n' >&2; exit 1 ;; esac
    case "$lockdown" in null|0) ;; *) printf 'Review the existing VPN lockdown policy before installing.\n' >&2; exit 1 ;; esac
    mkdir -p "$boot/sshd/log" "$boot/ssh-log"
    chmod 700 "$boot" "$boot/sshd" "$boot/sshd/log" "$boot/ssh-log"
    if ! test -f "$boot/vpn-before"; then printf '%s\n' "$previous_vpn" > "$boot/vpn-before"; fi
    cp "$0" "$boot/phone-boot.sh.new"
    cp "$source/phone-native.sh" "$boot/phone-native.sh.new"
    chmod 700 "$boot/phone-boot.sh.new" "$boot/phone-native.sh.new"
    mv "$boot/phone-boot.sh.new" "$boot/phone-boot.sh"
    mv "$boot/phone-native.sh.new" "$boot/phone-native.sh"
    printf '#!/system/bin/sh\nexport HOME=%s PREFIX=%s PATH=%s/bin:/system/bin:/system/xbin\nexec 2>&1\nexec su -p -g %s -G 3003 -G 9997 -s /system/bin/sh %s -c "exec %s/bin/sshd -D -e"\n' \
      "$home" "$prefix" "$prefix" "$app_uid" "$app_uid" "$prefix" > "$boot/sshd/run"
    printf '#!/system/bin/sh\nexec %s/bin/svlogd -tt %s/ssh-log\n' "$prefix" "$boot" > "$boot/sshd/log/run"
    printf 's262144\nn3\n' > "$boot/ssh-log/config"
    chmod 700 "$boot/sshd/run" "$boot/sshd/log/run"
    printf 'cctvspoofer-native-boot-v1\n' > "$boot/.managed"
    settings --user 0 put secure always_on_vpn_app com.tailscale.ipn
    test "$(settings --user 0 get secure always_on_vpn_app)" = com.tailscale.ipn
    printf '#!/system/bin/sh\numask 077\nboot=%s\ntest ! -f "$boot/disabled" || exit 0\nif test -f "$boot/boot.log"; then mv "$boot/boot.log" "$boot/boot.previous.log"; fi\n/system/bin/sh "$boot/phone-boot.sh" run >> "$boot/boot.log" 2>&1 < /dev/null &\n' "$boot" > "$hook.new"
    chmod 700 "$hook.new"
    mv "$hook.new" "$hook"
    rm -f "$boot/disabled"
    printf 'Boot hook installed; Tailscale always-on saved, lockdown unchanged.\n'
    printf 'Existing SSH, VPN, and camera processes were not restarted by this installer.\n'
    printf 'With a PIN set, first unlock is still required. No reboot was performed.\n'
    ;;
  check)
    test -f "$boot/.managed"
    test -x "$hook"
    test ! -f "$boot/disabled"
    /system/bin/sh -n "$hook"
    /system/bin/sh -n "$boot/phone-boot.sh"
    /system/bin/sh -n "$boot/phone-native.sh"
    /system/bin/sh -n "$boot/sshd/run"
    /system/bin/sh -n "$boot/sshd/log/run"
    load_uid
    as_termux "$prefix/bin/sshd -t"
    test "$(settings --user 0 get secure always_on_vpn_app)" = com.tailscale.ipn
    printf 'Boot files, SSH configuration, and saved always-on VPN setting pass checks.\n'
    printf 'A real reboot and first-unlock behavior have NOT been tested.\n'
    ;;
  run)
    test -f "$boot/.managed"
    lock=/dev/.cctvspoofer-boot-lock
    mkdir "$lock" 2>/dev/null || exit 0
    trap 'rmdir "$lock"' EXIT
    printf 'Waiting for Android boot completion and credential-encrypted storage.\n'
    while test "$(getprop sys.boot_completed)" != 1 || test "$(getprop sys.user.0.ce_available)" != true; do
      test ! -f "$boot/disabled" || exit 0
      /system/bin/sleep 5
    done
    test ! -f "$boot/disabled" || exit 0
    load_uid
    if sshd_running; then
      printf 'Existing SSH daemon left running.\n'
    elif sv status "$boot/sshd" >/dev/null 2>&1; then
      sv up "$boot/sshd"
    else
      nohup setsid "$prefix/bin/runsv" "$boot/sshd" >> "$boot/boot.log" 2>&1 < /dev/null &
      printf 'SSH supervisor startup requested.\n'
    fi
    CCTVSPOOFER_BASE=$native /system/bin/sh "$boot/phone-native.sh" start
    printf 'Camera startup requested. Tailscale startup is managed by Android always-on VPN.\n'
    ;;
  disable)
    test -f "$boot/.managed"
    touch "$boot/disabled"
    rm -f "$hook"
    if test "$(settings --user 0 get secure always_on_vpn_app)" = com.tailscale.ipn; then
      previous_vpn=$(cat "$boot/vpn-before")
      if test "$previous_vpn" = null; then
        settings --user 0 delete secure always_on_vpn_app
      else
        settings --user 0 put secure always_on_vpn_app "$previous_vpn"
      fi
    fi
    printf 'Future boot startup disabled; running SSH and camera processes left alone.\n'
    ;;
  *)
    printf 'Unknown action. Use --help.\n' >&2
    exit 1
    ;;
esac