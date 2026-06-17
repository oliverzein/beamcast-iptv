function clearEditState() {
  editingAccountId = null;
  selectedAccountId = null;
  accountForm.reset();
  if (accountFormTitle) accountFormTitle.textContent = 'Add New Account';
  if (btnSaveAccount) btnSaveAccount.textContent = 'Save Profile';
  if (btnCancelEdit) btnCancelEdit.style.display = 'none';
  if (accountActiveBadge) accountActiveBadge.style.display = 'none';
  if (accountDetailMeta) accountDetailMeta.style.display = 'none';
  if (accountDetailActions) accountDetailActions.style.display = 'none';
  // Deselect any sidebar item visually
  document.querySelectorAll('.accounts-list .account-item.selected')
    .forEach(el => el.classList.remove('selected'));
}

// --- Xtream Codes Account Manager Modals & Database logic ---

function setupAccountsModal() {
  // Main Menu IPC listener
  window.electronAPI.onShowAccountsModal(() => {
    showAccountsModal();
  });

  btnCloseModal.addEventListener('click', () => {
    accountsModal.style.display = 'none';
    clearEditState();
  });

  btnCancelEdit.addEventListener('click', () => {
    clearEditState();
  });

  // "+" Add new account — clears selection and form for fresh entry
  if (btnAddAccount) {
    btnAddAccount.addEventListener('click', () => {
      clearDialogSelection();
      if (accountFormTitle) accountFormTitle.textContent = 'Add New Account';
      document.getElementById('acc-name').focus();
    });
  }

  // Detail-pane actions (only visible when account selected)
  if (btnAccountConnect) {
    btnAccountConnect.addEventListener('click', async () => {
      if (!selectedAccountId) return;
      const list = await IPTVDb.getAccounts();
      const acc = list.find(a => a.id === selectedAccountId);
      if (acc) connectXtreamAccount(acc);
    });
  }

  if (btnAccountSync) {
    btnAccountSync.addEventListener('click', async () => {
      if (!selectedAccountId) return;
      const list = await IPTVDb.getAccounts();
      const acc = list.find(a => a.id === selectedAccountId);
      if (acc) openSyncDialog(acc);
    });
  }

  if (btnAccountDelete) {
    btnAccountDelete.addEventListener('click', async () => {
      if (!selectedAccountId) return;
      const list = await IPTVDb.getAccounts();
      const acc = list.find(a => a.id === selectedAccountId);
      if (!acc) return;
      if (confirm(`Delete profile "${acc.name}"?`)) {
        await IPTVDb.deleteAccount(acc.id);
        await IPTVDb.clearAccountCache(acc.id);
        clearDialogSelection();
        await loadAccountsList();
      }
    });
  }

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

        // Falls wir den aktuell aktiven Account bearbeitet haben, activeAccount aktualisieren
        if (activeAccount && activeAccount.id === editingAccountId) {
          activeAccount = updatedAccount;
          statusText.textContent = `Active: ${name}`;
          if (credentialsChanged) {
            resetStatus();
            channelList.innerHTML = '<li class="empty-list-placeholder">Account details updated. Please connect again to sync.</li>';
            if (btnToggleGuide) btnToggleGuide.style.display = 'none';
          }
        }

        const editedId = editingAccountId;
        clearEditState();
        await loadAccountsList();
        // Re-select the updated account so its meta + actions remain visible.
        const refreshed = await IPTVDb.getAccounts();
        const reSelected = refreshed.find(a => a.id === editedId);
        if (reSelected) selectAccountInDialog(reSelected);
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
        clearEditState();
        await loadAccountsList();
        // Auto-select the newly created account.
        const refreshed = await IPTVDb.getAccounts();
        const created = refreshed.find(a => a.id === account.id);
        if (created) selectAccountInDialog(created);
      } catch (err) {
        alert(`Database error: ${err.message}`);
      }
    }
  });
}

function setupM3uModal() {
  window.electronAPI.onShowM3uModal(() => {
    m3uModal.style.display = 'flex';
  });

  btnCloseM3uModal.addEventListener('click', () => {
    m3uModal.style.display = 'none';
  });

  m3uUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnLoadUrl.click();
    }
  });
}

