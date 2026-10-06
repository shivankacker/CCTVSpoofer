# CCTVSpoofer

A self-hosted ONVIF/RTSP camera dashboard for authorized camera testing, live
monitoring, and coordinated recording/replay experiments. Node.js orchestrates
FFmpeg and MediaMTX; the browser receives password-protected HLS video and audio.

Use only with cameras you own or have explicit permission to operate. Replayed
output is not a live surveillance record: the dashboard labels replay, but an
external RTSP client may not. Never present replay as evidence of current events.

## Features

- One to four cameras with independent original and processed previews.
- Per-camera 360p-1080p output and 5-30 fps controls, saved across restarts.
- Coordinated two-minute capture followed by looping playback; Stop returns live.
- Current proxy timestamp and camera title on processed outputs.
- Optional AAC audio in previews and replay, plus native-codec RTSP passthrough.
- Environment-scoped dashboard password, expiring sessions, and sign-out.
- CPU/memory monitoring, responsive layout, and automatic light/dark themes.
- Docker Compose deployment, with optional SSH forwarding to a remote camera LAN.

Startup does not change camera accounts, overlays, encoder settings, or NVR
registrations. Create viewer accounts using your camera's administration tools.

## Getting Started

You need Node.js 22+, Docker with Compose v2, and access to ONVIF/RTSP cameras.
The host needs Node for inventory discovery; Docker supplies the media services.

1. Run `npm ci` in the project directory.
2. Follow [docs/setup.md](docs/setup.md) to create private configuration, enter
   viewer credentials, and discover your cameras. No camera data or passwords
   are included in the repository.
3. Start the configured stack:

```sh
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 120
```

Open **http://localhost:3000** and enter your `DASHBOARD_PASSWORD`.

The public templates use documentation-only IP addresses and are not runnable
until customized. Existing installations should keep their private files; do
not replace them with the examples.

## Documentation

- [docs/setup.md](docs/setup.md): fresh install, camera discovery, environment
  settings, remote SSH bridge, and native execution.
- [docs/operations.md](docs/operations.md): recording/replay, stream endpoints,
  security, storage, testing, and troubleshooting.

## Project Layout

```text
src/                       Backend modules and camera CLI
scripts/                   SSH bridge and environment initialization
tests/                     Unit, media, and live browser checks
web/                       Dashboard and login assets
docs/                      Setup and operations guides
.github/workflows/         Automated unit tests
*.example.json             Public configuration templates
.env.example               Public environment template
compose.yaml / Dockerfile  Container deployment
```

Run commands from the repository root. Private JSON configuration, camera
inventory, and `.env` stay there; moving source files does not change their paths.

## Development

```sh
npm ci
npm test
```

The default suite does not contact cameras. Media and browser checks require
additional tools and explicit opt-in; see [docs/operations.md](docs/operations.md).
The CI workflow runs the default suite on Node.js 22.

## Before Publishing

The ignore rules exclude local credentials, environment files, camera inventory,
deployment config, TLS keys/certificates, recordings, dependencies, and test
artifacts. Only sanitized examples should be committed. Ignore rules do not
remove previously tracked files or secrets from history.

Before committing, inspect `git status --short`, `git diff --cached --name-only`,
and the staged diff locally. Never use `git add -f` to include private files, and
never publish full Compose configuration, container environment output, or
authenticated stream URLs. Rotate any credential that was already exposed.

No project license has been selected yet. Choose one before inviting reuse or
redistribution; dependency licenses still apply.

## Limitations

HTTP/RTSP are unencrypted by default: keep access on localhost or a trusted
VPN/SSH tunnel, not the public Internet. ONVIF support is a limited, uncertified
read-only implementation; NVR interoperability must be validated separately.
Transcoding is CPU-intensive, HLS adds latency, and camera streams are not
frame-synchronized. Start with 480p/10 fps and measure your hardware.