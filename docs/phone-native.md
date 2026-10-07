# Native Android Deployment

This is a native ARM64 Debian chroot, not Docker on Android and not a VM.
Docker on the build machine only assembles and exports the filesystem.
The app, FFmpeg, and MediaMTX run directly on the phone's CPU.

## Safety Boundaries

- Requires rooted ARM64 Android, mount namespaces, and a standard Termux install.
- Never reboot a remotely located phone to test this installation.
- Does not restart SSH, alter Tailscale, networking, firewall rules, Android
  power settings, or configure boot startup.
- Uses a private mount namespace. Android's existing cgroup mounts are untouched.
- The app and its runit supervisor use the Termux UID, not root. This is not
  container isolation: the kernel, process namespace, and network are shared.
- Dashboard, RTSP, and ONVIF listeners initially bind only to loopback.
- Existing camera and NVR configuration is not modified.

The launcher requires Termux BusyBox (`pkg install busybox`). Android's Toybox
mount command does not reliably preserve bind-mount semantics on remounts or
device-file binds; the launcher explicitly uses BusyBox instead.

## Prepare On The Build Machine

Run from the repository root:

```sh
docker build --platform linux/arm64 -t cctvspoofer-phone-base .
docker build --platform linux/arm64 -f scripts/Dockerfile.phone \
  -t cctvspoofer-phone-runtime .
docker run --rm -e PROXY_MEDIA_TEST=1 cctvspoofer-phone-runtime \
  node --test --test-reporter=dot
```

Export a stopped container from that image with `docker create` and
`docker export`, then gzip the exported tar as `runtime.tar.gz`.
This is a filesystem export, not a `docker save` image archive.
Create `runtime.sha256` containing its SHA-256 checksum and basename.
Remove only the temporary export container when finished.

Create a mode-0700 staging directory outside the repository. Include the archive,
checksum, a copy of `scripts/phone-native.sh`, and mode-0600 private copies of
`.env`, `proxy-config.json`, and `camera-inventory.json`. Keep the original files
unchanged. Never put credentials into the build image or print the environment.

The deployment copy of `.env` needs existing camera/proxy/dashboard credentials
and the following native settings:

```dotenv
CONNECTION_MODE=office
ADVERTISE_HOST=127.0.0.1
LISTEN_ADDRESS=127.0.0.1
WEB_LISTEN_ADDRESS=127.0.0.1
CAMERA_CONFIG_FILE=/app/proxy-config.json
INVENTORY_FILE=/app/camera-inventory.json
STREAM_SETTINGS_FILE=/var/lib/cctvspoofer/stream-settings.json
RECORDING_DIRECTORY=/var/lib/cctvspoofer/recordings
VIDEO_PROFILE=480p
VIDEO_FPS=10
```

For every configured camera, retain its `CAMERA_n_HOST` inventory identity and
set `CAMERA_n_RTSP_HOST` to that same LAN address and `CAMERA_n_RTSP_PORT` to its
actual RTSP port, usually 554. Do not use `host.docker.internal` or SSH forward
ports on the phone. Native fleet HTTP listens on port 3000.

Transfer these staged files over SSH into a new mode-0700 directory:
`/data/data/com.termux/files/home/cctvspoofer-native`. Preserve file permissions
and verify the archive checksum there. Do not overwrite an existing deployment.

## Install And Start

The operator runs the following root step. It does not reboot or configure
startup. Install refuses to overwrite an existing or partial extraction;
inspect any previous attempt rather than deleting it blindly.

```sh
ssh -T phone 'su -c /system/bin/sh' <<'PHONE'
set -e
base=/data/data/com.termux/files/home/cctvspoofer-native
/system/bin/sh "$base/phone-native.sh" install
/system/bin/sh "$base/phone-native.sh" check
/system/bin/sh "$base/phone-native.sh" start
PHONE
```

`check` runs synthetic media and unit tests without contacting cameras. If it
fails, the command stops before starting the fleet. Android execution and mount
compatibility are not established until this check passes on the actual phone.
`start` requests background startup; it does not certify dashboard health.

The supervisor restarts a failed fleet during the current boot, with lower CPU
priority. Logs rotate at about 1 MiB with five retained rotations. Clips and
settings live under `rootfs/var/lib/cctvspoofer`; logs are under
`rootfs/var/log/cctvspoofer`. Startup/mount errors go to `launcher.log`.

## Dashboard And Control

### Direct LAN And Tailnet Access

Keep the existing dashboard password. Confirm the phone's LAN and Tailscale IPv4
addresses with `busybox ifconfig`; use the actual addresses, not these examples.
From the repository root, stage the current web module and launcher:

```sh
scp scripts/phone-native.sh phone:~/cctvspoofer-native/phone-native.sh
scp src/proxy-web.js phone:~/cctvspoofer-native/proxy-web.next.js
```

With recording/replay idle, the operator runs this app-only update:

```sh
ssh -T phone 'su -c "/system/bin/sh /data/data/com.termux/files/home/cctvspoofer-native/phone-native.sh web-access 100.64.0.10 192.168.1.20"'
```

It checks authenticated replay state, backs up the environment to
`rootfs/app/.env.before-web-access`, sets `WEB_LISTEN_ADDRESS=0.0.0.0` and
`WEB_HOSTS=192.168.1.20,100.64.0.10`, installs the staged web module, and restarts
only the fleet through its existing supervisor. Credentials, recordings, saved
quality, and RTSP/ONVIF loopback listeners are preserved. Do not rerun `install`.