function setupGlobalModalDismissal() {
  // Close modals when clicking outside the card (on the overlay)
  window.addEventListener('click', (e) => {
    if (e.target === m3uModal) {
      m3uModal.style.display = 'none';
    }
    if (e.target === accountsModal) {
      accountsModal.style.display = 'none';
      if (typeof clearEditState === 'function') clearEditState();
    }
  });

  // Close modals on Escape key press
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (m3uModal.style.display === 'flex' || accountsModal.style.display === 'flex') {
        m3uModal.style.display = 'none';
        accountsModal.style.display = 'none';
        if (typeof clearEditState === 'function') clearEditState();
        return;
      }
      if (appContainer && appContainer.classList.contains('player-only')) {
        appContainer.classList.remove('player-only');
        return;
      }
    }
  });
}

function showAccountsModal() {
  accountsModal.style.display = 'flex';
  loadAccountsList();
}

async function loadAccountsList() {
  accountsList.innerHTML = '';
  try {
    const list = await IPTVDb.getAccounts();
    if (list.length === 0) {
      accountsList.innerHTML = '<li class="empty-list-placeholder">No saved accounts found.</li>';
      return;
    }

    list.forEach(acc => {
      const li = document.createElement('li');
      li.className = 'account-item';
      li.dataset.accountId = acc.id;
      if (activeAccount && activeAccount.id === acc.id) li.classList.add('is-active');
      if (selectedAccountId === acc.id) li.classList.add('selected');

      const dot = document.createElement('span');
      dot.className = 'dot';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = acc.name;

      li.appendChild(dot);
      li.appendChild(name);

      li.addEventListener('click', () => selectAccountInDialog(acc));

      accountsList.appendChild(li);
    });
  } catch (err) {
    console.error('Failed to load accounts list:', err);
  }
}

function selectAccountInDialog(acc) {
  selectedAccountId = acc.id;
  editingAccountId = acc.id;

  // Populate form
  document.getElementById('acc-name').value = acc.name;
  document.getElementById('acc-host').value = acc.host;
  document.getElementById('acc-user').value = acc.username;
  document.getElementById('acc-pass').value = acc.password;

  if (accountFormTitle) accountFormTitle.textContent = `Edit: ${acc.name}`;
  if (btnSaveAccount) btnSaveAccount.textContent = 'Update Profile';
  if (btnCancelEdit) btnCancelEdit.style.display = 'inline-block';

  // Active badge
  if (accountActiveBadge) {
    accountActiveBadge.style.display = (activeAccount && activeAccount.id === acc.id) ? 'inline-block' : 'none';
  }

  // Meta + actions visible
  if (accountDetailMeta) accountDetailMeta.style.display = 'flex';
  if (accountDetailActions) accountDetailActions.style.display = 'flex';

  // Visual selection in sidebar
  document.querySelectorAll('.accounts-list .account-item.selected')
    .forEach(el => el.classList.remove('selected'));
  const li = accountsList.querySelector(`.account-item[data-account-id="${acc.id}"]`);
  if (li) li.classList.add('selected');

  // Async: fetch EPG meta for counts + sync time
  if (accountMetaSync) {
    accountMetaSync.textContent = 'lade…';
    accountMetaSync.classList.remove('never');
  }
  if (accountMetaProgrammes) accountMetaProgrammes.textContent = '—';
  if (accountMetaChannels) accountMetaChannels.textContent = '—';

  IPTVDb.getEpgMeta(acc.id).then(meta => {
    if (!accountDetailMeta || accountDetailMeta.style.display === 'none') return;
    if (meta && meta.lastFetched) {
      if (accountMetaSync) {
        accountMetaSync.textContent = new Date(meta.lastFetched).toLocaleString('de-DE');
        accountMetaSync.classList.remove('never');
      }
      if (accountMetaProgrammes) accountMetaProgrammes.textContent = `${(meta.programmeCount || 0).toLocaleString('de-DE')} Einträge`;
      if (accountMetaChannels) accountMetaChannels.textContent = `${(meta.channelCount || 0).toLocaleString('de-DE')} Kanäle`;
    } else {
      if (accountMetaSync) {
        accountMetaSync.textContent = 'noch keine';
        accountMetaSync.classList.add('never');
      }
    }
  }).catch(() => { /* keep placeholder */ });
}

