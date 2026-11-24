// Preset Channels
const defaultChannels = [
  {
    name: "Al Jazeera English",
    group: "News",
    logo: "https://upload.wikimedia.org/wikipedia/commons/7/7b/Al_Jazeera_English_logo.svg",
    url: "https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8"
  },
  {
    name: "NHK World-Japan HD",
    group: "News",
    logo: "https://upload.wikimedia.org/wikipedia/commons/5/5a/NHK_World_logo_2020.svg",
    url: "https://nhk.lls.pbs.org/index.m3u8"
  },
  {
    name: "ABC News (Australia)",
    group: "News",
    logo: "https://upload.wikimedia.org/wikipedia/commons/8/84/ABC_News_logo_2016.svg",
    url: "https://abc-news-dmd-streams-1.akamaized.net/out/v1/701126012d044971b3fa89406a440133/index.m3u8"
  },
  {
    name: "TRT World (English)",
    group: "News",
    logo: "https://upload.wikimedia.org/wikipedia/commons/2/27/TRT_World.svg",
    url: "https://tv-trtworld.medya.trt.com.tr/master.m3u8"
  }
];

// Initialize
window.addEventListener('DOMContentLoaded', async () => {
  // Open Database
  try {
    await IPTVDb.open();
  } catch (e) {
    console.error('IndexedDB open error:', e);
  }

  // Load AppSettings (after DB open, before any consumer reads settings)
  try {
    await AppSettings.load();
    syncMpvSettingsToMain();
    AppSettings.onChange((key) => {
      if (key && key.startsWith('mpv')) {
        syncMpvSettingsToMain();
      }
    });
  } catch (e) {
    console.error('AppSettings load error:', e);
  }

  setupEventListeners();
  setupPlayerControls();
  setupAccountsModal();
  setupM3uModal();
  setupGlobalModalDismissal();
  setupTranscodeStatusListener();
  setupMpvIntegrations();
  setupSettingsIpc();
  window.DownloadUI?.init();

  // Restore previously loaded provider and stream
  await restoreLastState();
  window.DownloadUI?.refreshVisibility?.();
});

// Load Preset M3U Channels
function loadPresetChannels(list) {
  activePlaylistType = 'm3u';
  sidebarTabs.style.display = 'none';
  timelineContainer.style.display = 'none';
  episodesContainer.style.display = 'none';
  videoContainer.style.display = 'flex';
  
  if (btnToggleGuide) btnToggleGuide.style.display = 'none';
  window.DownloadUI?.refreshVisibility?.();
  
  localStorage.setItem('lastSelectedCategory', 'all');
  
  channels = list;
  updateCategories();
  renderChannelList(channels);
}

// Event Listeners
function setupEventListeners() {
  btnLoadUrl.addEventListener('click', () => {
    const url = m3uUrlInput.value.trim();
    if (url) {
      fetchPlaylist(url);
    }
  });

  m3uFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onerror = () => {
        alert("Failed to read the local file.");
        m3uFileInput.value = '';
      };
      reader.onload = (event) => {
        try {
          const parsed = parseM3U(event.target.result);
          if (parsed.length > 0) {
            loadPresetChannels(parsed);
            localStorage.setItem('lastPlaylistType', 'm3u');
            localStorage.removeItem('lastM3uUrl');
            m3uFileInput.value = '';
            m3uModal.style.display = 'none';
          } else {
            alert("No channels found in this file.");
            m3uFileInput.value = '';
          }
        } catch (err) {
          console.error("Error parsing local M3U file:", err);
          alert(`Could not parse local file: ${err.message}`);
          m3uFileInput.value = '';
        }
      };
      reader.readAsText(file);
    }
  });

  channelSearch.addEventListener('input', filterChannels);
  categoryFilter.addEventListener('change', () => {
    if (activePlaylistType === 'xtream') {
      localStorage.setItem(`lastCategory_${activeTab}`, categoryFilter.value);
    } else {
      localStorage.setItem('lastSelectedCategory', categoryFilter.value);
    }
    filterChannels();
  });

  // Xtream Codes Sidebar Tabs
  tabButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.getAttribute('data-tab');
      localStorage.setItem('lastTab', activeTab);
      
      // Visually hide/restore EPG Grid depending on active tab
      if (activeTab !== 'live') {
        appContainer.classList.remove('guide-open');
        if (epgGridContainer) epgGridContainer.style.display = 'none';
      } else {
        const epgView = localStorage.getItem('epgView');
        if (epgView === 'grid') {
          appContainer.classList.add('guide-open');
          if (epgGridContainer) epgGridContainer.style.display = 'flex';
          populateEpgGridCategory().finally(() => renderEpgGrid());
        }
      }
      
      loadXtreamSidebar();
    });
  });

  if (btnToggleGuide) btnToggleGuide.addEventListener('click', () => {
    if (appContainer.classList.contains('guide-open')) closeEpgGrid();
    else openEpgGrid();
  });
  if (btnEpgClose) btnEpgClose.addEventListener('click', closeEpgGrid);
  const btnEpgNow = document.getElementById('btn-epg-now');
  if (btnEpgNow) btnEpgNow.addEventListener('click', () => {
    if (!epgGridScroll) return;
    const now = Math.floor(Date.now() / 1000);
    epgGridScroll.scrollLeft = Math.max(0, (now - epgWindowStart) / 60 * EPG_PX_PER_MIN - 300);
  });
  if (epgGridCategory) epgGridCategory.addEventListener('change', () => {
    localStorage.setItem('epgGridCategory', epgGridCategory.value);
    renderEpgGrid();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && appContainer.classList.contains('guide-open')) closeEpgGrid();
  });
}

