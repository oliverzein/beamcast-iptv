# CLAUDE.md

Guidelines for development and deployment in this project.

## Build & Test Commands
* **Start local development:** `npm start`
* **Local build check:** `npm run dist` (creates local AppImage)
* **Syntax check:** `node -c main.js && node -c renderer.js`

## Deployment & Release Workflow
Always use the dedicated deployment script to release builds to GitHub:
```bash
./scripts/deploy.sh --release
```
* **What it does:** Builds the production AppImage locally and uploads it to GitHub Releases, creating or updating the tag based on the version in `package.json`.
* **Prerequisites:** Requires the GitHub CLI (`gh`) to be installed and authenticated (`gh auth status`).

## Core Code Principles
* **Player-Only View:** Managed via toggling the `.player-only` class on `.app-container`.
* **Control Bar Autohide:** Handled in `renderer.js` via a 3-second inactivity timeout (no `cursor: none` styling changes).
* **Code Health:** Keep functions small. Decouple complex subprocess spawning and event listeners into isolated helper functions.

## Code Quality (Fallow)
Run `fallow` after significant work to verify codebase health and find dead code or hotspots:
* **Run full health check:** `fallow health --file-scores`
* **Check for dead code:** `fallow dead-code`
* **Machine-readable format:** Append `--format json --quiet 2>/dev/null` for scripting/agents.