function clearDialogSelection() {
  clearEditState();
  // Reset meta fields
  if (accountMetaSync) { accountMetaSync.textContent = '—'; accountMetaSync.classList.remove('never'); }
  if (accountMetaProgrammes) accountMetaProgrammes.textContent = '—';
  if (accountMetaChannels) accountMetaChannels.textContent = '—';
}

// Set active Xtream Codes account and update UI / state
function setActiveXtreamAccount(account) {
  activeAccount = account;
  activePlaylistType = 'xtream';
  activeTab = 'live';
  sidebarTabs.style.display = 'flex';
  tabButtons.forEach(b => b.classList.remove('active'));
  const liveTabBtn = document.querySelector('.tab-btn[data-tab="live"]');
  if (liveTabBtn) liveTabBtn.classList.add('active');
  
  // Save state to localStorage
  localStorage.setItem('lastPlaylistType', 'xtream');
  localStorage.setItem('lastAccountId', account.id);
  localStorage.setItem('lastTab', activeTab);
  localStorage.setItem('lastSelectedCategory', 'all');
  
  if (btnToggleGuide) btnToggleGuide.style.display = 'flex';
}

// Connect and Cache Xtream Codes Account
async function connectXtreamAccount(account, forceSync = false) {
  accountsModal.style.display = 'none';
  
  // Check if cache is valid (less than 24 hours old) and not forcing sync
  const cacheAgeLimit = 24 * 60 * 60 * 1000; // 24 hours
  const isCacheValid = account.lastSync && (Date.now() - account.lastSync < cacheAgeLimit);

  if (isCacheValid && !forceSync) {
    console.log(`[Xtream Connect] Using cached data for account: ${account.name}`);
    setActiveXtreamAccount(account);
    
    loaderOverlay.classList.add('active');
    loaderText.textContent = "Loading account from local cache...";
    
    await loadXtreamSidebar();
    
    loaderOverlay.classList.remove('active');
    statusText.textContent = `Active: ${account.name}`;
    statusDot.className = "pulse-dot green";
    return;
  }

  // Show loader overlay
  loaderOverlay.classList.add('active');
  loaderText.textContent = "Connecting to Xtream Codes server...";
  statusText.textContent = "Connecting...";
  statusDot.className = "pulse-dot orange";

  try {
     // 1. Fetch categories
     loaderText.textContent = "Syncing categories...";
     const [liveCats, vodCats, seriesCats] = await Promise.all([
       fetchXtreamApi(account, 'get_live_categories'),
       fetchXtreamApi(account, 'get_vod_categories'),
       fetchXtreamApi(account, 'get_series_categories')
     ]);

     console.log(`[Xtream Sync] liveCats type: ${typeof liveCats}, isArray: ${Array.isArray(liveCats)}`);
     console.log(`[Xtream Sync] liveCats data: ${JSON.stringify(liveCats ? liveCats.slice(0, 3) : null)}`);

     // 2. Clear old caches
     await IPTVDb.clearAccountCache(account.id);

    // 3. Save categories
    await Promise.all([
      IPTVDb.saveCategories('live_categories', account.id, liveCats),
      IPTVDb.saveCategories('vod_categories', account.id, vodCats),
      IPTVDb.saveCategories('series_categories', account.id, seriesCats)
    ]);

    // 4. Fetch streams in steps
    loaderText.textContent = "Syncing TV Channels database...";
    const liveStreams = await fetchXtreamApi(account, 'get_live_streams');
    await IPTVDb.saveStreams('live_streams', account.id, liveStreams);

    loaderText.textContent = "Syncing Movie Catalog database...";
    const vodStreams = await fetchXtreamApi(account, 'get_vod_streams');
    await IPTVDb.saveStreams('vod_streams', account.id, vodStreams);

    loaderText.textContent = "Syncing TV Series database...";
    const series = await fetchXtreamApi(account, 'get_series');
    await IPTVDb.saveStreams('series', account.id, series);

    // 5. Prefetch EPG (XMLTV). Non-fatal: sync succeeds even if guide is unavailable.
    loaderText.textContent = "Syncing TV Guide...";
    try {
      await fetchAndStoreEpg(account);
    } catch (epgErr) {
      console.warn('[EPG] XMLTV prefetch failed (continuing sync):', epgErr.message);
    }

    // Update account sync timestamp in IndexedDB
    account.lastSync = Date.now();
    await IPTVDb.addAccount(account);

    // Set Active Account
    // Set Active Account and update UI
    setActiveXtreamAccount(account);

    // Reload sidebar
    await loadXtreamSidebar();
    
    loaderOverlay.classList.remove('active');
    statusText.textContent = `Active: ${account.name}`;
    statusDot.className = "pulse-dot green";

  } catch (err) {
    console.error('Sync failure:', err);
    loaderOverlay.classList.remove('active');
    alert(`Sync failed: ${err.message}. Ensure Server host is correct and reachable.`);
    resetStatus();
  }
}

