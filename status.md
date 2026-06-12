# Projektstatus: IPTV Timeshift & EPG Integration

Dieses Dokument beschreibt den aktuellen Stand der Implementierung. **Die Timeshift-Wiedergabe funktioniert jetzt stabil** – das Ruckeln und Zurückspringen an den Sendungsanfang wurde behoben (siehe Abschnitt 2 und 3).

---

## 1. Aktueller Status (Wiederhergestellt)

Folgende Features und UI-Elemente sind nach dem Rollback wieder vollständig integriert und aktiv:

### Frontend & UI
*   **EPG-Sidebar:** Rechte Seitenleiste für die Programmübersicht neben dem Player.
*   **Wiedergabe-Indikatoren:** 
    *   🕒 Uhr-Icon in der Kanalliste für Timeshift-fähige Sender.
    *   `LIVE`- und `ARCHIV`-Badges im Player-Controlbar.
*   **Details-Toggle:** EPG-Sendungen zeigen standardmäßig nur den Titel. Beschreibungen können per Button (▼/▲) ein- und ausgeklappt werden.
*   **Zeitformatierung:** Datums- und Uhrzeitangaben im EPG nutzen das europäische Format (`DD.MM. | HH:MM - HH:MM`).
*   **Lokale Zeitzone:** Die URL-Formatierung für den Catchup-Server nutzt die lokale Zeitzone (`YYYY-MM-DD:HH-MM`), was den vorherigen 2-Stunden-UTC-Offset behebt.
*   **Scroll-Verhalten:** Sidebar und EPG-Liste sind durch CSS-Flexbox-Einschränkungen (`min-height: 0`) vollständig scrollbar. Beim Öffnen eines Kanals scrollt die EPG-Liste automatisch zur aktuellen Live-Sendung (bzw. zur aktuell gespielten Timeshift-Sendung) und markiert diese visuell (mit rotem "Live"-Badge bzw. blauem "Playing"-Status).

### Backend & Proxy
*   **Timeshift-Erkennung:** Das Hauptverfahren in `main.js` (`isLiveUrl`) erkennt `/timeshift/` im Pfad und stuft den Stream als VOD (nicht live) ein, um Seeking/Zeitleisten zu aktivieren.
*   **EPG-API:** Verwendet `get_simple_data_table` statt `get_short_epg`, um das EPG vergangener Tage zu laden.
*   **Bypass ffprobe:** Bei Timeshift-URLs wird `ffprobe` übersprungen, um die 4-sekündige Startverzögerung zu eliminieren.
*   **Stderr-Logging:** Alle FFmpeg-Ausgaben werden in `ffmpeg.log` protokolliert.

---

## 2. Timeshift Wiedergabe-Issue (BEHOBEN ✅)

### Symptome (vorher)
Der Timeshift-Stream startete schnell (ca. 0–1 Sekunde Ladezeit), lief dann für wenige Sekunden, stockte/hing und sprang wieder an den Anfang der Sendung zurück.

### Root Cause (per `ffmpeg.log` belegt)
*   **`-reconnect_at_eof 1` bei endlichem Archiv-Stream:** FFmpeg lud das Timeshift-Archiv ungedrosselt komplett herunter (z. B. 164 MB in Sekunden), traf am Archiv-Ende auf EOF und geriet in eine Reconnect-Schleife (`Will reconnect at ... error=End of file`). Der Server lieferte beim Reconnect inkonsistente Offsets/Timestamps → der MSE-Puffer wurde resettet → der Player sprang an den Sendungsanfang zurück.
*   **`liveSync`/`liveBufferLatencyChasing` in `mpegts.js`:** Latency-Chasing auf einem schneller-als-Echtzeit gefüllten Puffer (Archiv ist nicht live) verursachte permanente Sprünge und Ruckler.

---

## 3. Implementierte Lösung (in `main.js` und `renderer.js` aktiv)

### Finaler Fix (behebt Ruckeln & Zurückspringen)

