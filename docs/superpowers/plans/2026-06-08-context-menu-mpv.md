# Kontextmenü für direkten MPV-Start Implementierungsplan

> **Für Agenten:** ERFORDERLICHE SUB-SKILL: Verwenden Sie superpowers:subagent-driven-development (empfohlen) oder superpowers:executing-plans, um diesen Plan Aufgabe für Aufgabe zu implementieren. Die Schritte verwenden die Checkbox (`- [ ]`) Syntax zur Nachverfolgung.

**Ziel:** Benutzern ermöglichen, Kanäle, Filme und Serien-Episoden über ein Rechtsklick-Kontextmenü direkt im externen MPV-Player zu öffnen.

**Architektur:** Einen IPC-Kanal `'show-context-menu'` erstellen. In `main.js` ein natives Electron-Menü bei Rechtsklick öffnen, das bei Klick MPV über `child_process.spawn` startet. In `renderer.js` `contextmenu`-Listener auf Listen- und Episodenelemente registrieren.

**Tech Stack:** Electron (main/renderer/preload), JavaScript (Vanilla).

---

## Vorgeschlagene Dateiänderungen
- **Modifizieren:** `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/preload.js` (IPC Bridge für Kontextmenü deklarieren)
- **Modifizieren:** `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/main.js` (IPC Listener für Kontextmenü registrieren)
- **Modifizieren:** `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js` (Rechtsklick-Listener in der Kanalliste und im Episoden-Grid einbauen)

---

### Aufgabe 1: IPC Bridge in `preload.js` erweitern

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/preload.js:10-31`

- [ ] **Schritt 1: `showContextMenu` Methode in `preload.js` hinzufügen**

Erweitern Sie das Objekt `electronAPI` in `preload.js` um die Methode `showContextMenu`:

```javascript
  showContextMenu: (name, url) => {
    ipcRenderer.send('show-context-menu', { name, url });
  },