// Fetch M3U Playlist
async function fetchPlaylist(url, isRestore = false) {
  activePlaylistType = 'm3u';
  statusText.textContent = "Loading playlist...";
  statusDot.className = "pulse-dot orange";
  if (btnLoadUrl) {
    btnLoadUrl.disabled = true;
    btnLoadUrl.textContent = "Loading...";
  }
  
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch playlist");
    const text = await response.text();
    const parsed = parseM3U(text);
    if (parsed.length > 0) {
      // Only apply the playlist if we are restoring state or the modal is still open, AND the playlist type hasn't been switched
      if (activePlaylistType === 'm3u' && (isRestore || m3uModal.style.display === 'flex')) {
        loadPresetChannels(parsed);
        resetStatus(); // This re-enables the load button and sets status to Ready
        localStorage.setItem('lastPlaylistType', 'm3u');
        localStorage.setItem('lastM3uUrl', url);
        m3uModal.style.display = 'none';
      } else {
        console.log("[fetchPlaylist] Ignored resolved fetch because active playlist type switched or modal was closed.");
        if (activePlaylistType === 'm3u') resetStatus();
      }
    } else {
      if (activePlaylistType === 'm3u' && (isRestore || m3uModal.style.display === 'flex')) {
        if (!isRestore) alert("No channels found in the playlist.");
      }
      if (activePlaylistType === 'm3u') resetStatus();
    }
  } catch (err) {
    console.error("Error fetching playlist:", err);
    if (activePlaylistType === 'm3u') {
      if (!isRestore) {
        alert(`Could not load playlist: ${err.message}`);
      }
      resetStatus();
    }
  }
}

function resetStatus() {
  statusText.textContent = "Ready";
  statusDot.className = "pulse-dot green";
  if (btnLoadUrl) {
    btnLoadUrl.disabled = false;
    btnLoadUrl.textContent = "Load";
  }
}

// Parse M3U playlist content
function parseM3U(content) {
  const lines = content.split('\n');
  const parsedChannels = [];
  let currentChannel = null;

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('#EXTINF:')) {
      currentChannel = {};
      
      const logoMatch = line.match(/tvg-logo="([^"]+)"/);
      if (logoMatch) currentChannel.logo = logoMatch[1];
      
      const groupMatch = line.match(/group-title="([^"]+)"/);
      currentChannel.group = groupMatch ? groupMatch[1] : 'Uncategorized';
      
      const commaIndex = line.lastIndexOf(',');
      if (commaIndex !== -1) {
        currentChannel.name = line.substring(commaIndex + 1).trim();
      } else {
        currentChannel.name = 'Unknown Channel';
      }
    } else if (line && !line.startsWith('#')) {
      if (currentChannel) {
        currentChannel.url = line;
        parsedChannels.push(currentChannel);
        currentChannel = null;
      }
    }
  }
  return parsedChannels;
}

// Update categories dropdown
function updateCategories() {
  categories.clear();
  channels.forEach(ch => {
    if (ch.group) categories.add(ch.group);
  });

  categoryFilter.innerHTML = '<option value="all">All Categories</option>';
  Array.from(categories).sort().forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    categoryFilter.appendChild(opt);
  });
}

function resolveChannelStreamUrl(ch) {
  if (activePlaylistType === 'm3u') return ch.url || null;
  if (!activeAccount) return null;
  const baseUrl = getAccountBaseUrl(activeAccount);
  if (activeTab === 'live') {
    return `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${ch.streamId}.ts`;
  }
  if (activeTab === 'vod') {
    const ext = ch.containerExtension || 'mp4';
    return `${baseUrl}/movie/${activeAccount.username}/${activeAccount.password}/${ch.streamId}.${ext}`;
  }
  return null;
}

function buildMovieDownloadMeta(ch, streamUrl) {
  if (activePlaylistType !== 'xtream' || activeTab !== 'vod' || !streamUrl) return null;
  return {
    itemKey: 'movie:' + ch.streamId,
    mediaType: 'movie',
    title: ch.name,
    url: streamUrl,
    sourceExt: ch.containerExtension || 'mp4',
    downloadable: true,
  };
}

