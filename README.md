# VocalMIX

A browser-based vocal mixing studio for "utaite" cover songs. This repository is the canonical source of VocalMIX; the app is published via GitHub Pages.

## Pages

- Live site: https://consulenteidealistas.github.io/VocalMIX/
- `index.html` — the main app (timeline, channel, effects, pitch correction, mixer)
- `manual.html` — the user manual (static page)
- `export.html` — the export page. Choosing Export in the main app hands the current project over to this page through IndexedDB, so rendering happens here without interrupting playback work on the main page.

The app starts with an empty timeline. Drag & drop your own audio files (karaoke backing + vocal takes) onto the page, or use "Load Demo Song" to load a built-in synthesized demo (backing + vocal + harmony).

## Features

- Multitrack playback with loop, seek, BPM and snap; a fixed transport bar stays at the bottom of the screen while the page scrolls
- Waveform clips: move, trim, split, fades; per-clip mute, duplicate, and gain/fade presets
- Pitch correction (VariAudio-style): YIN pitch detection, piano-roll note blocks, semitone drag with snap-to-note. Fully non-destructive — corrections live in a layer over the untouched original audio, with layer on/off (A/B), strength, presets, and per-note on/off. Monophonic vocals only; no chord separation, formant editing, per-note vibrato editing, or time stretching
- 5-band parametric EQ (drag editing + numeric input)
- Full-control compressor with gain-reduction meter
- Reverb / delay as inserts and sends/returns, bus routing
- Every FX stage is a unit: on/off, reorder, duplicate, reset, collapse, per-stage presets (built-in + named user presets, session-only). Mixer-wide presets as well (named saves are session-only)
- Volume / pan automation curves
- Export: WAV / MP3 (up to 48 kHz, 24-bit)

## Maintenance notes

- `index.html` and `export.html` contain the same app code and differ only in their boot scripts (`src/boot-index.html` / `src/boot-export.html` in the working copy). Apply functional changes to both. `manual.html` renders the manual text built into the app (`manualHTML()`); its boot script is `src/boot-manual.html`.
- Fonts are embedded as subset WOFF2 data URIs (Latin subsets): Cormorant Garamond (headings, labels, manual — SIL OFL), Jost (controls — SIL OFL), Cretino (wordmark — public domain, Typodermic). The background texture is an embedded photo of ebony wood.
