# YouTube DJ Pipeline

An end-to-end pipeline for converting YouTube playlists into DJ-ready MP3 files with proper normalization, ID3 tagging, and Rekordbox integration.

## Features

- **Download YouTube playlists**: Fetches all videos from a YouTube playlist (`yt-dlp`)
- **High-quality audio**: Transcodes to MP3 320 kbps CBR at 44.1 kHz stereo
- **DJ-safe normalization**: Two-pass EBU R128 LUFS normalization (-9 LUFS, -1.0 dBTP true peak)
- **Automatic ID3 tagging**: Title, Artist, Album, Track Number, Year, and cover art
- **Rekordbox integration**: Generates an iTunes XML playlist for import
- **Desktop app**: Optional Electron UI with **bundled `yt-dlp` and `ffmpeg`** in release builds (macOS `.dmg` / `.zip`, Windows NSIS **Setup `.exe`** + `.zip`)
- **CLI**: Same pipeline from the terminal with system or vendor binaries

## How it works

1. **Playlist fetch**: `yt-dlp` retrieves playlist metadata (`--flat-playlist` JSON).
2. **Per-video metadata**: Full JSON per video for richer tags.
3. **Thumbnail**: Cover art when available (optional; failures are non-fatal).
4. **Audio download**: Best audio stream per video (YouTube client args tuned to reduce CDN 403 issues).
5. **LUFS normalization**: Two-pass `loudnorm` then MP3 encode via `ffmpeg`.
6. **ID3 + Rekordbox XML**: Tagged MP3s and `iTunes Music Library.xml` (only if at least one track completed).
7. **Cleanup**: Temp audio and thumbnails removed after each track.

If a track fails (unavailable video, network error, etc.), the pipeline **continues** with the rest of the playlist. Failed entries are listed in the Electron UI and written to **`download_failures.csv`** in the output folder (`url`, `title`, `reason`).

### Output structure

By default the CLI writes under `./output`. The Electron app uses a folder you choose (default suggestion: `Documents/YouTube DJ Pipeline output`).

```
output/
├── audio/
│   └── Track Name.mp3
├── logs/
│   ├── VIDEO_ID.json
│   └── VIDEO_ID.loudnorm.json
├── rekordbox/
│   └── iTunes Music Library.xml
├── download_failures.csv   # only when one or more tracks failed
└── tmp/                    # transient downloads (cleaned per track)
    └── thumbnails/
```

## Prerequisites

| Mode | Requirements |
|------|----------------|
| **CLI** | Node.js 18+ (20 recommended), `yt-dlp`, `ffmpeg` on `PATH` |
| **Electron (dev)** | Same as CLI, **or** run `npm run fetch-tools` to populate `vendor/` |
| **Electron (packaged)** | None beyond installing the built app; tools ship next to the app (`Resources/vendor` on macOS, `resources\vendor` on Windows) |

## Installation

### macOS (CLI / development)

