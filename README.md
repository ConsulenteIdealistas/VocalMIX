# VocalMIX

A browser-based vocal mixing studio for "utaite" cover songs. This repository is the canonical source of VocalMIX; the app is published via GitHub Pages.

## Pages

- Live site: https://consulenteidealistas.github.io/VocalMIX/
- `index.html` — the main app (timeline, channel, effects, pitch correction, mixer)
- `manual.html` — the user manual (static page)
- `export.html` — a dedicated export-only page. Choosing Export in the main app hands the current project over to this page through IndexedDB; the page shows only the export controls (format, sample rate, bit depth, file name) with the project summary and a back link, so rendering happens here without interrupting playback work on the main page.
- `pitch.html` — a dedicated full-screen pitch-correction page. "Open Full-Screen Editor" in the Pitch Correction tab hands the project over the same way; the page keeps only the pitch editor (plus the bottom transport bar for auditioning), which gives the piano roll the full width — built for phones. "Save & Back" returns only the edited pitch layer; the main page restores the project and applies it. "Discard & Back" restores the project unchanged.

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
- Language: the UI switches between English and Japanese (EN / 日本語 toggle in the top bar; the choice is remembered across all four pages). The manual page follows the same setting.

## Maintenance notes

- Pages are assembled by `src/assemble_pages.py` from a page shell (`src/app-master.html`), shared assets (`src/app.css` / `src/app.js`, referenced with a content-hash `?v=` so deploys never mix stale assets with fresh HTML), and one boot script per page (`src/boot-index.html` / `src/boot-export.html` / `src/boot-pitch.html` / the manual boot from `src/build_bilingual.py`). `src/build_bilingual.py` is a library (JA dictionary, i18n layer, font subsets, manual boot) — it no longer assembles pages. Generated parts (Japanese @font-face CSS, the language layer) are injected into the shared assets at the `/*VM:FONTS*/` / `/*VM:I18N*/` markers during assembly. `manual.html` renders the manual text built into the app (`manualHTML()`), or the stored Japanese manual when the language is set to Japanese.
- Fonts are embedded as subset WOFF2 data URIs: Cormorant Garamond (headings, labels, manual — SIL OFL), Jost (controls — SIL OFL), Cretino (wordmark — public domain, Typodermic), plus Zen Kaku Gothic New (all Japanese text — SIL OFL), subset to the characters the Japanese UI and manual use. The background texture is an embedded photo of ebony wood.

## Page photos

All three photographs are public domain, via Wikimedia Commons:

- Main page — RCA Studio A main sound room, Nashville.
- Export page — Telefunken tape recorders in a Finnish television studio control room, 1958.
- Manual page — a Finnish radio drama studio, 1944.
