#!/bin/bash
set -e

# Parameter auswerten
RELEASE=false
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --release|-r) RELEASE=true ;;
    *) echo "Unbekannter Parameter: $1" ; echo "Nutzung: $0 [--release | -r]" ; exit 1 ;;
  esac
  shift
done

# 1. Version aus package.json auslesen
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

echo "Erkannte Version: $VERSION (Tag: $TAG)"

# 2. AppImage bauen
echo "Baue AppImage..."
npm run dist

# 3. Gebautes AppImage lokalisieren (nutzt die ausgelesene Version)
APPIMAGE_PATH=$(find dist -maxdepth 1 -name "Beamcast IPTV-${VERSION}.AppImage" -o -name "Beamcast_IPTV-${VERSION}.AppImage" | head -n 1)

if [ -z "$APPIMAGE_PATH" ]; then
  # Fallback falls Dateiname abweicht
  APPIMAGE_PATH=$(find dist -maxdepth 1 -name "Beamcast*IPTV*.AppImage" | head -n 1)
fi

if [ -z "$APPIMAGE_PATH" ] || [ ! -f "$APPIMAGE_PATH" ]; then
  echo "Fehler: AppImage-Build nicht gefunden."
  exit 1
fi

echo "Gefundenes AppImage: $APPIMAGE_PATH"

# 4. Nur hochladen, wenn der Parameter --release/-r übergeben wurde
if [ "$RELEASE" = true ]; then
  echo "Prüfe GitHub-Release für Tag $TAG..."
  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "Release $TAG existiert bereits. Aktualisiere AppImage-Asset..."
    gh release upload "$TAG" "$APPIMAGE_PATH" --clobber
  else
    echo "Erstelle neues GitHub-Release für $TAG und lade AppImage hoch..."
    gh release create "$TAG" "$APPIMAGE_PATH" --title "$TAG" --notes "Release $TAG"
  fi
  echo "Veröffentlichung auf GitHub erfolgreich abgeschlossen!"
else
  echo "Lokaler Build erfolgreich abgeschlossen! (Nutzung: $0 --release zum Veröffentlichen)"
fi
