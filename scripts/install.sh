#!/bin/bash
set -e

# Verzeichnis des Skripts ermitteln
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 1. AppImage suchen
echo "Suche AppImage..."
# 1.1 In repo dist-Verzeichnis
APPIMAGE_PATH=$(find "$REPO_ROOT/dist" -maxdepth 1 -name "Beamcast*IPTV*.AppImage" 2>/dev/null | head -n 1)

# 1.2 Im aktuellen Verzeichnis
if [ -z "$APPIMAGE_PATH" ]; then
  APPIMAGE_PATH=$(find . -maxdepth 2 -name "Beamcast*IPTV*.AppImage" 2>/dev/null | head -n 1)
fi

# 1.3 Im Skript-Verzeichnis
if [ -z "$APPIMAGE_PATH" ]; then
  APPIMAGE_PATH=$(find "$SCRIPT_DIR" -maxdepth 1 -name "Beamcast*IPTV*.AppImage" 2>/dev/null | head -n 1)
fi

# 1.4 Wenn nicht gefunden, von GitHub Release herunterladen
if [ -z "$APPIMAGE_PATH" ] || [ ! -f "$APPIMAGE_PATH" ]; then
  if ! command -v curl &> /dev/null; then
    echo "Fehler: AppImage nicht lokal gefunden und 'curl' wird für den Download benötigt."
    exit 1
  fi

  echo "Ermittle neuestes Release von GitHub..."
  # Get release JSON
  RELEASE_JSON=$(curl -s "https://api.github.com/repos/oliverzein/beamcast-iptv/releases/latest")
  
  # Extract AppImage download URL
  URL=$(echo "$RELEASE_JSON" | grep -o '"browser_download_url": "[^"]*' | grep '\.AppImage' | head -n 1 | cut -d'"' -f4)

  if [ -z "$URL" ]; then
    # Fallback to hardcoded URL if API fails
    echo "Konnte Download-URL nicht über die API ermitteln. Nutze Fallback..."
    LATEST_TAG="v1.0.0"
    OUT_FILE="Beamcast.IPTV-1.0.0.AppImage"
    URL="https://github.com/oliverzein/beamcast-iptv/releases/download/${LATEST_TAG}/${OUT_FILE}"
  else
    OUT_FILE=$(basename "$URL")
  fi

  echo "Downloade $OUT_FILE..."
  if ! curl -# -f -L "$URL" -o "$OUT_FILE"; then
    echo "Fehler: Download von $URL fehlgeschlagen."
    rm -f "$OUT_FILE"
    exit 1
  fi
  
  if [ -f "$OUT_FILE" ] && [ -s "$OUT_FILE" ]; then
    APPIMAGE_PATH="$OUT_FILE"
  else
    echo "Fehler: Download fehlgeschlagen."
    exit 1
  fi
fi

# Absolute Pfadangabe sicherstellen
APPIMAGE_PATH=$(realpath "$APPIMAGE_PATH")
echo "AppImage gefunden/geladen: $APPIMAGE_PATH"

# AppImage ELF-Signatur prüfen
if [ ! -f "$APPIMAGE_PATH" ] || [ "$(head -c 4 "$APPIMAGE_PATH" | od -An -tx1 | tr -d ' \n')" != "7f454c46" ]; then
  echo "Fehler: Die Datei '$APPIMAGE_PATH' ist kein gültiges AppImage (ungültige ELF-Signatur)."
  # Heruntergeladene Datei aufräumen
  if [ -n "$OUT_FILE" ] && [ "$APPIMAGE_PATH" = "$(realpath "$OUT_FILE" 2>/dev/null)" ]; then
    rm -f "$OUT_FILE"
  fi
  exit 1
fi

# 2. Icon suchen
ICON_PATH=""
if [ -f "$REPO_ROOT/assets/logo.png" ]; then
  ICON_PATH="$REPO_ROOT/assets/logo.png"
elif [ -f "./logo.png" ]; then
  ICON_PATH="./logo.png"
elif [ -f "$SCRIPT_DIR/logo.png" ]; then
  ICON_PATH="$SCRIPT_DIR/logo.png"
fi

# 3. Zielverzeichnisse erstellen
mkdir -p "$HOME/.local/bin"
mkdir -p "$HOME/.local/share/applications"
mkdir -p "$HOME/.local/share/icons"

# 4. AppImage kopieren und ausführbar machen
echo "Installiere AppImage nach $HOME/.local/bin/beamcast-iptv..."
cp "$APPIMAGE_PATH" "$HOME/.local/bin/beamcast-iptv"
chmod +x "$HOME/.local/bin/beamcast-iptv"

# 5. Icon kopieren / extrahieren
if [ -n "$ICON_PATH" ]; then
  echo "Installiere Icon von $ICON_PATH..."
  cp "$ICON_PATH" "$HOME/.local/share/icons/beamcast-iptv.png"
else
  echo "Versuche Icon aus dem AppImage zu extrahieren..."
  TEMP_DIR=$(mktemp -d)
  (
    cd "$TEMP_DIR"
    chmod +x "$APPIMAGE_PATH"
    # AppImage extrahieren (squashfs-root/)
    # Nutzen den extrakt-und-run-kompatiblen Parameter oder standard extrakt
    "$APPIMAGE_PATH" --appimage-extract >/dev/null 2>&1 || true
    
    if [ -f "squashfs-root/beamcast-iptv.png" ]; then
      cp "squashfs-root/beamcast-iptv.png" "$HOME/.local/share/icons/beamcast-iptv.png"
      echo "Icon erfolgreich aus AppImage extrahiert (beamcast-iptv.png)."
    elif [ -f "squashfs-root/logo.png" ]; then
      cp "squashfs-root/logo.png" "$HOME/.local/share/icons/beamcast-iptv.png"
      echo "Icon erfolgreich aus AppImage extrahiert (logo.png)."
    elif [ -f "squashfs-root/.DirIcon" ]; then
      cp "squashfs-root/.DirIcon" "$HOME/.local/share/icons/beamcast-iptv.png"
      echo "Icon erfolgreich aus AppImage extrahiert (.DirIcon)."
    else
      FOUND_ICON=$(find squashfs-root -name "logo.png" -o -name "icon.png" -o -name "*.png" 2>/dev/null | head -n 1)
      if [ -n "$FOUND_ICON" ]; then
        cp "$FOUND_ICON" "$HOME/.local/share/icons/beamcast-iptv.png"
        echo "Icon erfolgreich aus AppImage extrahiert ($FOUND_ICON)."
      else
        echo "Warnung: Konnte kein Icon im AppImage finden."
      fi
    fi
  )
  rm -rf "$TEMP_DIR"
fi

# 6. Desktop-Eintrag erstellen
echo "Erstelle Desktop-Eintrag..."
cat <<EOF > "$HOME/.local/share/applications/beamcast-iptv.desktop"
[Desktop Entry]
Name=Beamcast IPTV
Comment=Modern IPTV player with AC3 Transcoding and MPV support
Exec=${HOME}/.local/bin/beamcast-iptv
Icon=beamcast-iptv
Terminal=false
Type=Application
Categories=AudioVideo;Video;Player;TV;
StartupWMClass=beamcast-iptv
EOF

# 7. Desktop-Datenbank aktualisieren
echo "Aktualisiere Desktop-Datenbank..."
update-desktop-database "$HOME/.local/share/applications" || true

echo "Installation abgeschlossen! Beamcast IPTV ist jetzt im Startmenü verfügbar."