function appendSidebarActionButtons(li, ch) {
  if (activePlaylistType === 'm3u' || activeTab !== 'series') {
    const mpvBtn = document.createElement('button');
    mpvBtn.type = 'button';
    mpvBtn.className = 'mpv-direct-btn';
    mpvBtn.textContent = '🎬';
    mpvBtn.title = 'Direkt in MPV abspielen';
    mpvBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const streamUrl = resolveChannelStreamUrl(ch);
      if (streamUrl) {
        window.electronAPI.openInMpv(streamUrl, ch.name);
      }
    });
    li.appendChild(mpvBtn);
  }

  if (activePlaylistType === 'xtream' && activeTab === 'vod') {
    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'download-direct-btn';
    dlBtn.textContent = '⬇';
    dlBtn.title = 'Herunterladen';
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const movieMeta = buildMovieDownloadMeta(ch, resolveChannelStreamUrl(ch));
      if (movieMeta) {
        window.DownloadUI?.triggerDownload([movieMeta], { source: 'button' });
      }
    });
    li.appendChild(dlBtn);
  }
}

function handleChannelContextMenu(ch) {
  if (activePlaylistType === 'xtream' && (activeTab === 'live' || activeTab === 'vod')) {
    localStorage.setItem(`lastSelectedId_${activeTab}`, ch.streamId);
  }
  const streamUrl = resolveChannelStreamUrl(ch);
  if (!streamUrl) return;
  const movieMeta = buildMovieDownloadMeta(ch, streamUrl);
  window.electronAPI.showContextMenu(ch.name, streamUrl, movieMeta);
}

// Render channel list to sidebar
function renderChannelList(list) {
  channelList.innerHTML = '';
  channelCount.textContent = `${list.length} items loaded`;

  if (list.length === 0) {
    channelList.innerHTML = '<li class="placeholder-item">No channels match filters.</li>';
    return;
  }

  list.forEach(ch => {
    const li = document.createElement('li');
    
    const img = document.createElement('img');
    img.className = 'channel-icon';
    img.src = ch.logo || '';
    img.onerror = () => {
      img.style.display = 'none';
      const fallback = document.createElement('div');
      fallback.className = 'channel-icon';
      fallback.textContent = activeTab === 'live' ? '📺' : (activeTab === 'vod' ? '🎬' : '🍿');
      li.insertBefore(fallback, li.firstChild);
    };

    const info = document.createElement('div');
    info.className = 'channel-info';

    const name = document.createElement('div');
    name.className = 'channel-name';
    name.textContent = ch.name;

    const group = document.createElement('div');
    group.className = 'channel-group';
    group.textContent = ch.group || 'General';

    info.appendChild(name);
    info.appendChild(group);

    li.appendChild(img);
    li.appendChild(info);

    if (activePlaylistType === 'xtream' && activeTab === 'live' && ch.catchup === 1) {
      const catchupIndicator = document.createElement('span');
      catchupIndicator.className = 'channel-catchup-indicator';
      catchupIndicator.textContent = '🕒';
      catchupIndicator.title = 'Timeshift / Catch-up verfügbar';
      li.appendChild(catchupIndicator);
    }

    appendSidebarActionButtons(li, ch);

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
      handleChannelContextMenu(ch);
    });

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

    channelList.appendChild(li);
  });
}

// Filter channels
function filterChannels() {
  const searchTerm = channelSearch.value.toLowerCase();
  const selectedCat = categoryFilter.value;

  if (activePlaylistType === 'm3u') {
    const filtered = channels.filter(ch => {
      const matchesSearch = ch.name.toLowerCase().includes(searchTerm) || 
                            (ch.group && ch.group.toLowerCase().includes(searchTerm));
      const matchesCategory = selectedCat === 'all' || ch.group === selectedCat;
      return matchesSearch && matchesCategory;
    });
    renderChannelList(filtered);
  } else {
    // Xtream Codes DB Query
    const storeName = activeTab === 'live' ? 'live_streams' : (activeTab === 'vod' ? 'vod_streams' : 'series');
    IPTVDb.getStreamsByCategory(storeName, activeAccount.id, selectedCat)
      .then(items => {
        if (searchTerm) {
          items = items.filter(item => item.name && item.name.toLowerCase().includes(searchTerm));
        }
        renderChannelList(items);
      });
  }
}

// Settings IPC bridge: open settings modal when menu/IPC triggers it
function setupSettingsIpc() {
  if (window.electronAPI && window.electronAPI.onOpenSettings) {
    window.electronAPI.onOpenSettings(() => {
      if (typeof window.openSettingsModal === 'function') {
        window.openSettingsModal();
      } else {
        console.warn('[Settings] openSettingsModal not yet available');
      }
    });
  }
}

function syncMpvSettingsToMain() {
  if (!window.AppSettings || !window.electronAPI?.updateMpvOptions) return;
  try {
    window.electronAPI.updateMpvOptions({
      mpvDemuxerMaxBytes: AppSettings.get('mpvDemuxerMaxBytes'),
      mpvDemuxerReadaheadSecs: AppSettings.get('mpvDemuxerReadaheadSecs'),
      mpvCachePauseInitial: AppSettings.get('mpvCachePauseInitial'),
      mpvCachePauseWait: AppSettings.get('mpvCachePauseWait'),
      mpvForceSeekable: AppSettings.get('mpvForceSeekable'),
      mpvExtraArgs: AppSettings.get('mpvExtraArgs'),
    });
  } catch (err) {
    console.warn('[MPV Settings] syncMpvSettingsToMain failed:', err && err.message);
  }
}