```

Platzieren Sie dies direkt nach `getProxySeekUrl`:

```javascript
contextBridge.exposeInMainWorld('electronAPI', {
  getProxyUrl: (streamUrl, supportsHEVC) => {
    return `http://127.0.0.1:18080/stream?url=${encodeURIComponent(streamUrl)}${supportsHEVC ? '&hevc=true' : ''}`;
  },
  getProxySeekUrl: (streamUrl, startSeconds, supportsHEVC) => {
    return `http://127.0.0.1:18080/stream?url=${encodeURIComponent(streamUrl)}&start=${startSeconds}${supportsHEVC ? '&hevc=true' : ''}`;
  },
  showContextMenu: (name, url) => {
    ipcRenderer.send('show-context-menu', { name, url });
  },
  openInMpv: (streamUrl) => {
...
```

- [ ] **Schritt 2: Commit der Preload-Änderung**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add preload.js
git commit -m "feat: expose showContextMenu API in preload.js"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 2: IPC Listener in `main.js` registrieren

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/main.js:406-414`

- [ ] **Schritt 1: `'show-context-menu'` Listener hinzufügen**

Registrieren Sie den Listener für das Kontextmenü in `main.js` direkt nach dem Listener `'open-in-mpv'`:

```javascript
ipcMain.on('show-context-menu', (event, { name, url }) => {
  const template = [
    {
      label: `Open "${name}" in MPV`,
      click: () => {
        console.log(`Launching MPV for stream: ${url}`);
        const mpvProcess = spawn('mpv', [url], {
          detached: true,
          stdio: 'ignore'
        });
        mpvProcess.unref();
      }
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  const win = BrowserWindow.fromWebContents(event.sender);
  menu.popup({ window: win });
});
```

- [ ] **Schritt 2: Commit der Main-Prozess-Änderung**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add main.js
git commit -m "feat: implement show-context-menu IPC handler in main.js"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 3: Rechtsklick-Event für Kanäle/Filme in `renderer.js` einbauen

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js:310-330`

- [ ] **Schritt 1: `'contextmenu'` Event-Listener in `renderChannelList` einbauen**

Fügen Sie in `renderChannelList()` den Listener für Rechtsklicks auf Kanäle/Filme hinzu:

```javascript
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      
      let streamUrl = null;
      if (activePlaylistType === 'm3u') {
        streamUrl = ch.url;
      } else if (activeTab === 'live') {
        const baseUrl = getAccountBaseUrl(activeAccount);
        streamUrl = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${ch.streamId}.ts`;
      } else if (activeTab === 'vod') {
        const baseUrl = getAccountBaseUrl(activeAccount);
        const ext = ch.containerExtension || 'mp4';
        streamUrl = `${baseUrl}/movie/${activeAccount.username}/${activeAccount.password}/${ch.streamId}.${ext}`;
      }

      if (streamUrl) {
        window.electronAPI.showContextMenu(ch.name, streamUrl);
      }
    });
```

Platzieren Sie dies direkt nach dem Klick-Listener von `li`:

```javascript
    li.addEventListener('click', () => {
      const activeLi = channelList.querySelector('li.active');
      if (activeLi) activeLi.classList.remove('active');
      li.classList.add('active');

      if (activePlaylistType === 'm3u') {
        playChannel(ch.name, ch.group, ch.logo, ch.url);
      } else {
        handleXtreamClick(ch);
      }
    });

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      let streamUrl = null;
      if (activePlaylistType === 'm3u') {
        streamUrl = ch.url;
      } else if (activeTab === 'live') {
        const baseUrl = getAccountBaseUrl(activeAccount);
        streamUrl = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${ch.streamId}.ts`;
      } else if (activeTab === 'vod') {
        const baseUrl = getAccountBaseUrl(activeAccount);
        const ext = ch.containerExtension || 'mp4';
        streamUrl = `${baseUrl}/movie/${activeAccount.username}/${activeAccount.password}/${ch.streamId}.${ext}`;
      }

      if (streamUrl) {
        window.electronAPI.showContextMenu(ch.name, streamUrl);
      }
    });
```

- [ ] **Schritt 2: Commit der Kanallisten-Änderungen**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add renderer.js
git commit -m "feat: add right-click context menu for sidebar channels and movies"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 4: Rechtsklick-Event für Serien-Episoden in `renderer.js` einbauen

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js:1150-1163`

- [ ] **Schritt 1: `'contextmenu'` Event-Listener in `renderEpisodesGrid` einbauen**

Fügen Sie in `renderEpisodesGrid()` den Listener für Rechtsklicks auf Episoden-Karten hinzu:

```javascript
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const ext = ep.container_extension || 'mp4';
      const baseUrl = getAccountBaseUrl(activeAccount);
      const url = `${baseUrl}/series/${activeAccount.username}/${activeAccount.password}/${ep.id}.${ext}`;
      const name = `${seriesTitle.textContent} - S${seasonNum}E${ep.episode_num}`;
      window.electronAPI.showContextMenu(name, url);
    });
```

Platzieren Sie dies direkt nach dem Klick-Listener von `card`:

```javascript
    card.addEventListener('click', () => {
      const ext = ep.container_extension || 'mp4';
      const baseUrl = getAccountBaseUrl(activeAccount);
      const url = `${baseUrl}/series/${activeAccount.username}/${activeAccount.password}/${ep.id}.${ext}`;
      playChannel(`${seriesTitle.textContent} - S${seasonNum}E${ep.episode_num}`, ep.title, seriesCover.src, url);
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const ext = ep.container_extension || 'mp4';
      const baseUrl = getAccountBaseUrl(activeAccount);
      const url = `${baseUrl}/series/${activeAccount.username}/${activeAccount.password}/${ep.id}.${ext}`;
      const name = `${seriesTitle.textContent} - S${seasonNum}E${ep.episode_num}`;
      window.electronAPI.showContextMenu(name, url);
    });
```

- [ ] **Schritt 2: Commit der Episodengrid-Änderungen**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add renderer.js
git commit -m "feat: add right-click context menu for series episodes"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 5: Manuelle Verifikation

- [ ] **Schritt 1: Electron-App starten**

```bash
npm start
```

- [ ] **Schritt 2: Verifikationsschritte ausführen**
1. Öffnen Sie die Kanalliste (Live oder VOD).
2. Machen Sie einen Rechtsklick auf einen Kanal/Film.
3. Prüfen Sie, ob das Kontextmenü mit dem Text `Open "[Name]" in MPV` erscheint.
4. Klicken Sie darauf. Prüfen Sie, ob MPV startet und den Stream abspielt.
5. Öffnen Sie eine TV-Serie und wählen Sie eine Staffel.
6. Machen Sie einen Rechtsklick auf eine Episode.
7. Prüfen Sie, ob das Kontextmenü erscheint, klicken Sie auf den Eintrag und verifizieren Sie den Start in MPV.
8. Klicken Sie normal (Links-Klick) auf Kanäle und Episoden und verifizieren Sie, dass sie weiterhin im integrierten Player abgespielt werden.
