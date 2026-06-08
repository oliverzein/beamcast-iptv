# Xtream Account Details bearbeiten Implementierungsplan

> **Für Agenten:** ERFORDERLICHE SUB-SKILL: Verwenden Sie superpowers:subagent-driven-development (empfohlen) oder superpowers:executing-plans, um diesen Plan Aufgabe für Aufgabe zu implementieren. Die Schritte verwenden die Checkbox (`- [ ]`) Syntax zur Nachverfolgung.

**Ziel:** Benutzern ermöglichen, die Details gespeicherter Xtream Codes Accounts (URL, Benutzername, Passwort, Profilname) zu bearbeiten, und den Cache bei Credentials-Änderungen zurückzusetzen.

**Architektur:** Zustandsschlüssel `editingAccountId` in `renderer.js` definieren. "Edit" Button in der Account-Liste hinzufügen. Das Formular anpassen, um einen Bearbeitungsmodus und "Abbrechen" (Cancel) zu unterstützen. Cache bei Änderung der Zugangsdaten invalidieren.

**Tech Stack:** Electron (main/renderer), HTML/CSS/JS (Vanilla), IndexedDB (IPTVDb Helper).

---

## Vorgeschlagene Dateiänderungen
- **Modifizieren:** `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/style.css` (Button Stile hinzufügen)
- **Modifizieren:** `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/index.html` (DOM IDs und Cancel-Button einbauen)
- **Modifizieren:** `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js` (DOM Referenzen, State-Variable, Edit/Cancel Aktionen, Submit-Logik anpassen)

---

### Aufgabe 1: CSS-Stile für Sekundär-Buttons in `style.css` hinzufügen

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/style.css:870-890`

- [ ] **Schritt 1: Sekundäre Button-Stile hinzufügen**

Fügen Sie am Ende des Button-Bereichs (nach `.btn-sm-danger:hover`) die CSS-Klassen für sekundäre Buttons hinzu:

```css
.btn-secondary {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-muted);
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 10px 20px;
  font-size: 14px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  transition: all 0.2s ease;
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.btn-sm-secondary {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-muted);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.btn-sm-secondary:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}
```

- [ ] **Schritt 2: Commit der CSS-Änderungen**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add style.css
git commit -m "style: add secondary button styles for edit/cancel actions"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 2: UI-Elemente für den Bearbeitungsmodus in `index.html` hinzufügen

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/index.html:170-192`

- [ ] **Schritt 1: ID zur Formular-Überschrift und Cancel-Button hinzufügen**

Ersetzen Sie den Abschnitt `<div class="account-form-section">` in `index.html` mit folgendem Inhalt (Überschrift-ID `account-form-title` und neuer Cancel-Button):

```html
        <!-- Add/Edit account form -->
        <div class="account-form-section">
          <h3 id="account-form-title">Add New Account</h3>
          <form id="account-form" onsubmit="return false;">
            <div class="form-group">
              <label for="acc-name">Profile Name</label>
              <input type="text" id="acc-name" placeholder="e.g. My Provider" required>
            </div>
            <div class="form-group">
              <label for="acc-host">Server URL (Host:Port)</label>
              <input type="text" id="acc-host" placeholder="e.g. line.provider.com:8080" required>
            </div>
            <div class="form-group">
              <label for="acc-user">Username</label>
              <input type="text" id="acc-user" placeholder="Enter username" required>
            </div>
            <div class="form-group">
              <label for="acc-pass">Password</label>
              <input type="password" id="acc-pass" placeholder="Enter password" required>
            </div>
            <button type="submit" id="btn-save-account" class="btn btn-primary" style="width: 100%; margin-top: 10px;">Save Profile</button>
            <button type="button" id="btn-cancel-edit" class="btn btn-secondary" style="display: none; width: 100%; margin-top: 10px;">Cancel</button>
          </form>
        </div>
```

