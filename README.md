# DJ Pipeline

Turn a playlist link — or the music folder you already have — into DJ-ready files with measured BPM and key, phrase-aligned cue points, a suggested running order, and a Rekordbox XML to import it all with.

> Formerly "YouTube DJ Pipeline". The name lost its prefix once YouTube stopped being the only source: SoundCloud, Spotify and your own local library all go through the same pipeline. Nothing else changed — the same settings file, the same environment variables, and an existing output folder is still found and used.

## Features

- **Two ways in**: download from [YouTube, SoundCloud, or Spotify](#supported-sources), or [analyze a library you already own](#analyzing-a-library-you-already-have) in place
- **MP3 or FLAC**: MP3 320 kbps CBR at 44.1 kHz stereo, or FLAC 24-bit at the source sample rate
- **DJ-safe normalization**: Two-pass EBU R128 LUFS normalization (-9 LUFS, -1.0 dBTP true peak)
- **Automatic tagging**: Title, Artist, Album, Track Number, Year, and cover art (ID3 for MP3, Vorbis comments for FLAC)
- **Track analysis (optional)**: BPM, musical key (Camelot), energy rating, DJ style, and phrase-aligned cue points — see [Track analysis](#track-analysis)
- **Set suggestions (optional)**: A suggested running order plus per-transition mixing and effect advice — see [Set order and notes](#set-order-and-notes)
- **Rekordbox integration**: Generates a native Rekordbox `DJ_PLAYLISTS` XML carrying cue points and beatgrids
- **Desktop app**: Optional Electron UI with **bundled `yt-dlp` and `ffmpeg`** in release builds (macOS `.dmg` / `.zip`, Windows NSIS **Setup `.exe`** + `.zip`)
- **CLI**: Same pipeline from the terminal with system or vendor binaries

## Supported sources

Paste a playlist, album, set, or single-track URL. The source is detected from the hostname in [`src/urlPolicy.js`](src/urlPolicy.js); anything else is rejected as an invalid URL.

| Source | Accepted URLs | Notes |
| --- | --- | --- |
| **YouTube** | `youtube.com/playlist?list=…`, `watch?v=…`, `/shorts/…`, `youtu.be/…` | Downloaded directly by `yt-dlp` |
| **SoundCloud** | `soundcloud.com/user/track`, `soundcloud.com/user/sets/…` | Downloaded directly by `yt-dlp`; a `/sets/` path is treated as a playlist |
| **Spotify** | `open.spotify.com/{track,album,playlist}/…`, `spotify:track:…` URIs | Metadata only; audio is matched on YouTube (see below). Needs [Spotify credentials](#spotify-credentials) |

Spotify cannot be downloaded from directly. The pipeline reads the track list through the Spotify Web API, then searches YouTube for each `artist + title`. If the top hit's duration differs from Spotify's by more than 40%, it retries with a wider search and picks the closest match by duration. Titles, artists, album, track numbers, and cover art still come from Spotify, so tags stay accurate even though the audio comes from YouTube.

There is also a fourth source that is not a URL at all: a folder or file on your own disk. See [Analyzing a library you already have](#analyzing-a-library-you-already-have).

## Analyzing a library you already have

Choose **Analyze my library** from the main menu, or pass a path instead of a URL on the CLI. Everything after the download step is identical: BPM, key, energy, style, cue points, the suggested order and the Rekordbox XML.

```bash
npm run run -- ~/Music/Techno --set-order
npm run run -- "~/Music/Techno/Some Track.flac"
```

The argument is treated as a local path when it exists on disk and as a URL otherwise, so nothing needs a flag.

**Your files are analyzed where they are.** Nothing is copied, converted, renamed or moved, and the XML points at your existing library — the same thing Rekordbox and Mixed In Key do. Only two files are written to the output folder: `rekordbox.xml` and `set-notes.md`. Pointing this at a 200 GB library does not need 200 GB.

| | |
| --- | --- |
| **Read** | `.mp3`, `.flac`, `.wav`, `.aiff`, `.aif`, `.m4a`, `.aac` — the formats Rekordbox itself can play |
| **Searched** | Sub-folders included; hidden folders and macOS `._` resource-fork stubs are skipped |
| **Sorted** | By path, numerically, so `track2` comes before `track10` |
| **Named** | From the file's own tags, falling back to `Artist - Title.ext` in the filename |
| **Tagged** | BPM, key and style are written back into `.mp3` and `.flac` only |

That last row matters. WAV and AIFF keep metadata in RIFF/IFF chunks and M4A in MP4 atoms, none of which the ID3 library understands — it would prepend an ID3 header to a file with nowhere to put one, which some players read as corruption. Those files are left byte-for-byte alone and the run says how many were skipped. Their BPM, key and style still reach Rekordbox through the XML.

Folder names are used as a hint when classifying style, because a track filed under `Melodic Techno/` has been labelled by someone who knows. Analysis is always on here; there is nothing else for this mode to do.

## How it works

1. **Track list fetch**: `yt-dlp` retrieves playlist metadata (`--flat-playlist` JSON) for YouTube and SoundCloud; the Spotify Web API is used for Spotify URLs.
2. **Track download**: One `yt-dlp` invocation per track fetches the best audio stream, the full metadata JSON, and the cover art together (YouTube client args tuned to reduce CDN 403 issues). Spotify tracks first resolve to a YouTube match, and prefer Spotify's own album art. SoundCloud artwork is not fetched, so those tracks are tagged without a cover. Cover art is always optional; failures are non-fatal.
3. **LUFS normalization**: Two-pass `loudnorm` then MP3 or FLAC encode via `ffmpeg`, written to a `.part` file and renamed on success.
4. **Analysis** (optional): Once every download is finished, each file is measured for BPM, key, energy, and structure; cue points are generated and a DJ style is determined. See [Track analysis](#track-analysis).
5. **Set order** (optional): The analysed tracks are sequenced into a suggested running order and `set-notes.md` is written. See [Set order and notes](#set-order-and-notes).
6. **Tags + Rekordbox XML**: Tagged audio files and `rekordbox.xml` (only if at least one track completed).
7. **Cleanup**: Each track's scratch directory is removed whether it succeeded or failed, and `tmp/` is swept at the start of every run.

Tracks are processed by a bounded concurrent pool (default `min(4, ceil(cpus / 2))`, override with `YOUTUBE_DJ_CONCURRENCY`). Results are reassembled in playlist order, so the XML and the failure CSV do not depend on which track finished first.

If a track fails (unavailable or private track, network error, no YouTube match for a Spotify entry, etc.), the pipeline **continues** with the rest of the list. Failed entries are listed in the Electron UI and written to **`download_failures.csv`** in the output folder (`url`, `title`, `reason`).

### Output structure

By default the CLI writes under `./output`. The Electron app uses a folder you choose in **Settings**, remembered between launches. New installs suggest `Documents/DJ Pipeline output`; if a `Documents/YouTube DJ Pipeline output` folder already exists it stays the default, so the rename cannot strand an existing library.

Analyzing a local library writes only `rekordbox/rekordbox.xml` and `set-notes.md` here — the audio stays where it is.

```
output/
├── audio/
│   └── Track Name.mp3      # or .flac
├── logs/
│   ├── VIDEO_ID.json
│   └── VIDEO_ID.loudnorm.json
├── rekordbox/
│   └── rekordbox.xml
├── set-notes.md            # only with set order enabled
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
npm run run -- "https://soundcloud.com/artist/sets/YOUR_SET" --format=flac
npm run run -- "https://open.spotify.com/album/YOUR_ALBUM_ID"
npm run run -- ~/Music/Techno --set-order
```

Paste the URL **without** shell escapes; quotes are enough. A path that exists on disk is [analyzed in place](#analyzing-a-library-you-already-have) instead of being treated as a URL.

`--format` accepts `mp3` (default) or `flac`; see [Audio format](#audio-format).

| Flag | Effect |
| --- | --- |
| `--analyze` | Measure BPM, key and energy, generate cue points, and classify the style |
| `--beatgrid` | Also write a beatgrid into the XML |
| `--set-order` | Add a suggested-order playlist and write `set-notes.md` |

`--beatgrid` and `--set-order` are both derived from the analysis, so either one turns it on; `--analyze` on its own is only needed when you want neither. A local path implies all of it.

```bash
npm run run -- "https://www.youtube.com/playlist?list=YOUR_PLAYLIST_ID" --analyze --set-order
```

Output goes to `./output` relative to the current working directory.

A progress bar is drawn on the last line while a run is in flight:

```
[███████████░░░░░░░░░░░░░]  46%  Track 19 of 40: Some Track Name
```

It appears **only when the terminal is interactive**. Piping to a file or a CI log gets plain output with no escape codes, so nothing needs to be stripped afterwards. Redraws are capped at about ten a second, and log lines erase the bar before printing and redraw it after, so the two never fight over the line.

**Exit codes (CLI):** `0` if at least one track was saved (partial success is OK). `1` on fatal errors — invalid URL, playlist fetch failed, tools missing, a local path with no audio in it — or when **no** tracks completed successfully. `130` after Ctrl+C, as a shell expects.

### Desktop app (Electron)

**Development** (after `npm install`; run `npm run fetch-tools` once so `vendor/` exists, or rely on system `yt-dlp` / `ffmpeg`):

```bash
npm run electron:dev
```

**Production build**

`npm run fetch-tools` downloads **host-native** `yt-dlp` and `ffmpeg` into `vendor/`. Run the build on the same OS you are releasing for so the bundled binaries match (do not build a Windows installer using a `vendor/` folder produced on macOS). **Windows packaged builds must contain `vendor/yt-dlp.exe` and `vendor/ffmpeg.exe`**—if the app says tools are missing, rebuild after `npm run fetch-tools` on Windows (or use a CI artifact from `windows-latest`).

| Command | When to use |
|---------|-------------|
| `npm run electron:build` | Current OS (macOS → `.dmg` + `.zip`; Windows → NSIS Setup + `.zip`) |
| `npm run electron:build:mac` | macOS only (e.g. CI on `macos-latest`) |
| `npm run electron:build:win` | **Windows x64** only (CI on `windows-latest` or a Windows PC). Uses `electron-builder --win --x64` so Intel/AMD PCs get the right build. |

Artifacts land in `dist/`:

- **macOS**: `.dmg`, `-mac.zip` (names depend on arch, e.g. `arm64`)
- **Windows (x64)**: NSIS installer (e.g. `DJ Pipeline Setup x.x.x.exe`) and a portable `.zip` (e.g. `…-1.0.0-win.zip` when only x64 is built). These run on typical Intel/AMD PCs. **Do not** use an **`arm64-win`** zip on an x64 machine—see troubleshooting below.

**Code signing**: Optional on both platforms; reduces Gatekeeper / SmartScreen friction. See [electron-builder code signing](https://www.electron.build/code-signing) (macOS notarization, Windows Authenticode / `CSC_LINK`).

**CI**: [`.github/workflows/electron-build.yml`](.github/workflows/electron-build.yml) runs `electron:build:mac` and `electron:build:win` on separate runners and uploads `dist/` as artifacts.

#### Using the app

The app opens on a main menu with three entries:

| Screen | What it is for |
| --- | --- |
| **Download tracks** | Paste a playlist, set, or single-track URL and choose MP3 or FLAC |
| **Analyze my library** | Choose a folder or a single file you already own; analysis is always on |
| **Settings** | Output folder, proxy, and an optional AI key — these apply to every run |

The first launch shows the menu; later launches reopen whichever task you used last, with a back arrow in the header to return to the menu. Back is disabled while a run is going, so the progress bar cannot be navigated away from.

Press **Start**, watch the bar, then **Open output folder** when it finishes. **Stop** aborts between tracks. If some tracks fail, a **Failed tracks** section lists them and points to **`download_failures.csv`** when it was written.

**Windows installer (NSIS):** If the installer says it cannot close the app, **quit DJ Pipeline completely** (all windows), then click **Retry**. Reinstalling while the app is running can block the installer.

**Uninstalling (Windows):** The NSIS setup registers the app in **Settings → Apps → Installed apps** (or **Control Panel → Programs and Features** on older Windows) as **DJ Pipeline**—use **Uninstall** there. You can also run the uninstaller from the installation folder (same folder as the app), or use the **Uninstall DJ Pipeline** shortcut in the **Start menu** folder for this app. The portable **`.zip`** build has no installer or uninstaller; delete the folder to remove it.

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
| `SPOTIFY_CLIENT_ID` | Spotify Web API client ID; only needed for Spotify URLs |
| `SPOTIFY_CLIENT_SECRET` | Spotify Web API client secret; only needed for Spotify URLs |
| `YOUTUBE_DJ_CONCURRENCY` | Tracks processed in parallel. Defaults to `min(4, ceil(cpus / 2))`; set to `1` to force sequential |
| `YOUTUBE_DJ_ANALYSIS_CONCURRENCY` | Tracks analysed in parallel. Separate from the download limit because analysis is CPU-bound rather than network-bound. Defaults to `min(4, ceil(cpus / 2))` |
| `YOUTUBE_DJ_SAVE_RAW_META` | `1` to keep each track's raw `yt-dlp` metadata JSON under `output/logs/` |
| `YOUTUBE_DJ_AI_API_KEY` / `OPENAI_API_KEY` | Enables the optional AI transition advice. See [Optional AI advice](#optional-ai-advice) |
| `YOUTUBE_DJ_AI_MODEL` | Model for the AI advice. Defaults to `gpt-4o-mini` |
| `YOUTUBE_DJ_AI_BASE_URL` | OpenAI-compatible endpoint for the AI advice. Defaults to `https://api.openai.com/v1` |
| `YOUTUBE_DJ_PROXY` | Proxy for every `yt-dlp` request, e.g. `socks5://127.0.0.1:1080` or `http://host:3128`. Use for tracks blocked in your region |
| `YOUTUBE_DJ_GEO_FALLBACK` | `0` to disable looking up a region-blocked track on YouTube, so it fails instead |

Example:

```bash
YTDLP_COOKIES_FROM_BROWSER=chrome npm run run -- "PLAYLIST_URL"
YOUTUBE_DJ_PROXY=socks5://127.0.0.1:1080 npm run run -- "TRACK_URL"
```

## Rekordbox import

The pipeline writes `output/rekordbox/rekordbox.xml` in Rekordbox's own `DJ_PLAYLISTS` format. Importing it is a two-step process, and **nothing appears in your collection until you do the second step** — the imported tree is read-only until you copy tracks out of it.

1. Open Rekordbox.
2. **Preferences → Advanced → Database → rekordbox xml → Imported Library**, and select `output/rekordbox/rekordbox.xml` (or the same path under your chosen output folder).
3. **Preferences → View → Layout**, and tick **rekordbox xml** so the tree appears in the left sidebar.
4. In the sidebar, open **rekordbox xml → Playlists** and find the playlist named after your source.
5. **Select the tracks, right-click, and choose "Import to Collection."**

Cue points and (if enabled) the beatgrid come across with the tracks. If cues do not appear, the usual cause is a track whose `TotalTime` attribute is missing — Rekordbox imports such a track but silently discards its cues. The pipeline always writes `TotalTime`, falling back to the duration reported by `yt-dlp` when analysis is off, and to an `ffmpeg` header probe for a local file whose analysis failed.

To see keys as Camelot codes (`8A`) rather than classical names (`Am`), set **Preferences → View → Colour/Key display → Key display format → Alphanumeric**. The XML stores the classical name, which is what Rekordbox itself writes; the Camelot code is written into the file's own tags as `CAMELOTKEY`.

## Track analysis

Off by default for downloads, always on when [analyzing a local library](#analyzing-a-library-you-already-have). Enable it with the **"Analyze tracks"** checkbox in the desktop app, or `--analyze` on the CLI.

Analysis runs after every download has finished, reading the final encoded files. It costs roughly **4% of each track's length** (about 15 seconds for a 6-minute track), and several tracks are analysed in parallel. A track that fails to analyse keeps its metadata and simply carries no cue points; it never fails the run.

### What gets measured

| Value | Written to |
| --- | --- |
| **BPM** | `AverageBpm` in the XML, `TBPM`/`BPM` tag in the file |
| **Key** | `Tonality` in the XML (classical, e.g. `Am`), `TKEY`/`INITIALKEY` and `CAMELOTKEY` (e.g. `8A`) in the file |
| **Energy** 1–10 | `ENERGYLEVEL` tag in the file |
| **Style** | `Genre` in the XML, `TCON`/`GENRE` tag in the file |
| **Cue points** | `POSITION_MARK` elements in the XML |
| **Beatgrid** (opt-in) | `TEMPO` element in the XML |

### What the cue points mean

Every cue is snapped to an 8, 16, or 32-bar phrase boundary, because electronic arrangements are phrase-quantised — a cue on the right downbeat is mixable even if its label is debatable, while one that is a second early is not.

| Cue | Slot | Position |
| --- | --- | --- |
| **Mix in** | Hot cue A | 32 bars after the track proper starts |
| **Drop** | Hot cue B | Where the kick returns after the longest breakdown |
| **Mix out** | Hot cue C | 32 bars before the music ends |
| **Intro / Breakdown / Outro** | Memory cues | Section boundaries |

Only hot cues A, B, and C are used. Pioneer documents `Num` values `0`, `1`, `2`, and `-1` (memory cue) only, and the one available report of `Num="3"` says it failed to set hot cue D, so the pipeline stays inside the documented range. Memory cues have no count limit and CDJs step through them with the cue button.

Cues are only emitted where they make sense: a track with no breakdown gets no drop cue rather than a fabricated one, and a clip too short for a 32-bar intro gets a single load-point cue instead of mix cues past its own end.

### Beatgrid

Separately opt-in, and **off even when analysis is on**. Rekordbox's own grid detection is very good on 4/4 material, and an imported grid that is one beat out is more work to fix than no grid at all. Enable it only if you have reason to prefer ours.

### Accuracy

BPM detection is reliable on 4/4 electronic material — it returns 128.0 on a synthetic 128 BPM reference and 128.0–128.1 on real tracks labelled 128 BPM. Extreme octave errors (below 70 or above 200 BPM) are folded back into range, but half-time genres such as 174 BPM drum and bass are left alone.

Key detection should be treated as a **hint, not as authoritative**. An [EDM-specific evaluation](https://doi.org/10.5281/zenodo.1414995) found Rekordbox's own key detection (71.9% correct) beat the open-source options. The key is computed here because the value is needed *before* import for harmonic set ordering, not because it is better than what Rekordbox will work out itself.

## Style classification

The style — `melodic techno`, `tech house`, `hard techno` and so on — is read from what the upload says about itself, and only guessed from the audio when it says nothing.

**Keywords first.** A curated vocabulary is matched against the title, the `genre` field, the tags, the description and the uploader name, in that order of trust. Titles are reliable; tags drift off-topic; descriptions are mostly links. A video titled "MELODIC TECHNO MIX" has already answered the question, and no amount of signal processing improves on that.

Two rules decide between overlapping matches. Subgenres beat their parents, so `tech house` is never reduced to `house`. Where two equally specific styles both appear, the one named first wins — "House / techno drum loops" is filed as house, because that is what the uploader led with.

`categories` is deliberately ignored: YouTube returns generic buckets like "Music" or "People & Blogs" that never name a style.

**Tempo as a fallback, and only a coarse one.** When nothing is named, the style is inferred from BPM and energy, and the run log marks it `(inferred)`. The inference is restricted to broad families — house, techno, trance, drum and bass, downtempo, hardcore — because tempo genuinely cannot tell tech house from melodic techno from progressive house. All three sit at 125–128 BPM. A confident "melodic techno" derived from a tempo reading would be a guess wearing a measurement's clothes.

The `Genre` field itself is written unqualified either way, so Rekordbox's genre filter still groups a style into one entry rather than splitting it into "Techno" and "Techno (guessed)". Where a style was inferred rather than stated, `set-notes.md` says so.

**Why there is no machine learning here.** Essentia.js ships wrappers for `TensorflowMusiCNN` and `TensorflowVGGish` only. The one electronic-genre model that fits, `genre_electronic-musicnn`, has five classes and was trained on 250 samples; the richer Discogs400 taxonomy needs EffNet, which has [no wrapper](https://github.com/MTG/essentia.js/issues/134). Neither offers the vocabulary a DJ actually uses, and adding TensorFlow.js to reach a worse answer than reading the title was not a trade worth making.

## Set order and notes

Off by default, and needs analysis. Enable it with the **"Suggest a set order"** checkbox, or `--set-order` on the CLI.

It produces two things:

- A **second playlist** in `rekordbox.xml`, named `<your playlist> (suggested order)`. Your original order is kept as the first playlist and is never modified — both point at the same collection entries, so the extra playlist costs nothing but a list of IDs.
- **`set-notes.md`** in the output folder: the running order with each track's tempo, key, energy and style, and advice for every transition.

### How the order is chosen

Each possible transition is scored on four measured relationships: harmonic compatibility on the Camelot wheel, tempo proximity, energy movement, and how close the two styles sit. Tempo and key carry most of the weight, because they are what makes a blend possible at all — 87 into 174 BPM scores as a match, since half-time is an ordinary move, while a 12% gap does not, because a CDJ's pitch fader will not reach.

The search is a greedy nearest-neighbour pass from the lowest-energy track followed by 2-opt refinement. It optimises for the shape of the whole set as well as the individual joins: warm up, peak about three quarters through, then come down. A set of nothing but perfectly smooth transitions is a flat set that never goes anywhere.

Your own order is refined too, and whichever scores higher is the one you get, so the suggestion is never worse than what you started with.

### What the notes say

Because every track already has mix-in and mix-out cues from the analysis, the advice can name exact times rather than vague instructions:

```
### 3. Minimal Techno

128.1 BPM · 3B (Db) · energy 8/10 · minimal techno

Cues: mix in 1:05, drop 2:30, mix out 5:00.

**Coming from "Hey Boy Hey Girl":** same key, beatmatch straight.

Start the blend at 5:00 (the outgoing track's Mix out) and bring this one in at 1:05 (its Mix in).

Everything agrees here, so take your time: a long blend over 32 to 64 beats.

- no effects needed; swap the basslines on the phrase boundary
```

Technique and effects follow from the measured relationship rather than a generic list: echo to cover a key clash, a filter sweep for an energy jump, a long blend when everything agrees and a short cut when it does not.

### Optional AI advice

If an API key is present, the per-transition advice is enriched by a language model. Without one this is skipped silently, and every failure — a rejected key, a network error, a malformed reply — falls back to the rule-based text, which is written either way.

| Variable | Meaning |
| --- | --- |
| `YOUTUBE_DJ_AI_API_KEY` or `OPENAI_API_KEY` | Enables the layer. Absent means off |
| `YOUTUBE_DJ_AI_MODEL` | Defaults to `gpt-4o-mini` |
| `YOUTUBE_DJ_AI_BASE_URL` | Defaults to `https://api.openai.com/v1`; point it at any OpenAI-compatible endpoint |

The desktop app has a field for the key under **Settings**, which writes it to `~/.youtube-dj/config.json` (mode `0600`, readable only by you) under an `ai` object rather than to browser storage. The CLI reads the same file, so a key entered once in the app works in the terminal too. Environment variables still win, which is what lets you override a saved key for a single run.

**What is sent.** Numbers only: the tempo, Camelot key, energy rating and style label of each pair, plus the harmonic move and tempo gap already computed. **No audio, no track titles, no artists, no URLs and no file paths ever leave the machine.** Transition advice is a question about those numbers, so nothing identifying is needed to answer it. This is enforced in [`src/setlist/ai.js`](src/setlist/ai.js) and asserted by a test rather than left to a comment.

**What it does not do.** It never reorders the set. An LLM asked to sequence tracks gives a different answer every run and cannot actually compare tempo distances, so the optimiser keeps the running order and the model only adds phrasing on top of decisions already made.

## Configuration

### Spotify credentials

Only needed for Spotify URLs. Create an app at the [Spotify developer dashboard](https://developer.spotify.com/dashboard) to get a client ID and secret, then use either environment variables:

```bash
export SPOTIFY_CLIENT_ID="your_client_id"
export SPOTIFY_CLIENT_SECRET="your_client_secret"
```

or a config file at `~/.youtube-dj/config.json`, which the packaged desktop app can read without a shell environment:

```json
{
  "spotify": {
    "clientId": "your_client_id",
    "clientSecret": "your_client_secret"
  },
  "ai": {
    "apiKey": "sk-…",
    "model": "gpt-4o-mini"
  }
}
```

The directory keeps its original name despite the rename, because it already holds credentials on existing installs and moving it would log people out to buy nothing but a tidier path. Environment variables take precedence. Credentials are checked before the run starts, so a missing setup fails immediately instead of part-way through a playlist.

### Audio format

Pick **MP3** or **FLAC** from the *Audio format* dropdown in the Electron app (the choice is remembered between launches), or pass `--format=mp3` / `--format=flac` on the CLI. MP3 is the default.

|  | MP3 | FLAC |
| --- | --- | --- |
| Codec | libmp3lame 320 kbps CBR | FLAC, compression level 5 |
| Sample rate / channels | 44.1 kHz stereo | source rate and channel count |
| Bit depth | n/a | 24-bit |
| Tags | ID3 via `node-id3` | Vorbis comments written by `ffmpeg` |
| Size | ~1 MB per minute | roughly 4–6× larger |

Both formats get the same two-pass `loudnorm` treatment, so FLAC files are DJ-normalized rather than untouched copies.

FLAC uses compression level 5, ffmpeg's default. Level 8 is markedly slower for a few percent of file size, which is a poor trade when every track is already paying for two `loudnorm` passes.

**FLAC is not a lossless master.** YouTube, SoundCloud, and Spotify-matched sources deliver lossy audio (Opus or AAC). FLAC is lossless only with respect to the decoded stream plus the applied normalization: it avoids a second generation of lossy encoding, but it cannot recover detail the source already discarded.

### LUFS target

Defaults are applied in the `loudnormTwoPassEncode` call in [`src/pipeline.js`](src/pipeline.js) (per-track processing) and the function default in [`src/audio.js`](src/audio.js):

```javascript
loudnormTwoPassEncode(tmpFile, outFile, loudnormLog, {
  i: -9,    // integrated loudness (LUFS)
  tp: -1.0, // true peak (dBTP)
  lra: 8    // loudness range
}, signal, { format, coverPath, meta });
```

Common choices: **-9 LUFS** (DJ-oriented) vs **-14 LUFS** (closer to streaming loudness).

## Troubleshooting

### The app is slow, or seems to hang

The desktop app writes a JSON-lines log with every child-process launch and its duration. Find it at:

| OS | Path |
|----|------|
| macOS | `~/Library/Logs/youtube-dj-pipeline/pipeline.log` |
| Windows | `%APPDATA%\youtube-dj-pipeline\logs\pipeline.log` |

To measure the vendored binaries directly:

```bash
npm run measure-tools
```

`yt-dlp` costs roughly 10 s per launch on macOS regardless of what it is asked to do: it is a PyInstaller one-file bundle that re-extracts a Python runtime on every exec. That is why the pipeline invokes it once per track rather than three times. `ffmpeg` starts in single-digit milliseconds.

On Windows the vendored `ffmpeg.exe` is large (~109 MB; it is a full static build, whereas macOS uses a leaner `ffmpeg-static` binary at ~46 MB). If the first run of a session is slow, compare `npm run measure-tools` before and after adding a Defender exclusion for `vendor/`:

```powershell
Add-MpPreference -ExclusionPath (Resolve-Path vendor)
```

### `yt-dlp: command not found` / `ffmpeg: command not found` / `spawnSync yt-dlp ENOENT`

- Install via Homebrew / PATH on Windows, **or** run `npm run fetch-tools` and set `YOUTUBE_DJ_YTDLP` / `YOUTUBE_DJ_FFMPEG`, **or** use the packaged Electron app.
- Packaged builds embed tools under `resources\vendor` (Windows) or `Resources/vendor` (macOS). If that folder is missing the `.exe` / binaries, rebuild on **Windows** with `npm run electron:build:win` (or CI `windows-latest`) so `fetch-tools` fetched the correct files before packaging.

### `HTTP Error 403: Forbidden` / download failures

- **Update `yt-dlp`**: `brew upgrade yt-dlp`, or refresh bundled binaries with `npm run fetch-tools`, then rebuild the app if you distribute it.
- **Cookies**: try `YTDLP_COOKIES_FROM_BROWSER=chrome` (or `firefox`, etc.) while logged into YouTube in that browser.
- YouTube and SoundCloud change often and break extractors. `Unable to extract client id` (SoundCloud) or a download that writes a file named after the raw media URL (YouTube) both mean the bundled `yt-dlp` is too old — update it first. If problems persist, check [yt-dlp issues](https://github.com/yt-dlp/yt-dlp/issues).

### `This video is not available from your location due to geo restriction`

The track is blocked for your IP, so nothing local can unblock it — `yt-dlp`'s header-level bypass (`--xff`) has no effect on SoundCloud, which enforces the block in its API.

Two ways out, and the second needs no setup:

- **Proxy or VPN**: set `YOUTUBE_DJ_PROXY=socks5://127.0.0.1:1080` (CLI) or fill in *Proxy* in the desktop app, then start again.
- **Automatic YouTube substitute** (default): the pipeline reads the blocked page for the artist, title and duration, searches YouTube for the same track, and downloads that instead. The log names the substitute, and the exported file keeps the original title and artist. Set `YOUTUBE_DJ_GEO_FALLBACK=0` to turn this off.

A whole SoundCloud `/sets/` URL that is blocked cannot be rescued: nothing can list its tracks, so it fails with a proxy hint. Blocked tracks *inside* a readable set are substituted individually.

### Thumbnail download fails

Optional; the run continues without cover art. Check network, track availability, and `yt-dlp` version.

### Normalization errors

- Ensure `ffmpeg` supports the `loudnorm` filter.
- Inspect `output/logs/*.loudnorm.json` and console output.

### macOS: app from `.dmg` won’t open (unsigned build)

Unsigned local builds may trigger Gatekeeper. Right-click the app → **Open**, or adjust Security & Privacy settings. For distribution outside your machine, plan for Apple code signing and notarization.

### Windows: app does not start or closes immediately (wrong CPU architecture)

Most Windows PCs are **x64** (Intel/AMD). Use the **x64** build: NSIS **`DJ Pipeline Setup x.x.x.exe`** or the **`…-win.zip`** from `npm run electron:build:win` / the `windows-latest` CI job—not a file named **`…-arm64-win.zip`**.

- If you accidentally install an **`arm64-win`** build (common when `electron-builder --win` was run from an Apple Silicon Mac without `--x64`), it will **not** run on an x64 PC. Rebuild with `npm run electron:build:win` (now pinned to **`--x64`**) or download the **Windows** artifact from [GitHub Actions](.github/workflows/electron-build.yml) (`windows-latest` produces x64).
- For releases, prefer CI or a Windows machine so `vendor\yt-dlp.exe` and `vendor\ffmpeg.exe` match Windows (see **Production build** above).

### Windows: SmartScreen or “Windows protected your PC”

Unsigned installers may be flagged. Users can use **More info → Run anyway**, or you can sign the app with an Authenticode certificate (see [electron-builder code signing](https://www.electron.build/code-signing)).

## Technical details

- **Audio**: MP3 320 kbps CBR at 44.1 kHz stereo, or FLAC 24-bit at the source rate  
- **Normalization**: EBU R128 (ITU-R BS.1770-4) via `ffmpeg` `loudnorm`  
- **Tags**: `node-id3` for MP3; `ffmpeg` Vorbis comments for FLAC (FLAC re-tagging after analysis is an `ffmpeg -c copy` remux, since Vorbis comments are written at encode time)  
- **XML**: Rekordbox `DJ_PLAYLISTS` format (see [`src/rekordboxDjPlaylists.js`](src/rekordboxDjPlaylists.js))  
- **Analysis**: [Essentia.js](https://mtg.github.io/essentia.js/) (WebAssembly) for BPM and key; band-energy envelopes, structure detection and style classification in plain JS (see [`src/analysis/`](src/analysis))  
- **Set building**: transition scoring, greedy plus 2-opt ordering, and note rendering, all dependency-free (see [`src/setlist/`](src/setlist))  
- **Sources**: YouTube and SoundCloud via `yt-dlp`; Spotify via the Web API with YouTube matching (see [`src/urlPolicy.js`](src/urlPolicy.js) and [`src/spotify/`](src/spotify))  
- **YouTube**: `yt-dlp` with shared `--extractor-args` for player clients (see [`src/yt.js`](src/yt.js))

Essentia ships as WebAssembly rather than a native binary, so analysis needs no per-platform download, no code signing, and nothing for Windows Defender to scan on first run. It is fed raw PCM decoded by the `ffmpeg` already in `vendor/`, and runs inside the Electron `utilityProcess` so a CPU-heavy analysis pass cannot freeze the window.

## License

This project is provided as-is for personal use.

**Note on Essentia's licence.** The optional analysis feature depends on [Essentia](https://essentia.upf.edu/licensing_information.html), which is licensed **AGPL-3.0**. That is compatible with personal, non-distributed use of this project. If you intend to distribute this application or offer it as a network service, you would need to either comply with the AGPL (including releasing your source) or obtain a commercial licence from the Music Technology Group at Universitat Pompeu Fabra. Everything except the analysis phase works with Essentia removed, and the pipeline degrades gracefully — it logs that the analysis engine is unavailable and writes the XML without cue points.