// --- Sync Dialog ---
let syncTargetAccount = null;

function openSyncDialog(account) {
  syncTargetAccount = account;
  const modal = document.getElementById('sync-modal');
  const nameEl = document.getElementById('sync-account-name');
  const progress = document.getElementById('sync-progress');
  const options = document.getElementById('sync-options');
  const btnStart = document.getElementById('btn-start-sync');

  nameEl.textContent = account.name;
  progress.style.display = 'none';
  options.style.display = 'block';
  btnStart.style.display = 'block';
  btnStart.disabled = false;
  btnStart.textContent = 'Sync starten';

  // Reset checkboxes
  document.getElementById('sync-all').checked = true;
  document.getElementById('sync-live').checked = true;
  document.getElementById('sync-vod').checked = true;
  document.getElementById('sync-epg').checked = true;

  modal.style.display = 'flex';
}

(function setupSyncDialog() {
  const modal = document.getElementById('sync-modal');
  const btnClose = document.getElementById('btn-close-sync');
  const btnStart = document.getElementById('btn-start-sync');
  const chkAll = document.getElementById('sync-all');
  const chkLive = document.getElementById('sync-live');
  const chkVod = document.getElementById('sync-vod');
  const chkEpg = document.getElementById('sync-epg');

  if (!modal) return;

  btnClose.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

  // "Alles" toggles all sub-checkboxes
  chkAll.addEventListener('change', () => {
    chkLive.checked = chkAll.checked;
    chkVod.checked = chkAll.checked;
    chkEpg.checked = chkAll.checked;
  });
  // Uncheck "Alles" if any sub is unchecked
  [chkLive, chkVod, chkEpg].forEach(chk => {
    chk.addEventListener('change', () => {
      chkAll.checked = chkLive.checked && chkVod.checked && chkEpg.checked;
    });
  });

  btnStart.addEventListener('click', () => {
    if (!syncTargetAccount) return;
    const scope = { live: chkLive.checked, vod: chkVod.checked, epg: chkEpg.checked };
    if (!scope.live && !scope.vod && !scope.epg) return;
    runScopedSync(syncTargetAccount, scope);
  });
})();