- [ ] **Schritt 2: Commit der HTML-Änderungen**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add index.html
git commit -m "feat: add form title ID and Cancel button to accounts modal"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 3: DOM-Referenzen und Zustand in `renderer.js` einrichten

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js:50-75`

- [ ] **Schritt 1: DOM-Selektoren und `editingAccountId` deklarieren**

Fügen Sie im DOM-Elements-Bereich (ca. Zeile 55-57) Referenzen auf die neuen Elemente hinzu und deklarieren Sie `editingAccountId` im State-Bereich (ca. Zeile 70):

```javascript
// Neue Selektoren nach btnSyncXtream
const accountFormTitle = document.getElementById('account-form-title');
const btnSaveAccount = document.getElementById('btn-save-account');
const btnCancelEdit = document.getElementById('btn-cancel-edit');
```

Und im State-Variablen-Bereich:
```javascript
let editingAccountId = null;
```

- [ ] **Schritt 2: Hilfsfunktion `clearEditState()` hinzufügen**

Definieren Sie eine Funktion `clearEditState()` in `renderer.js` vor `setupAccountsModal()`:

```javascript
function clearEditState() {
  editingAccountId = null;
  accountForm.reset();
  if (accountFormTitle) accountFormTitle.textContent = 'Add New Account';
  if (btnSaveAccount) btnSaveAccount.textContent = 'Save Profile';
  if (btnCancelEdit) btnCancelEdit.style.display = 'none';
}
```

- [ ] **Schritt 3: Event-Listener für Modal-Schließen und Cancel-Klick erweitern**

In `setupAccountsModal()` (ca. Zeilen 700-709) die Aktionen zum Beenden des Bearbeitungsmodus beim Klick auf "Close" oder "Cancel" einbinden:

```javascript
  btnCloseModal.addEventListener('click', () => {
    accountsModal.style.display = 'none';
    clearEditState();
  });

  btnCancelEdit.addEventListener('click', () => {
    clearEditState();
  });
```

- [ ] **Schritt 4: Commit der Zustandsänderungen**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add renderer.js
git commit -m "feat: add DOM selectors, editing state, and clearEditState handler in renderer.js"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 4: "Edit" Button in Account-Liste integrieren

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js:740-798`

- [ ] **Schritt 1: Edit-Button erstellen und Event-Listener hinzufügen**

Modifizieren Sie `loadAccountsList()` in `renderer.js`, um den "Edit" Button neben dem "Delete" Button einzufügen:

```javascript
      const actions = document.createElement('div');
      actions.className = 'account-actions';
      
      const btnLoad = document.createElement('button');
      btnLoad.className = 'btn-sm btn-sm-primary';
      btnLoad.textContent = 'Connect';
      btnLoad.addEventListener('click', () => connectXtreamAccount(acc));

      const btnEdit = document.createElement('button');
      btnEdit.className = 'btn-sm btn-sm-secondary';
      btnEdit.textContent = 'Edit';
      btnEdit.addEventListener('click', () => {
        // Edit Mode aktivieren und Formular befüllen
        editingAccountId = acc.id;
        document.getElementById('acc-name').value = acc.name;
        document.getElementById('acc-host').value = acc.host;
        document.getElementById('acc-user').value = acc.username;
        document.getElementById('acc-pass').value = acc.password;

        if (accountFormTitle) accountFormTitle.textContent = `Edit Account: ${acc.name}`;
        if (btnSaveAccount) btnSaveAccount.textContent = 'Update Profile';
        if (btnCancelEdit) btnCancelEdit.style.display = 'block';
      });

      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn-sm btn-sm-danger';
      btnDelete.textContent = 'Delete';
      btnDelete.addEventListener('click', async () => {
        if (confirm(`Delete profile "${acc.name}"?`)) {
          await IPTVDb.deleteAccount(acc.id);
          await IPTVDb.clearAccountCache(acc.id);
          loadAccountsList();
        }
      });

      actions.appendChild(btnLoad);
      actions.appendChild(btnEdit); // Edit einfügen
      actions.appendChild(btnDelete);
```