1. Install [Homebrew](https://brew.sh/) if needed.
2. Install tools (for CLI without bundled binaries):

   ```bash
   brew install node yt-dlp ffmpeg
   ```

3. Clone or copy the project, then:

   ```bash
   cd youtube-dj-pipeline
   npm install
   ```

### Windows (CLI)

1. Install [Node.js](https://nodejs.org/).
2. Install [FFmpeg](https://ffmpeg.org/download.html) and [yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) and ensure both are on your `PATH`.
3. `cd youtube-dj-pipeline` and `npm install`.

### Bundled binaries (Electron builds / optional CLI)

To download **yt-dlp** and a static **ffmpeg** into `vendor/` (used by `electron:build` and optional local runs):

```bash
npm run fetch-tools
```

- **CLI with bundled tools** (no `yt-dlp`/`ffmpeg` on `PATH`):

  ```bash
  YOUTUBE_DJ_YTDLP="$PWD/vendor/yt-dlp" YOUTUBE_DJ_FFMPEG="$PWD/vendor/ffmpeg" npm run run -- "PLAYLIST_URL"
  ```

  On Windows, point the env vars at `vendor\yt-dlp.exe` and `vendor\ffmpeg.exe`.

### Verify CLI tools

```bash
node -v
yt-dlp --version
ffmpeg -version
```

## Usage

### Command line

```bash
npm run run -- "https://www.youtube.com/playlist?list=YOUR_PLAYLIST_ID"
```

Paste the URL **without** shell escapes; quotes are enough.

Output goes to `./output` relative to the current working directory.

**Exit codes (CLI):** `0` if at least one track was saved (partial success is OK). `1` on fatal errors (invalid URL, playlist fetch failed, tools missing, user cancel) or when **no** tracks completed successfully.

### Desktop app (Electron)

**Development** (after `npm install`; run `npm run fetch-tools` once so `vendor/` exists, or rely on system `yt-dlp` / `ffmpeg`):

```bash
npm run electron:dev
```

**Production build**

`npm run fetch-tools` downloads **host-native** `yt-dlp` and `ffmpeg` into `vendor/`. Run the build on the same OS you are releasing for so the bundled binaries match (do not build a Windows installer using a `vendor/` folder produced on macOS).

| Command | When to use |
|---------|-------------|
| `npm run electron:build` | Current OS (macOS → `.dmg` + `.zip`; Windows → NSIS Setup + `.zip`) |
| `npm run electron:build:mac` | macOS only (e.g. CI on `macos-latest`) |
| `npm run electron:build:win` | **Windows x64** only (CI on `windows-latest` or a Windows PC). Uses `electron-builder --win --x64` so Intel/AMD PCs get the right build. |

Artifacts land in `dist/`:

- **macOS**: `.dmg`, `-mac.zip` (names depend on arch, e.g. `arm64`)
- **Windows (x64)**: NSIS installer (e.g. `YouTube DJ Pipeline Setup x.x.x.exe`) and a portable `.zip` (e.g. `…-1.0.0-win.zip` when only x64 is built). These run on typical Intel/AMD PCs. **Do not** use an **`arm64-win`** zip on an x64 machine—see troubleshooting below.

**Code signing**: Optional on both platforms; reduces Gatekeeper / SmartScreen friction. See [electron-builder code signing](https://www.electron.build/code-signing) (macOS notarization, Windows Authenticode / `CSC_LINK`).

**CI**: [`.github/workflows/electron-build.yml`](.github/workflows/electron-build.yml) runs `electron:build:mac` and `electron:build:win` on separate runners and uploads `dist/` as artifacts.

In the app: enter the playlist URL, pick an output folder, **Start**, then **Open output folder** when finished. **Stop** aborts between tracks. If some tracks fail, a **Failed tracks** section lists them and points to **`download_failures.csv`** when it was written.

**Windows installer (NSIS):** If the installer says it cannot close the app, **quit YouTube DJ Pipeline completely** (all windows), then click **Retry**. Reinstalling while the app is running can block the installer.

### One-click launchers

- **macOS**: double-click `one-click/run.command`, paste the playlist URL.
- **Windows**: double-click `one-click/run.bat`, paste the URL.

### Docker

```bash
PLAYLIST_URL="https://www.youtube.com/playlist?list=YOUR_PLAYLIST_ID" docker compose up --build
```

Artifacts appear in the mounted `output/` directory.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `YOUTUBE_DJ_YTDLP` | Absolute path to `yt-dlp` (or `yt-dlp.exe`) when not on `PATH` |
| `YOUTUBE_DJ_FFMPEG` | Absolute path to `ffmpeg` (or `ffmpeg.exe`) when not on `PATH` |
| `YTDLP_COOKIES_FROM_BROWSER` | e.g. `chrome` — passes `--cookies-from-browser` to `yt-dlp` if downloads return 403 |

Example:

```bash
YTDLP_COOKIES_FROM_BROWSER=chrome npm run run -- "PLAYLIST_URL"
```

## Rekordbox import

1. Open Rekordbox.
2. **File → Import → iTunes Library (XML)**.
3. Select `output/rekordbox/iTunes Music Library.xml` (or the same path under your chosen output folder).
4. Analyze BPM/key as needed.

## Configuration

### LUFS target

Defaults are applied in the `loudnormTwoPassToMp3` call in [`src/pipeline.js`](src/pipeline.js) (per-track processing) and the function default in [`src/audio.js`](src/audio.js):

```javascript
loudnormTwoPassToMp3(tmpFile, outMp3, loudnormLog, {
  i: -9,    // integrated loudness (LUFS)
  tp: -1.0, // true peak (dBTP)
  lra: 8    // loudness range
});
```

Common choices: **-9 LUFS** (DJ-oriented) vs **-14 LUFS** (closer to streaming loudness).

## Troubleshooting

### `yt-dlp: command not found` / `ffmpeg: command not found` / `spawnSync yt-dlp ENOENT`

- Install via Homebrew / PATH on Windows, **or** run `npm run fetch-tools` and set `YOUTUBE_DJ_YTDLP` / `YOUTUBE_DJ_FFMPEG`, **or** use the packaged Electron app.
- Packaged builds embed tools under `resources\vendor` (Windows) or `Resources/vendor` (macOS). If that folder is missing the `.exe` / binaries, rebuild on **Windows** with `npm run electron:build:win` (or CI `windows-latest`) so `fetch-tools` fetched the correct files before packaging.

### `HTTP Error 403: Forbidden` / YouTube download failures

- **Update `yt-dlp`**: `brew upgrade yt-dlp`, or refresh bundled binaries with `npm run fetch-tools`, then rebuild the app if you distribute it.
- **Cookies**: try `YTDLP_COOKIES_FROM_BROWSER=chrome` (or `firefox`, etc.) while logged into YouTube in that browser.
- YouTube changes often; if problems persist, check [yt-dlp issues](https://github.com/yt-dlp/yt-dlp/issues).

### Thumbnail download fails

Optional; the run continues without cover art. Check network, video availability, and `yt-dlp` version.

### Normalization errors

- Ensure `ffmpeg` supports the `loudnorm` filter.
- Inspect `output/logs/*.loudnorm.json` and console output.

### macOS: app from `.dmg` won’t open (unsigned build)

Unsigned local builds may trigger Gatekeeper. Right-click the app → **Open**, or adjust Security & Privacy settings. For distribution outside your machine, plan for Apple code signing and notarization.

### Windows: app does not start or closes immediately (wrong CPU architecture)

Most Windows PCs are **x64** (Intel/AMD). Use the **x64** build: NSIS **`YouTube DJ Pipeline Setup x.x.x.exe`** or the **`…-win.zip`** from `npm run electron:build:win` / the `windows-latest` CI job—not a file named **`…-arm64-win.zip`**.

- If you accidentally install an **`arm64-win`** build (common when `electron-builder --win` was run from an Apple Silicon Mac without `--x64`), it will **not** run on an x64 PC. Rebuild with `npm run electron:build:win` (now pinned to **`--x64`**) or download the **Windows** artifact from [GitHub Actions](.github/workflows/electron-build.yml) (`windows-latest` produces x64).
- For releases, prefer CI or a Windows machine so `vendor\yt-dlp.exe` and `vendor\ffmpeg.exe` match Windows (see **Production build** above).

### Windows: SmartScreen or “Windows protected your PC”

Unsigned installers may be flagged. Users can use **More info → Run anyway**, or you can sign the app with an Authenticode certificate (see [electron-builder code signing](https://www.electron.build/code-signing)).

## Technical details

- **Audio**: MP3 320 kbps CBR, 44.1 kHz stereo  
- **Normalization**: EBU R128 (ITU-R BS.1770-4) via `ffmpeg` `loudnorm`  
- **ID3**: `node-id3`  
- **XML**: iTunes Music Library plist for Rekordbox  
- **YouTube**: `yt-dlp` with shared `--extractor-args` for player clients (see [`src/yt.js`](src/yt.js))

## License

This project is provided as-is for personal use.
