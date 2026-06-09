# AppImage Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the Beamcast IPTV application into a Linux AppImage using `electron-builder` without bundling external dependencies (relying on system PATH).

**Architecture:** Add `electron-builder` to `devDependencies`, configure the package scripts and build settings in `package.json`, and run the build command to generate the AppImage in a `dist/` directory.

**Tech Stack:** Node.js, npm, Electron, electron-builder.

---

### Task 1: Install electron-builder

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install electron-builder as a development dependency**

  Run: `npm install --save-dev electron-builder`
  Expected: Package is successfully installed and added to `devDependencies` in `package.json`.

- [ ] **Step 2: Verify installation**

  Run: `npx electron-builder --version`
  Expected: Outputs the installed version of `electron-builder` (e.g., `24.x.x` or similar).

- [ ] **Step 3: Commit (if auto_commit enabled)**

  Check `.agent/config.yml` for `auto_commit` setting.
  If `auto_commit: true`:
  ```bash
  git add package.json package-lock.json
  git commit -m "build: install electron-builder"
  ```
  If `auto_commit: false`: skip commit and staging. Print: "Skipping commit (auto_commit: false)."

---

### Task 2: Configure package.json for Linux AppImage Build

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add build settings and dist script to package.json**

  Replace the contents of `package.json` with the following:

  ```json
  {
    "name": "beamcast-iptv",
    "version": "1.0.0",
    "description": "Beamcast IPTV - Modern Electron IPTV Player with AC3 Transcoding and MPV support",
    "main": "main.js",
    "scripts": {
      "start": "electron .",
      "dist": "electron-builder --linux AppImage"
    },
    "keywords": [],
    "author": "",
    "license": "ISC",
    "dependencies": {
      "mpegts.js": "^1.8.0"
    },
    "devDependencies": {
      "electron": "^31.0.0",
      "electron-builder": "^24.13.3"
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
  }
  ```
  *(Note: Update the `electron-builder` version in `devDependencies` to match the exact version installed in Task 1)*

- [ ] **Step 2: Verify package.json syntax**

  Run: `node -e "require('./package.json')"`
  Expected: No syntax errors or output (exits with code 0).

- [ ] **Step 3: Commit (if auto_commit enabled)**

  Check `.agent/config.yml` for `auto_commit` setting.
  If `auto_commit: true`:
  ```bash
  git add package.json
  git commit -m "build: configure electron-builder for AppImage"
  ```
  If `auto_commit: false`: skip commit and staging. Print: "Skipping commit (auto_commit: false)."

---

### Task 3: Build the AppImage Package

**Files:**
- Create: `dist/Beamcast_IPTV-*.AppImage` (generated binary)

- [ ] **Step 1: Run the electron-builder build command**

  Run: `npm run dist`
  Expected: Packaging starts, downloads standard AppImage toolchain, packages resource files, and finishes with a success message.

- [ ] **Step 2: Verify build outputs**

  Run: `ls -la dist/`
  Expected: A file named `Beamcast_IPTV-1.0.0.AppImage` (or similar matching version) is present in the `dist` directory with a size greater than 50MB.

- [ ] **Step 3: Commit (if auto_commit enabled)**

  (Do not commit generated `dist` artifacts; they are typically ignored by `.gitignore`)
  Check `.agent/config.yml` for `auto_commit` setting.
  Print: "Skipping commit (auto_commit: false)."