1.  **Kein `-reconnect_at_eof` für Timeshift (`main.js`, `buildFfmpegArgs`)**
    *   Timeshift-Archive sind endlich: EOF bedeutet Sendungsende. FFmpeg beendet sich jetzt sauber, statt das Archiv per Reconnect neu zu starten. Normales `-reconnect 1` (mit `-reconnect_delay_max 2`) bleibt für echte Verbindungsabbrüche erhalten.
2.  **`-readrate 1.5` für Timeshift (`main.js`)**
    *   Drosselt das Lesen auf ~1,5× Echtzeit. Verhindert, dass das ganze Archiv auf einmal transkodiert und in den Browser-Puffer gepumpt wird, puffert aber trotzdem voraus.
3.  **Kein Latency-Chasing für Timeshift (`renderer.js`, `loadStream`)**
    *   `liveSync` und `liveBufferLatencyChasing` sind nur noch für echte Live-Streams aktiv. Für Timeshift zusätzlich `autoCleanupSourceBuffer: true` (mit 30–60s Backward-Window), damit lange Sendungen den MSE-Puffer nicht sprengen.

### Weitere aktive Maßnahmen (Stabilität & A/V-Sync)

4.  **`-fflags +genpts+discardcorrupt` (Für Live) / `+genpts+igndts+discardcorrupt` (Für Timeshift)**
    *   Ignoriert beschädigte Pakete und generiert Präsentationszeitstempel (PTS) neu. Bei Timeshift werden zusätzlich DTS ignoriert, um Fehler bei rückwärtslaufenden Zeitstempeln zu minimieren.
5.  **`-avoid_negative_ts make_zero`**
    *   Verschiebt negative Startzeitstempel auf Null, um Puffer-Resets im Browser zu verhindern.
6.  **`-af aresample=async=1`**
    *   Erzwingt das Strecken/Stauchen der transkodierten Audiospur, um sie an die Videobilder anzupassen.
7.  **Erzwungenes H.264-Transcoding für Timeshift (`-c:v libx264 -preset ultrafast -tune zerolatency`)**
    *   Dekodiert und re-kodiert den Videostream für Timeshift-URLs vollständig neu, was eine saubere, kontinuierliche Zeitleiste ohne Sprünge/Ruckler erzeugt.
8.  **`-correct_ts_overflow 1` (Für Timeshift)**
    *   Korrigiert Timestamp-Overflows im MPEG-TS Demuxer.
9.  **Behandlung als Live-Stream in `mpegts.js`:**
    *   Timeshift-Streams werden mit `isLive: true` und `enableStashBuffer: false` geladen. Dies verhindert, dass der Browser zu viel vorab puffert und die Transmuxing-Task suspendiert (was zu Verbindungsabbrüchen / Starvation am IPTV-Server führte).
10. **Direkte Setzung der Programmdauer:**
    *   Die `vodDuration` für die Zeitleiste wird direkt aus den EPG-Start/End-Zeiten berechnet, da der chunked Stream selbst keine feste Dateigröße meldet.

---

## 4. Status & mögliche nächste Schritte

*   ✅ **Timeshift-Wiedergabe getestet und funktionsfähig** (12.06.2026): Keine Reconnect-Schleifen mehr in `ffmpeg.log`, keine Ruckler oder Rücksprünge.
*   ✅ **Seeking (Spulen) in Zeitleiste getestet und funktionsfähig** (12.06.2026): Springt an gewünschte Stelle im Timeshift-Archiv.
*   ✅ **Verhalten am Sendungsende implementiert** (12.06.2026): `videoPlayer.onended` fängt das Stream-Ende (EOF) ab. Wenn die nächste Sendung im EPG in der Vergangenheit liegt (Archiv), wird sie automatisch nahtlos abgespielt. Ist die nächste Sendung aktuell live oder in der Zukunft, wird automatisch zurück auf den Live-Stream gewechselt (`ctrlBackToLive.click()`). VOD stoppt sauber mit Status "Ended".
