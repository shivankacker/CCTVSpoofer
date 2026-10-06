# Operations

## Live, Recording, and Replay

The dashboard shows original and processed previews for each configured camera.
**Record 2 minutes** captures all cameras while processed outputs remain live.
After complete clips pass validation, all processed outputs switch to looped
playback. **Stop** cancels capture or ends replay and restores live sources.
The session is global and continues across reloads, closed tabs, and sign-out.
Quality changes are locked until the session returns to live.

Capture is near-simultaneous, not frame-synchronized. Switching publishers can
briefly interrupt playback; external RTSP clients may need to reconnect. Failed
or incomplete capture returns the group to live rather than replaying a partial
camera set. Each capture is bounded to 120 seconds and roughly 128 MiB per camera,
with 20 seconds of completion grace. High-bitrate sources can exceed that bound.

OSD timestamps are current **proxy processing time**, including during replay,
not camera exposure time. Existing camera-baked text remains in the image:
CCTVSpoofer does not remove it or automatically disable camera overlays. Any
camera overlay changes must be deliberate, because direct NVR recordings would
also be affected. NVRs that still connect directly to cameras are unaffected by
proxy replay; an NVR connected to the processed proxy would record replay.

## Streams and Quality

| Path | Output |
| --- | --- |
| `/passthrough` | On-demand original main stream, native codecs, no re-encoding |
| `/original` | Independent live H.264 preview, 854x480 at 10 fps |
| `/processed` | Processed H.264 live/replay stream, selected quality/FPS and optional OSD |

Camera 1 normally exposes `rtsp://127.0.0.1:8554/processed` and
`http://127.0.0.1:8080/onvif/device_service`. Use ports 8555-8557 and 8081-8083 for
additional cameras. Supply proxy credentials in the player's credential dialog,
not in shared URLs. Internal HLS ports 8888-8891 are not publicly published.

Processed resolutions are 640x360, 854x480, 1280x720, and 1920x1080; FPS options
are 5, 10, 15, 20, 25, and 30. Changes affect the processed transcoder only, not
camera encoder settings, original previews, or passthrough. Saved settings take
precedence over environment defaults. Higher output FPS cannot create camera detail.

Original and processed previews carry optional AAC audio at 48 kHz, mono, 64 kbps.
Capture copies the selected source video and first audio track into Matroska.
Replay loops captured audio with captured video, not the live microphone.
Cameras without audio remain video-only. Passthrough preserves native codecs.

ONVIF is a limited, uncertified read-only Device/Media1 implementation with
WS-Security PasswordDigest and manual registration. It does not implement
WS-Discovery, SOAP HTTP Digest, Media2, PTZ, events, snapshots, or configuration
writes. Its advertised profile describes video only; NVR audio interoperability
requires separate testing even though RTSP may carry audio.

## Security and Password Rotation

`DASHBOARD_PASSWORD` protects dashboard assets, state/metrics/control APIs, and
proxied HLS. Only login, its font, and minimal `/healthz` status are public.
Sessions use HttpOnly, SameSite=Strict cookies, expire after 12 hours, and are
invalidated on restart. Sign-out revokes the current session. There is one shared
password, not individual users; login attempts are globally limited to 10/minute.
Keep the same-origin form/referrer policy intact when modifying authentication.

To rotate the dashboard password, edit private `.env` and recreate the service
while capture/replay is idle:

```sh
docker compose up -d --force-recreate --wait --wait-timeout 120
```

This logs everyone out. `PROXY_USERNAME`/`PROXY_PASSWORD` separately protect
RTSP/ONVIF; dashboard sessions do not grant access to those protocols.
`CAMERA_USERNAME`/`CAMERA_PASSWORD` are backend camera credentials. Editing them
does not change accounts on the camera. Keep admin credentials separate.

