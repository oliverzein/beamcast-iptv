# AppImage Packaging Design

Design spec for packaging Beamcast IPTV as an AppImage for Linux platforms.

## Overview

The application will be packaged using `electron-builder`, which has built-in support for generating AppImages. The build will run locally. External dependencies (`ffmpeg`, `ffprobe`, `mpv`) will not be bundled; instead, the packaged app will rely on the host system's `PATH`.

## Proposed Changes

### Configuration Changes

#### [package.json](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/package.json)
- Add `electron-builder` to `devDependencies`.
- Add `dist` script to trigger packaging.
- Add `build` configuration specifying metadata, Linux target (`AppImage`), desktop category, and application icon.

```json
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder --linux AppImage"
  },
  "build": {
    "appId": "com.beamcast.iptv",
    "productName": "Beamcast IPTV",
    "directories": {
      "output": "dist"
    },
    "linux": {
      "target": [
        "AppImage"
      ],
      "category": "AudioVideo",
      "icon": "assets/logo.png"
    }
  }
```

## Verification Plan

### Manual Verification
1. Run `npm run dist` to build the AppImage locally.
2. Verify that the output directory `dist/` contains the `.AppImage` file.
3. Make the AppImage executable: `chmod +x dist/Beamcast_IPTV-*.AppImage`.
4. Execute the AppImage: `./dist/Beamcast_IPTV-*.AppImage`.
5. Verify that:
   - The app launches.
   - The UI loads successfully.
   - External dependencies (`ffmpeg`, `ffprobe`) are called correctly from system PATH.
   - Video streaming works correctly.
