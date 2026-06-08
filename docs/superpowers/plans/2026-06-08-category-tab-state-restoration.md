# State Restoration für Kategorie-Tabs Implementierungsplan

> **Für Agenten:** ERFORDERLICHE SUB-SKILL: Verwenden Sie superpowers:subagent-driven-development (empfohlen) oder superpowers:executing-plans, um diesen Plan Aufgabe für Aufgabe zu implementieren. Die Schritte verwenden die Checkbox (`- [ ]`) Syntax zur Nachverfolgung.

**Ziel:** Beim Wechsel zwischen den Reitern (Live TV, Movies, Series) die jeweils letzte Kategorie, den ausgewählten Stream und ggf. die ausgewählte Staffel einer Serie wiederherstellen (markieren und fokussieren, aber noch nicht abspielen).

**Architektur:** Tab-spezifische Speicherung über LocalStorage-Variablen (`lastCategory_${activeTab}`, `lastSelectedId_${activeTab}`, `lastSeason_${seriesId}`). Anpassung von `renderChannelList` zur Markierung und Fokussierung des Elements und zum automatischen Laden der Serien-Details.

**Tech Stack:** Electron (Renderer), HTML/CSS/JS (Vanilla).

---

## Vorgeschlagene Dateiänderungen
- **Modifizieren:** `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js`

---

### Aufgabe 1: Category-Filter Event-Listener und `loadXtreamSidebar` anpassen

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js:167-171` und `1040-1065`

- [ ] **Schritt 1: Event-Listener für `categoryFilter` aktualisieren**

Ändern Sie in `renderer.js` den Listener für `categoryFilter`, um die Kategorie tab-spezifisch zu speichern:

```javascript
  categoryFilter.addEventListener('change', () => {
    if (activePlaylistType === 'xtream') {
      localStorage.setItem(`lastCategory_${activeTab}`, categoryFilter.value);
    } else {
      localStorage.setItem('lastSelectedCategory', categoryFilter.value);
    }
    filterChannels();
  });
```

- [ ] **Schritt 2: `loadXtreamSidebar` anpassen**

Ändern Sie die Zeilen in `loadXtreamSidebar()`, in denen `lastSelectedCategory` ausgelesen und gesetzt wird:

```javascript
  // Restore category selection from localStorage if valid
  let lastSelectedCategory;
  if (activePlaylistType === 'xtream') {
    lastSelectedCategory = localStorage.getItem(`lastCategory_${activeTab}`) || 'all';
  } else {
    lastSelectedCategory = localStorage.getItem('lastSelectedCategory') || 'all';
  }
  
  const hasOption = Array.from(categoryFilter.options).some(opt => opt.value === lastSelectedCategory);
  if (hasOption) {
    categoryFilter.value = lastSelectedCategory;
  } else {
    categoryFilter.value = 'all';
    if (activePlaylistType === 'xtream') {
      localStorage.setItem(`lastCategory_${activeTab}`, 'all');
    } else {
      localStorage.setItem('lastSelectedCategory', 'all');
    }
  }
```

- [ ] **Schritt 3: Commit der Kategorie-Zustandsänderung**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add renderer.js
git commit -m "feat: implement tab-specific category selection restoration"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 2: Klick/Rechtsklick-Handler zur ID-Speicherung anpassen

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js`

- [ ] **Schritt 1: `handleXtreamClick` anpassen**

Speichern Sie die IDs der Live/VOD-Streams in `handleXtreamClick` in localStorage:

```javascript
function handleXtreamClick(item) {
  const baseUrl = getAccountBaseUrl(activeAccount);
  if (activeTab === 'live') {
    localStorage.setItem('lastSelectedId_live', item.streamId);
    const url = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${item.streamId}.ts`;
    playChannel(item.name, 'Live Channel', item.logo, url);
  } else if (activeTab === 'vod') {
    localStorage.setItem('lastSelectedId_vod', item.streamId);
    const ext = item.containerExtension || 'mp4';
    const url = `${baseUrl}/movie/${activeAccount.username}/${activeAccount.password}/${item.streamId}.${ext}`;
    playChannel(item.name, 'Movie', item.logo, url);
  } else if (activeTab === 'series') {
    loadSeriesEpisodes(item);
  }
}
```

- [ ] **Schritt 2: Kontextmenü-Rechtsklick-Handler in `renderChannelList` anpassen**

Aktualisieren Sie den `contextmenu`-Listener in `renderChannelList()`, um auch hier die IDs bei Rechtsklick zu speichern:

```javascript
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      
      let streamUrl = null;
      if (activePlaylistType === 'm3u') {
        streamUrl = ch.url;
      } else if (activeTab === 'live') {
        localStorage.setItem('lastSelectedId_live', ch.streamId);
        const baseUrl = getAccountBaseUrl(activeAccount);
        streamUrl = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${ch.streamId}.ts`;
      } else if (activeTab === 'vod') {
        localStorage.setItem('lastSelectedId_vod', ch.streamId);
        const baseUrl = getAccountBaseUrl(activeAccount);
        const ext = ch.containerExtension || 'mp4';
        streamUrl = `${baseUrl}/movie/${activeAccount.username}/${activeAccount.password}/${ch.streamId}.${ext}`;
      }

      if (streamUrl) {
        window.electronAPI.showContextMenu(ch.name, streamUrl);
      }
    });
```

- [ ] **Schritt 3: `loadSeriesEpisodes` anpassen (ID & Season-Dropdown)**

Fügen Sie am Anfang von `loadSeriesEpisodes` die Speicherung von `lastSelectedId_series` hinzu und passen Sie den `seasonSelect` Event-Listener an, um die Staffel zu speichern:

```javascript
async function loadSeriesEpisodes(seriesItem) {
  if (activePlaylistType === 'xtream') {
    localStorage.setItem('lastSelectedId_series', seriesItem.seriesId);
  }
```

Und weiter unten bei der Zuweisung von `seasonSelect.onchange` (ca. Zeile 1137):

```javascript
    // Handle Season Select change
    seasonSelect.onchange = () => {
      const seasonVal = seasonSelect.value;
      localStorage.setItem(`lastSeason_${seriesItem.seriesId}`, seasonVal);
      renderEpisodesGrid(seasonVal);
    };
```

- [ ] **Schritt 4: Commit der ID-Speicheränderungen**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add renderer.js
git commit -m "feat: save selected stream IDs and seasons to localStorage"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 3: Auto-Selektion in `renderChannelList` und Season-Restoration in `loadSeriesEpisodes` einbauen

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js`

- [ ] **Schritt 1: Selektions- und Fokussierungslogik in `renderChannelList` einbauen**

Ersetzen Sie in `renderChannelList` den bisherigen Highlight-Check am Ende der Schleife durch die tab-spezifische Logik (inklusive Auto-Laden von Serien-Details):

```javascript
    let isLastSelected = false;
    if (activePlaylistType === 'xtream') {
      const lastId = localStorage.getItem(`lastSelectedId_${activeTab}`);
      const chId = activeTab === 'series' ? ch.seriesId : ch.streamId;
      isLastSelected = lastId && String(chId) === String(lastId);
    } else {
      isLastSelected = activeChannelName && activeChannelName.textContent === ch.name;
    }

    if (isLastSelected) {
      li.classList.add('active');
      setTimeout(() => {
        li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 100);

      // Für Serien automatisch die Episoden-Übersicht laden (ohne Wiedergabe)
      if (activePlaylistType === 'xtream' && activeTab === 'series') {
        if (seriesTitle.textContent !== ch.name) {
          loadSeriesEpisodes(ch);
        }
      }
    }
```

Ersetzen Sie die alten Zeilen (ca. 343-349 alt):

```javascript
    if (activeChannelName && activeChannelName.textContent === ch.name) {
      li.classList.add('active');
      setTimeout(() => {
        li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 100);
    }
```

- [ ] **Schritt 2: Season-Restoration in `loadSeriesEpisodes` implementieren**

Passen Sie den Bereich in `loadSeriesEpisodes` an, in dem die Standard-Staffel ausgewählt wird (ca. Zeile 1140):

```javascript
    // Select saved or first season by default
    const savedSeason = localStorage.getItem(`lastSeason_${seriesItem.seriesId}`);
    if (savedSeason && seasons.includes(savedSeason)) {
      seasonSelect.value = savedSeason;
      renderEpisodesGrid(savedSeason);
    } else if (seasons.length > 0) {
      seasonSelect.value = seasons[0];
      renderEpisodesGrid(seasons[0]);
    } else {
      episodesGrid.innerHTML = '<div class="empty-list-placeholder">No episodes found.</div>';
    }
```

Ersetzen Sie:

```javascript
    // Select first season by default
    if (seasons.length > 0) {
      seasonSelect.value = seasons[0];
      renderEpisodesGrid(seasons[0]);
    } else {
      episodesGrid.innerHTML = '<div class="empty-list-placeholder">No episodes found.</div>';
    }
```

- [ ] **Schritt 3: Commit der Auto-Selektion**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add renderer.js
git commit -m "feat: implement item selection highlight and auto series detail loading"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 4: Manuelle Verifikation

- [ ] **Schritt 1: Electron-App starten**

```bash
npm start
```

- [ ] **Schritt 2: Verifikationsschritte ausführen**
1. Einen Stream unter Live TV starten, Kategorie auf z.B. "Sports" filtern.
2. Zu Movies wechseln, Kategorie auf z.B. "Action" filtern, einen Film abspielen.
3. Zu Live TV zurückwechseln. Verifizieren, dass die Kategorie "Sports" wieder ausgewählt ist, der zuvor abgespielte Kanal markiert und im Fokus (scrollIntoView) steht, aber nicht abgespielt wird.
4. Zu Series wechseln, eine Serie auswählen, im Dropdown "Season 2" wählen.
5. Zurück zu Live TV wechseln, dann wieder zu Series wechseln.
6. Verifizieren, dass die Serie markiert ist, die Detailansicht rechts offen ist, das Dropdown auf "Season 2" steht und die Episoden geladen sind, ohne dass ein Video spielt.