The dashboard then uses `http://LAN_IP:3000` on the office LAN and
`http://TAILSCALE_IP:3000` from tailnet devices permitted by the existing Tailscale
access policy. No SSH forwarding, public tunnel, router port-forwarding, or boot
changes are required. HTTP on the LAN is not encrypted; Tailscale encrypts the
tailnet transport. Host validation is not a firewall: do not add public router
forwarding. Update the configuration again if either address changes.

### Optional SSH Viewer

Open a separate terminal on the viewing machine:

```sh
ssh -NT -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:13000:127.0.0.1:3000 phone
```

Open http://127.0.0.1:13000 and use the existing dashboard password.
The SSH alias can route over Tailscale; no public or LAN HTTP port is opened.
Choose another local port if 13000 is occupied. Keep this viewer tunnel open.

Android SELinux can block Termux from opening the supervisor's control FIFOs
even when the Unix UID matches. On this deployment, supervisor status and
graceful stop require an operator-authorized root shell:

```sh
ssh -T phone 'su -c "/system/bin/sh /data/data/com.termux/files/home/cctvspoofer-native/phone-native.sh status"'
ssh -T phone 'su -c "/system/bin/sh /data/data/com.termux/files/home/cctvspoofer-native/phone-native.sh stop"'
```

Do not disable SELinux or broaden FIFO permissions to work around this. The
dashboard and its health endpoint remain accessible without root through SSH.

Wait until recording/replay is idle before stopping. Stop exits the supervisor
and releases private mounts after its processes exit. Restart with the operator
root command using only the `start` action; do not rerun `install`.

## Production Validation

After actual-device checks and startup, verify authenticated dashboard access,
all original/processed streams, quality changes, recording/replay, audio, and
return to live. Measure sustained CPU usage and thermal behavior while confirming
SSH stays responsive. Passing synthetic tests is not a four-camera capacity test.

With the dashboard reachable and recording/replay idle, run the existing browser
check from the repository root. It changes quality temporarily, records a new
two-minute clip, exercises replay, and restores live mode and the original quality:

```sh
PROXY_WEB_URL=http://100.64.0.10:3000 PROXY_METRICS_SCOPE=unavailable \
  AUDIO_TEST=1 REPLAY_TEST=1 npm run test:browser
```

Replace the URL with the actual LAN/tailnet dashboard address, or the local
forwarded address when using the optional SSH viewer.

The explicit metrics expectation verifies the unavailable state rather than
skipping it. Docker tests still require working container metrics by default;
`PROXY_METRICS_SCOPE=host` is available for native non-Linux hosts.

Android may restrict background processes or suspend the phone; this installation
does not change power policies. Resource metrics can be unavailable on Android's
hybrid cgroups and should not be assumed to measure just this app.

The base native installer does not enable startup after a reboot. Keep physical
recovery access available before relying on this phone for unattended production.

## Optional Boot Startup

The separate Magisk boot setup starts only SSH and CCTVSpoofer. It does not enable
other Termux services, regenerate SSH host keys, or change SSH authentication.
It saves Tailscale as Android's always-on VPN and leaves VPN lockdown unchanged.
No public tunnel or router forwarding is configured.

Credential-encrypted Termux storage must be unlocked first. With a PIN, pattern,
or password configured, the hook waits for the first unlock after boot; locking
the screen again does not stop the services. It never supplies a PIN or weakens
the lock screen. Remove the PIN yourself only while physically at the phone if
you accept the reduced protection against physical access and want unattended
startup. Then verify the actual behavior before leaving the office.

Stage the current scripts from the repository root:

```sh
scp scripts/phone-native.sh scripts/phone-boot.sh phone:~/cctvspoofer-native/
```

The operator installs and checks the boot setup with:

```sh
ssh -T phone 'su -c /system/bin/sh' <<'PHONE'
set -e
base=/data/data/com.termux/files/home/cctvspoofer-native
/system/bin/sh "$base/phone-boot.sh" install
/system/bin/sh "$base/phone-boot.sh" check
PHONE
```

Installation writes a private Magisk hook at
`/data/adb/service.d/90-cctvspoofer.sh` and protected script copies under
`/data/adb/cctvspoofer`. It validates the SSH configuration as the Termux UID
before enabling startup. An existing different always-on VPN or VPN lockdown
policy blocks installation rather than being overwritten. The installer does
not invoke a reboot, terminate existing connections, or start/restart the current
SSH or camera processes. The `check` action is non-disruptive and does not simulate
a reboot.

At boot, the hook waits for Android and encrypted storage, starts a dedicated
runit SSH supervisor if no SSH master is running, and starts the native camera
supervisor. Android manages Tailscale startup from the saved always-on setting.
SSH logs rotate under `/data/adb/cctvspoofer/ssh-log`; the current and previous
boot logs are `boot.log` and `boot.previous.log` in that directory. These logs
require root access. Installing this optional setup again refreshes its protected
copies after launcher changes.

Before testing a reboot, be physically present with a working local unlock and
recovery method. Confirm **Always-on VPN** is enabled for Tailscale and **Block
connections without VPN** is off. Ensure Tailscale does not require reauthentication.
After reboot, test SSH and both dashboard addresses from another device without
first opening Termux. If the LAN address changes through DHCP, update `WEB_HOSTS`
with `web-access`; reserving the existing LAN address on the router avoids this.
Do not perform a remote reboot test while recovery access is unavailable.

To disable future boot startup without stopping running SSH or camera processes:

```sh
ssh -T phone 'su -c "/system/bin/sh /data/adb/cctvspoofer/phone-boot.sh disable"'
```

This removes only the managed hook and restores the previous always-on VPN
setting if it has not since been changed to another VPN. The app's data, SSH keys,
and current processes are preserved.