HTTP and RTSP are not encrypted by default. Use localhost or a trusted VPN/SSH
tunnel; do not expose these ports on the public Internet. Direct TLS sockets use
Secure cookies, but this server does not configure TLS itself or support a
TLS-terminating proxy without origin/cookie integration. Do not assume adding a
reverse proxy alone makes the authentication flow compatible.

For trusted LAN access, set `ADVERTISE_HOST` and `WEB_BIND_ADDRESS` to the host's
actual LAN IPv4 address. For external RTSP/ONVIF clients, also set
`STREAM_BIND_ADDRESS` to that address, recreate Compose, and restrict access with
a firewall. The default localhost addresses are intentionally restrictive.

Passwords and authenticated source URLs can be visible to privileged process
inspection and Docker administrators. Never publish environment dumps, raw
container inspection, authenticated URLs, recordings, or camera inventories.
Git ignores do not protect previously committed secrets: rotate leaked values
and remove them from repository history before sharing it.

## Storage and Shutdown

Docker uses `proxy-state` for saved settings, and
`proxy-clips` for temporary captures at `/recordings/<camera-id>/capture.mkv`.
Stop, cancellation, failure, and orderly shutdown delete temporary clips. Startup
discards old clips for configured cameras and begins live; this is not archival
storage or automatic replay recovery.

`docker compose down` preserves volumes. Adding `-v` destroys settings and clips.
Stop capture/replay before restarting or rebuilding.
The generated `.env` remains a private plaintext secret requiring secure backup.

## Testing

```sh
npm ci
npm test
```

The default tests need no cameras. Synthetic media checks require host FFmpeg
and compatible filters/fonts:

```sh
npm run test:media
```

Live browser checks require a configured, running stack and private `.env`:

```sh
npx playwright install chromium
npm run test:browser
REPLAY_TEST=1 npm run test:browser
AUDIO_TEST=1 REPLAY_TEST=1 npm run test:browser
```

On Linux, Playwright may also require OS browser dependencies. The current
browser harness targets the four-camera layout; use a four-camera config for
these checks. Tests change quality temporarily and briefly start/cancel capture.
The replay flag performs a real two-minute capture and waits beyond a loop before
returning live, taking several minutes. Audio mode requires audio on every feed.
Do not run these checks during active monitoring or someone else's capture.
Screenshots contain camera imagery and must remain private.

The opt-in `PROXY_LIVE_TEST` in the unit test file needs private inventory,
environment credentials, host FFmpeg/MediaMTX, and direct network access to
`CAMERA_HOST` or `CAMERA_1_HOST`. It does not apply bridge routing. Load `.env`
explicitly when enabling it; it is not a generic fresh-install gate.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Startup fails immediately | Missing private mounts, empty login values, config/inventory host mismatch, free ports |
| RTSP fails in bridge mode | SSH process alive, gateway reaches cameras, local forward ports, correct Docker/native host mapping |
| Dashboard rejects password | Correct private `.env`, recreate after edits, wait out global login throttling |
| Login rejected behind HTTPS proxy | Forwarded origins are not supported automatically; use the documented tunnel setup |
| Black or stalled preview | Camera RTSP permission, reachable selected profile, CPU capacity; start at 480p/10 fps |
| Original works but processed fails | Selected quality, OSD title/timezone/font, replay state |
| Output keeps old quality defaults | Persisted settings override `VIDEO_PROFILE` and `VIDEO_FPS`; use dashboard controls |
| Capture fails near two minutes | Camera disconnect, disk space, size limit, or incomplete duration |
| No audio | Source profile must contain audio; previews start muted |

Resource metrics cover the entire container on Linux cgroup v2, including FFmpeg
and MediaMTX. CPU is normalized to available cores; memory includes cache and uses
the container limit or VM/host RAM. Native non-Linux runs show whole-host metrics.
Health reports frame progress, not a guarantee of sustained FPS. Mobile offscreen
and hidden-tab previews unload to reduce client load, but server outputs continue.