async function runScopedSync(account, scope) {
  const modal = document.getElementById('sync-modal');
  const options = document.getElementById('sync-options');
  const progress = document.getElementById('sync-progress');
  const stepEl = document.getElementById('sync-step');
  const barFill = document.getElementById('sync-bar-fill');
  const btnStart = document.getElementById('btn-start-sync');

  options.style.display = 'none';
  progress.style.display = 'block';
  btnStart.disabled = true;
  btnStart.textContent = 'Synchronisierung läuft...';

  const steps = [];
  if (scope.live) steps.push('live');
  if (scope.vod) steps.push('vod');
  if (scope.epg) steps.push('epg');
  let done = 0;

  const setProgress = (text) => {
    stepEl.textContent = text;
    barFill.style.width = Math.round((done / steps.length) * 100) + '%';
  };

  try {
    if (scope.live) {
      setProgress('Synchronisiere Live-Kategorien & Kanäle...');
      const liveCats = await fetchXtreamApi(account, 'get_live_categories');
      await IPTVDb.saveCategories('live_categories', account.id, liveCats);
      const liveStreams = await fetchXtreamApi(account, 'get_live_streams');
      await IPTVDb.saveStreams('live_streams', account.id, liveStreams);
      done++;
      setProgress('Live ✓');
    }

    if (scope.vod) {
      setProgress('Synchronisiere VOD-Kategorien & Filme...');
      const vodCats = await fetchXtreamApi(account, 'get_vod_categories');
      await IPTVDb.saveCategories('vod_categories', account.id, vodCats);
      const vodStreams = await fetchXtreamApi(account, 'get_vod_streams');
      await IPTVDb.saveStreams('vod_streams', account.id, vodStreams);

      setProgress('Synchronisiere Serien...');
      const seriesCats = await fetchXtreamApi(account, 'get_series_categories');
      await IPTVDb.saveCategories('series_categories', account.id, seriesCats);
      const series = await fetchXtreamApi(account, 'get_series');
      await IPTVDb.saveStreams('series', account.id, series);
      done++;
      setProgress('VOD ✓');
    }

    if (scope.epg) {
      setProgress('Synchronisiere TV Guide (EPG)...');
      try {
        await fetchAndStoreEpg(account);
      } catch (epgErr) {
        console.warn('[Sync] EPG failed:', epgErr.message);
      }
      done++;
      setProgress('EPG ✓');
    }

    // Update sync timestamp
    account.lastSync = Date.now();
    await IPTVDb.addAccount(account);

    barFill.style.width = '100%';
    stepEl.textContent = 'Synchronisierung abgeschlossen!';
    btnStart.textContent = 'Fertig';
    btnStart.disabled = false;
    btnStart.onclick = () => { modal.style.display = 'none'; btnStart.onclick = null; };

    // Refresh sidebar if this is the active account
    if (activeAccount && activeAccount.id === account.id) {
      await loadXtreamSidebar();
      if (appContainer.classList.contains('guide-open')) renderEpgGrid();
    }

  } catch (err) {
    console.error('[Sync] Error:', err);
    stepEl.textContent = `Fehler: ${err.message}`;
    btnStart.textContent = 'Schließen';
    btnStart.disabled = false;
    btnStart.onclick = () => { modal.style.display = 'none'; btnStart.onclick = null; };
  }
}

async function fetchXtreamApi(account, action, extraParams = {}) {
  const query = new URLSearchParams({
    host: account.host,
    username: account.username,
    password: account.password,
    action
  });
  for (const [key, val] of Object.entries(extraParams)) {
    query.append(key, val);
  }

  const response = await fetch(`http://127.0.0.1:18080/xtream/api?${query.toString()}`);
  if (!response.ok) {
    const errorBody = await response.json();
    throw new Error(errorBody.error || `HTTP error ${response.status}`);
  }
  return response.json();
}

async function loadXtreamSidebar() {
  if (!activeAccount) return;

  channelSearch.value = '';
  
  // Set category filters dropdown
  const storeCatName = activeTab === 'live' ? 'live_categories' : (activeTab === 'vod' ? 'vod_categories' : 'series_categories');
  console.log(`[Renderer loadXtreamSidebar] Fetching categories from: ${storeCatName} for account ID: ${activeAccount.id}`);
  const cats = await IPTVDb.getCategories(storeCatName, activeAccount.id);
  console.log(`[Renderer loadXtreamSidebar] Retrieved categories:`, cats);
  
  categoryFilter.innerHTML = '<option value="all">All Categories</option>';
  cats.sort((a,b) => (a.categoryName || '').localeCompare(b.categoryName || '')).forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.categoryId;
    opt.textContent = cat.categoryName;
    categoryFilter.appendChild(opt);
  });

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

  // Render list
  const storeStreamName = activeTab === 'live' ? 'live_streams' : (activeTab === 'vod' ? 'vod_streams' : 'series');
  const items = await IPTVDb.getStreamsByCategory(storeStreamName, activeAccount.id, categoryFilter.value);
  renderChannelList(items);
}

function getAccountBaseUrl(account) {
  const host = account.host.trim();
  return host.startsWith('http://') || host.startsWith('https://') ? host : `http://${host}`;
}

