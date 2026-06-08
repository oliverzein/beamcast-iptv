# Single-Instance External Player Implementierungsplan

> **Für Agenten:** ERFORDERLICHE SUB-SKILL: Verwenden Sie superpowers:subagent-driven-development (empfohlen) oder superpowers:executing-plans, um diesen Plan Aufgabe für Aufgabe zu implementieren. Die Schritte verwenden die Checkbox (`- [ ]`) Syntax zur Nachverfolgung.

**Ziel:** Sicherstellen, dass zu jedem Zeitpunkt nur ein Stream läuft (entweder intern oder extern). Ein neuer externer Stream beendet einen eventuell bereits laufenden externen Player. Der Code wird generisch benannt, um nicht exklusiv an MPV gebunden zu sein.

**Architektur:**
1. State-Variable `activeExternalProcess` und Hilfsfunktion `launchExternalPlayer` in `main.js` erstellen.
2. IPC-Kanal `'stop-playback'` in `preload.js` registrieren.
3. In `renderer.js` bei Empfang von `'stop-playback'` den internen Player zerstören und UI ausblenden.
4. Bei App-Beendigung in `main.js` den externen Prozess bereinigen.

---

## Vorgeschlagene Dateiänderungen
- **Modifizieren:** `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/preload.js` (IPC Bridge für stop-playback registrieren)
- **Modifizieren:** `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/main.js` (launch-Logik, Event-Listener und Exit-Handler anpassen)
- **Modifizieren:** `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js` (stop-playback Listener im UI einbauen)

---

### Aufgabe 1: IPC Bridge in `preload.js` erweitern

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/preload.js:10-33`

- [ ] **Schritt 1: `onStopPlayback` in `preload.js` hinzufügen**

Erweitern Sie `electronAPI` in `preload.js` um `onStopPlayback`:

```javascript
  onStopPlayback: (callback) => {
    ipcRenderer.on('stop-playback', () => callback());
  },
```

Platzieren Sie es direkt nach `showContextMenu`:

```javascript
  showContextMenu: (name, url) => {
    ipcRenderer.send('show-context-menu', { name, url });
  },
  onStopPlayback: (callback) => {
    ipcRenderer.on('stop-playback', () => callback());
  },
  openInMpv: (streamUrl) => {
```

- [ ] **Schritt 2: Commit der Preload-Änderung**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add preload.js
git commit -m "feat: add onStopPlayback listener to preload.js"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 2: Main-Prozess launch-Logik und App-Exit anpassen

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/main.js`

- [ ] **Schritt 1: Variable `activeExternalProcess` und Hilfsfunktion `launchExternalPlayer` hinzufügen**

Fügen Sie ganz oben im state-Bereich (ca. Zeile 13) die Variable `activeExternalProcess` hinzu:

```javascript
let activeExternalProcess = null;
```

Fügen Sie die Funktion `launchExternalPlayer` in `main.js` (z. B. direkt über `ipcMain.on('open-in-mpv')` ca. Zeile 405) hinzu:

```javascript
function launchExternalPlayer(streamUrl) {
  // 1. Laufenden externen Prozess killen, falls vorhanden
  if (activeExternalProcess) {
    console.log('Killing previous external player process');
    try {
      activeExternalProcess.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing previous external process:', e);
    }
    activeExternalProcess = null;
  }

  // 2. Laufenden internen FFmpeg-Transkodierungsprozess killen, falls vorhanden
  if (activeFfmpegProcess) {
    console.log('Killing active FFmpeg transcode process due to external player launch');
    try {
      activeFfmpegProcess.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing FFmpeg transcode process:', e);
    }
    activeFfmpegProcess = null;
  }

  // 3. Renderer anweisen, das Playback-UI zu schließen
  if (mainWindow) {
    mainWindow.webContents.send('stop-playback');
  }

  // 4. Externen Player (aktuell MPV) starten
  console.log(`Launching external player (mpv) for stream: ${streamUrl}`);
  const externalProcess = spawn('mpv', [streamUrl], {
    detached: true,
    stdio: 'ignore'
  });
  externalProcess.unref();

  activeExternalProcess = externalProcess;

  externalProcess.on('exit', () => {
    if (activeExternalProcess === externalProcess) {
      activeExternalProcess = null;
    }
  });
}
```

- [ ] **Schritt 2: `open-in-mpv` und `show-context-menu` auf `launchExternalPlayer` umstellen**

Ersetzen Sie die beiden Event-Handler für `open-in-mpv` und `show-context-menu` in `main.js` (ca. Zeilen 406-440), damit sie die neue Hilfsfunktion nutzen:

```javascript
ipcMain.on('open-in-mpv', (event, streamUrl) => {
  launchExternalPlayer(streamUrl);
});

ipcMain.on('show-context-menu', (event, { name, url }) => {
  const template = [
    {
      label: `Open "${name}" in MPV`,
      click: () => {
        launchExternalPlayer(url);
      }
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  const win = BrowserWindow.fromWebContents(event.sender);
  menu.popup({ window: win });
});
```

- [ ] **Schritt 3: Exit-Handler in `window-all-closed` anpassen**

Erweitern Sie `app.on('window-all-closed')` am Ende von `main.js`, um auch den externen Player zu beenden:

```javascript
app.on('window-all-closed', () => {
  if (activeFfmpegProcess) {
    activeFfmpegProcess.kill('SIGKILL');
  }
  if (activeExternalProcess) {
    activeExternalProcess.kill('SIGKILL');
  }
  proxyServer.close();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

- [ ] **Schritt 4: Commit der Main-Prozess-Änderungen**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add main.js
git commit -m "feat: implement single-instance external player control and cleanup in main.js"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 3: Renderer-Prozess auf stop-playback reagieren lassen

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js`

- [ ] **Schritt 1: `onStopPlayback` Listener in `renderer.js` registrieren**

Registrieren Sie den Listener am Ende des Setup-Bereichs in `renderer.js` (z. B. nach `window.electronAPI.onTranscodeStatus` ca. Zeile 705):

```javascript
  window.electronAPI.onStopPlayback(() => {
    console.log('[Renderer] Received stop-playback request from main process');
    destroyPlayer();
    videoContainer.style.display = 'none';
    timelineContainer.style.display = 'none';
  });
```

- [ ] **Schritt 2: Commit der Renderer-Änderungen**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add renderer.js
git commit -m "feat: handle stop-playback IPC event to clear player UI in renderer.js"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 4: Manuelle Verifikation

- [ ] **Schritt 1: Electron-App starten**

```bash
npm start
```

- [ ] **Schritt 2: Verifikationsschritte ausführen**
1. Einen Stream im internen Player starten (er läuft im UI).
2. Rechtsklick auf einen anderen Kanal und "Open in MPV" wählen.
3. Verifizieren, dass der interne Player stoppt, das Video-Fenster in Electron ausgeblendet wird und MPV startet.
4. Während MPV läuft, einen anderen Kanal im Rechtsklick-Menü in MPV starten.
5. Verifizieren, dass das erste MPV-Fenster geschlossen wird und der neue Stream im neuen MPV-Fenster öffnet.
6. Electron-App komplett schließen. Verifizieren, dass das MPV-Fenster automatisch mit geschlossen wird.
