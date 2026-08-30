# Records (macOS companion)

A small always-on Mac app that plays an Apple Music album on request. Built
for the `rec` ESP32-S3 board (see `../rec`): the board has no way to control
Apple Music itself, so pressing an album on its screen sends an HTTP request
here instead, and this resolves the artist/title via MusicKit and plays it.

AppleScript against Music.app cannot reliably control Apple Music catalog
(streaming) playback — only local library items. That's a documented
platform limitation, not a bug to work around further; native MusicKit is
the real, supported way to authorize and stream arbitrary catalog content.

## Build

The `.xcodeproj` is generated, not committed — [XcodeGen](https://github.com/yonaskolb/XcodeGen)
builds it from `project.yml`:

```bash
brew install xcodegen  # once
xcodegen generate
open Records.xcodeproj
```

Requires an active Apple Developer Program membership with a registered
**Media ID** (Certificates, Identifiers & Profiles → Identifiers → "+" →
Media IDs) for native MusicKit's automatic developer token generation to
work at all — without one, catalog search fails with
`MusicTokenRequestError` regardless of what the app's own entitlements say.

## What it does

- Embedded HTTP + Bonjour server (`Network.framework`, no third-party
  dependencies), advertised as `_recplay._tcp` so the board can find it by
  service type instead of a hardcoded IP:
  - `GET /health` → `{"status": "ok"}`
  - `POST /now` with `{"artist", "title", "coverUrl"}` — mirrors whatever
    album the board is currently showing onto this app's window
  - `POST /play` with `{"artist", "title"}` — resolves the album via
    MusicKit's catalog search and plays it
- Native MusicKit playback (`ApplicationMusicPlayer`) with play/pause/skip
  transport controls, since this Mac app is the real playback control
  plane — the board only ever asks for a fresh album, it never controls
  play state directly.