// Handles sidebar clicks in Xtream codes mode
function handleXtreamClick(item) {
  const baseUrl = getAccountBaseUrl(activeAccount);
  if (activeTab === 'live') {
    localStorage.setItem('lastSelectedId_live', item.streamId);
    const url = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${item.streamId}.ts`;
    
    currentLiveChannelUrl = url;
    currentLiveChannelName = item.name;
    currentLiveChannelGroup = item.group || 'Live Channel';
    currentLiveChannelLogo = item.logo;
    resetToLive();

    playChannel(item.name, 'Live Channel', item.logo, url);
    
    loadEpgSidebar(item.streamId, item.catchup === 1);
  } else if (activeTab === 'vod') {
    localStorage.setItem('lastSelectedId_vod', item.streamId);
    setEpgContainerDisplay('none');
    isTimeshiftActive = false;
    const ext = item.containerExtension || 'mp4';
    const url = `${baseUrl}/movie/${activeAccount.username}/${activeAccount.password}/${item.streamId}.${ext}`;
    playChannel(item.name, 'Movie', item.logo, url);
  } else if (activeTab === 'series') {
    setEpgContainerDisplay('none');
    isTimeshiftActive = false;
    loadSeriesEpisodes(item);
  }
}

// Loads Season/Episodes selector grid
async function loadSeriesEpisodes(seriesItem) {
  if (activePlaylistType === 'xtream') {
    localStorage.setItem('lastSelectedId_series', seriesItem.seriesId);
  }
  destroyPlayer();
  videoContainer.style.display = 'none';
  timelineContainer.style.display = 'none';
  episodesContainer.style.display = 'flex';

  activeChannelName.textContent = seriesItem.name;
  activeChannelGroup.textContent = 'TV Series';
  if (seriesItem.logo) {
    activeLogoContainer.innerHTML = `<img src="${seriesItem.logo}" style="width: 100%; height: 100%; object-fit: contain; border-radius: var(--border-radius);">`;
  } else {
    activeLogoContainer.innerHTML = '🍿';
  }

  // Show series details
  seriesCover.src = seriesItem.logo || '';
  seriesTitle.textContent = seriesItem.name;
  seriesPlot.textContent = "Loading series info...";
  seasonSelect.innerHTML = '<option value="">Select Season</option>';
  episodesGrid.innerHTML = '<div class="empty-list-placeholder">Loading episodes...</div>';

  try {
    const seriesInfo = await fetchXtreamApi(activeAccount, 'get_series_info', { series_id: seriesItem.seriesId });
    activeSeriesData = seriesInfo;
    activeSeriesData.seriesId = seriesItem.seriesId;

    // Load Plot
    if (seriesInfo.info && seriesInfo.info.plot) {
      seriesPlot.textContent = seriesInfo.info.plot;
    } else {
      seriesPlot.textContent = "No description available.";
    }

    // Populate Season dropdown
    const episodes = seriesInfo.episodes;
    const seasons = Object.keys(episodes).sort((a,b) => Number(a) - Number(b));
    
    seasonSelect.innerHTML = '';
    seasons.forEach(seasonNum => {
      const opt = document.createElement('option');
      opt.value = seasonNum;
      opt.textContent = `Season ${seasonNum}`;
      seasonSelect.appendChild(opt);
    });

    // Handle Season Select change
    seasonSelect.onchange = () => {
      const seasonVal = seasonSelect.value;
      localStorage.setItem(`lastSeason_${seriesItem.seriesId}`, seasonVal);
      renderEpisodesGrid(seasonVal);
    };
    
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

  } catch (err) {
    console.error('Failed to load series info:', err);
    seriesPlot.textContent = "Failed to load details.";
    episodesGrid.innerHTML = '<div class="empty-list-placeholder">Error loading episodes.</div>';
  }
}

function renderEpisodesGrid(seasonNum) {
  episodesGrid.innerHTML = '';
  if (!activeSeriesData || !activeSeriesData.episodes || !seasonNum) return;

  const list = activeSeriesData.episodes[seasonNum] || [];
  
  if (list.length === 0) {
    episodesGrid.innerHTML = '<div class="empty-list-placeholder">No episodes in this season.</div>';
    return;
  }

  // Sort episodes by episode number
  list.sort((a,b) => Number(a.episode_num) - Number(b.episode_num)).forEach(ep => {
    const card = document.createElement('div');
    card.className = 'episode-card';
    
    const num = document.createElement('span');
    num.className = 'ep-num';
    num.textContent = `Episode ${ep.episode_num}`;

    const title = document.createElement('span');
    title.className = 'ep-title';
    title.textContent = ep.title || `Episode ${ep.episode_num}`;

    card.appendChild(num);
    card.appendChild(title);

    card.addEventListener('click', () => {
      const ext = ep.container_extension || 'mp4';
      const baseUrl = getAccountBaseUrl(activeAccount);
      const url = `${baseUrl}/series/${activeAccount.username}/${activeAccount.password}/${ep.id}.${ext}`;
      
      if (activeSeriesData && activeSeriesData.seriesId) {
        localStorage.setItem(`lastSelectedEpisodeId_${activeSeriesData.seriesId}`, ep.id);
      }
      card.parentElement.querySelectorAll('.episode-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      playChannel(`${seriesTitle.textContent} - S${seasonNum}E${ep.episode_num}`, ep.title, seriesCover.src, url);
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const ext = ep.container_extension || 'mp4';
      const baseUrl = getAccountBaseUrl(activeAccount);
      const url = `${baseUrl}/series/${activeAccount.username}/${activeAccount.password}/${ep.id}.${ext}`;
      const name = `${seriesTitle.textContent} - S${seasonNum}E${ep.episode_num}`;
      
      if (activeSeriesData && activeSeriesData.seriesId) {
        localStorage.setItem(`lastSelectedEpisodeId_${activeSeriesData.seriesId}`, ep.id);
      }
      card.parentElement.querySelectorAll('.episode-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      window.electronAPI.showContextMenu(name, url);
    });

    // Highlight saved episode card
    if (activeSeriesData && activeSeriesData.seriesId) {
      const savedEpId = localStorage.getItem(`lastSelectedEpisodeId_${activeSeriesData.seriesId}`);
      if (savedEpId && String(ep.id) === String(savedEpId)) {
        card.classList.add('active');
        setTimeout(() => {
          card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }, 100);
      }
    }

    episodesGrid.appendChild(card);
  });
}

// Restore previously playing stream if saved in localStorage
function restoreLastStream(typePrefix = "") {
  const streamUrl = localStorage.getItem('lastStreamUrl');
  const streamName = localStorage.getItem('lastStreamName');
  const streamGroup = localStorage.getItem('lastStreamGroup');
  const streamLogo = localStorage.getItem('lastStreamLogo');
  
  if (streamUrl && streamName) {
    console.log(`[State Restore] Restoring ${typePrefix ? typePrefix + ' ' : ''}stream: ${streamName}`);
    playChannel(streamName, streamGroup, streamLogo, streamUrl);
  }
}

async function restoreLastState() {
  const lastPlaylistType = localStorage.getItem('lastPlaylistType');
  const lastAccountId = localStorage.getItem('lastAccountId');
  const lastTab = localStorage.getItem('lastTab');
  
  if (lastPlaylistType === 'xtream' && lastAccountId) {
    try {
      // 1. Fetch account from DB
      const accounts = await IPTVDb.getAccounts();
      const account = accounts.find(a => a.id === lastAccountId);
      if (account) {
        console.log(`[State Restore] Restoring Xtream account: ${account.name}`);
        activeAccount = account;
        activePlaylistType = 'xtream';
        activeTab = lastTab || 'live';
        
        // Update UI elements
        sidebarTabs.style.display = 'flex';
        tabButtons.forEach(b => b.classList.remove('active'));
        const activeBtn = document.querySelector(`.tab-btn[data-tab="${activeTab}"]`);
        if (activeBtn) activeBtn.classList.add('active');
        
        // Show sync button
        if (btnToggleGuide) btnToggleGuide.style.display = 'flex';
        statusText.textContent = `Active: ${account.name}`;
        statusDot.className = "pulse-dot green";

        // Load sidebar contents
        await loadXtreamSidebar();
        
        // 2. Restore active stream if saved
        // restoreLastStream();

        // 3. Restore EPG view preference
        const epgView = localStorage.getItem('epgView');
        if (epgView === 'grid' && activeTab === 'live') {
          openEpgGrid();
        }
      } else {
        loadPresetChannels(defaultChannels);
      }
    } catch (e) {
      console.error("[State Restore] Error restoring state:", e);
      loadPresetChannels(defaultChannels);
    }
  } else if (lastPlaylistType === 'm3u') {
    const lastM3uUrl = localStorage.getItem('lastM3uUrl');
    if (lastM3uUrl) {
      console.log(`[State Restore] Restoring M3U playlist: ${lastM3uUrl}`);
      activePlaylistType = 'm3u';
      await fetchPlaylist(lastM3uUrl, true);
      
      // restoreLastStream('M3U');
    } else {
      loadPresetChannels(defaultChannels);
    }
  } else {
    loadPresetChannels(defaultChannels);
  }
}
