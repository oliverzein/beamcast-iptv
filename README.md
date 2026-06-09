# 📡 Beamcast IPTV

Beamcast IPTV is a premium, modern, cyberpunk-themed desktop IPTV player built with Electron, HTML5, and JavaScript. It features an on-the-fly audio/video transcoding proxy server, a high-performance database caching layer via IndexedDB, and native external player integration.

## 🚀 Features

- **Modern Cyberpunk UI**: Sleek glassmorphism layout, vibrant neon accents, custom scrollbars, and micro-animations.
- **On-the-fly AC-3/E-AC-3 Audio Transcoding**: Bypasses Chromium's codec restrictions by transcoding AC-3 streams to AAC in real-time.
- **Hardware-Accelerated H.265/HEVC Support**: Automatically detects browser capability and enables copy-mode (0% CPU) when GPU-accelerated HEVC decoding is supported.
- **External MPV Player Integration**: Instant "Play in MPV" button for zero-lag hardware decoding of high-bitrate 4K HEVC streams.
- **IndexedDB Caching**: Caches Xtream Codes categories and channel data locally, eliminating redundant full syncs.
- **State Restoration**: Restores previous account, selected category, and active playing channel on startup.

## 🛠️ Prerequisites

- **Node.js** (v18+)
- **FFmpeg** and **FFprobe** (must be available in your system's PATH)
- **MPV Media Player** (optional, recommended for 4K HEVC content)

## 📦 Installation & Setup

### Option A: Direct Desktop Installation (Linux One-liner)
You can install the latest compiled AppImage directly into your application launcher without cloning the repository (uses a static FUSE-free runtime):
```bash
curl -sL "https://cdn.jsdelivr.net/gh/oliverzein/beamcast-iptv@main/scripts/install.sh" | bash
```

### Option B: Local Development Run
If you want to run the project from source:

1. Clone this repository:
   ```bash
   git clone https://github.com/oliverzein/beamcast-iptv.git
   cd beamcast-iptv
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Launch the application:
   ```bash
   npm start
   ```

### Option C: Build AppImage Locally
To package the AppImage yourself locally, run:
```bash
npm run dist
```
For more packaging and release details, see [docs/app_image.md](docs/app_image.md).

## 📜 License

This project is licensed under the ISC License.
