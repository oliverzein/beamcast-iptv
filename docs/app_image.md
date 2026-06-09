# Linux AppImage Build & Usage Guide

This document describes how to package Beamcast IPTV as an AppImage and run it on Linux.

---

## Prerequisites

Before building or running the application, ensure you have:
1. **Node.js** and **npm** installed (for building).
2. **System Playback Utilities** in your `PATH` (required for playback):
   - `ffmpeg` and `ffprobe` (for transcode proxy).
   - `mpv` (for launching in external player).

---

## Building the AppImage

To build the AppImage locally:

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Trigger Build Command:**
   ```bash
   npm run dist
   ```

3. **Output Directory:**
   The packaged binary will be generated in the `dist/` directory as `Beamcast IPTV-1.0.0.AppImage` (size: ~97MB).

---

## Running the AppImage

The AppImage is built using a **static AppImage runtime** (`toolsets.appimage: 1.0.3`), which integrates the squashfs mounting logic directly. **No system-level FUSE 2 (`libfuse.so.2`) library is required.**

To run the AppImage:

1. Make the binary executable:
   ```bash
   chmod +x dist/"Beamcast IPTV-1.0.0.AppImage"
   ```

2. Execute it:
   ```bash
   ./dist/"Beamcast IPTV-1.0.0.AppImage"
   ```

---

## Build Configuration Details

The AppImage packaging settings are configured in the `build` block of `package.json`:
- **appId:** `com.beamcast.iptv`
- **executableName:** `beamcast-iptv`
- **Linux Category:** `AudioVideo`
- **Icon:** `assets/logo.png`
- **Exclusions:** The `files` glob limits packaging to source files (`main.js`, `preload.js`, `renderer.js`, `index.html`, etc.) and `assets/`, excluding playlists and development docs.