- [ ] **Schritt 2: Commit der Listenelemente**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add renderer.js
git commit -m "feat: add Edit button and form filler callback in accounts list"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 5: Formular-Submit-Logik aktualisieren

**Dateien:**
- Modifizieren: `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js:710-735`

- [ ] **Schritt 1: Submit-Handler mit Edit-Support implementieren**

Ersetzen Sie den `accountForm` Submit-Event-Listener in `setupAccountsModal()` durch folgende Logik, um die Aktualisierung von Accounts und die Cache-Invalidierung bei Änderung der Host/Credentials zu steuern:

```javascript
  // Save/Update Account Submit
  accountForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('acc-name').value.trim();
    const host = document.getElementById('acc-host').value.trim();
    const username = document.getElementById('acc-user').value.trim();
    const password = document.getElementById('acc-pass').value.trim();
    
    if (editingAccountId) {
      // Edit Mode: Account aktualisieren
      try {
        const list = await IPTVDb.getAccounts();
        const originalAccount = list.find(acc => acc.id === editingAccountId);
        
        if (!originalAccount) {
          throw new Error('Account not found in database');
        }

        const credentialsChanged = originalAccount.host !== host ||
                                    originalAccount.username !== username ||
                                    originalAccount.password !== password;

        let lastSync = originalAccount.lastSync;

        if (credentialsChanged) {
          console.log(`[Edit Account] Connection details changed. Clearing cache for: ${originalAccount.name}`);
          await IPTVDb.clearAccountCache(editingAccountId);
          lastSync = null; // Sync erzwingen
        }

        const updatedAccount = {
          id: editingAccountId,
          name,
          host,
          username,
          password,
          lastSync
        };

        await IPTVDb.addAccount(updatedAccount);
        clearEditState();
        loadAccountsList();
      } catch (err) {
        alert(`Database error: ${err.message}`);
      }
    } else {
      // Add Mode: Neuen Account erstellen
      const account = {
        id: 'acc_' + Date.now(),
        name,
        host,
        username,
        password
      };

      try {
        await IPTVDb.addAccount(account);
        accountForm.reset();
        loadAccountsList();
      } catch (err) {
        alert(`Database error: ${err.message}`);
      }
    }
  });
```

- [ ] **Schritt 2: Commit der Submit-Logik**

Prüfen Sie `.agent/config.yml` auf die Einstellung `auto_commit`.
Wenn `auto_commit: true` (Standard):
```bash
git add renderer.js
git commit -m "feat: implement account update and cache invalidation on credentials change"
```
Wenn `auto_commit: false`: Commit überspringen und manuell fortfahren.

---

### Aufgabe 6: Manuelle Verifikation

- [ ] **Schritt 1: Electron-App starten**

Führen Sie folgenden Befehl im Hauptverzeichnis aus:
```bash
npm start
```

- [ ] **Schritt 2: Verifikationsschritte ausführen**
1. Öffnen Sie das Menü `Playlists` -> `Manage Xtream Codes Accounts...`.
2. Klicken Sie auf **Edit** bei einem bestehenden Profil.
3. Überprüfen Sie, ob die Formularfelder ausgefüllt sind, die Überschrift zu "Edit Account: <Name>" wechselt, der Speicher-Button zu "Update Profile" wird und der **Cancel** Button erscheint.
4. Klicken Sie auf **Cancel**. Die UI muss in den Zustand "Add New Account" zurückkehren und die Felder leeren.
5. Klicken Sie erneut auf **Edit**, ändern Sie nur den **Profile Name** und klicken Sie auf **Update Profile**. Prüfen Sie, ob sich der Name in der Liste aktualisiert.
6. Klicken Sie auf **Edit**, ändern Sie die **Server URL** oder **Username** oder **Password**, und speichern Sie. Überprüfen Sie durch erneutes Klicken auf **Connect**, dass die App nun neu mit dem Server synchronisiert (da der Cache gelöscht wurde und `lastSync = null` gesetzt wurde).
