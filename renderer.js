// DOM Elements
const m3uUrlInput = document.getElementById('m3u-url');
const btnLoadUrl = document.getElementById('btn-load-url');
const m3uFileInput = document.getElementById('m3u-file');
const channelSearch = document.getElementById('channel-search');
const categoryFilter = document.getElementById('category-filter');
const channelList = document.getElementById('channel-list');
const channelCount = document.getElementById('channel-count');

const activeChannelName = document.getElementById('active-channel-name');
const activeChannelGroup = document.getElementById('active-channel-group');
const activeLogoContainer = document.getElementById('active-logo-container');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const playbackBadge = document.getElementById('playback-badge');

const videoPlayer = document.getElementById('video-player');
const videoContainer = document.getElementById('video-container');
const loaderOverlay = document.getElementById('loader-overlay');
const loaderText = document.getElementById('loader-text');
const playbackErrorOverlay = document.getElementById('playback-error-overlay');
const playbackErrorText = document.getElementById('playback-error-text');
const btnCloseError = document.getElementById('btn-close-error');

const ctrlPlay = document.getElementById('ctrl-play');
const ctrlStop = document.getElementById('ctrl-stop');
const ctrlMute = document.getElementById('ctrl-mute');
const ctrlVolume = document.getElementById('ctrl-volume');
const ctrlFullscreen = document.getElementById('ctrl-fullscreen');
const ctrlMpv = document.getElementById('ctrl-mpv');
const ctrlPlayerOnly = document.getElementById('ctrl-player-only');
const appContainer = document.querySelector('.app-container');

// Check if browser/Chromium has native HEVC hardware decoding enabled
const supportsHEVC = document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.1.L120.B0"') !== '';
console.log('[HEVC Check] Native browser HEVC support:', supportsHEVC);

// Xtream Codes UI elements
const sidebarTabs = document.getElementById('sidebar-tabs');
const tabButtons = document.querySelectorAll('.tab-btn');
const timelineContainer = document.getElementById('timeline-container');
const timeCurrent = document.getElementById('time-current');
const timeDuration = document.getElementById('time-duration');
const seekBar = document.getElementById('seek-bar');

const episodesContainer = document.getElementById('episodes-container');
const seriesCover = document.getElementById('series-cover');
const seriesTitle = document.getElementById('series-title');
const seriesPlot = document.getElementById('series-plot');
const seasonSelect = document.getElementById('season-select');

// EPG and Timeshift variables
let isTimeshiftActive = false;
let timeshiftProgramInfo = null;
let currentLiveChannelUrl = null;
let currentLiveChannelName = null;
let currentLiveChannelGroup = null;
let currentLiveChannelLogo = null;
let currentEpgListings = [];
let currentLiveChannelId = null;

const liveEpgContainer = document.getElementById('live-epg-container');
const epgList = document.getElementById('epg-list');
const ctrlBackToLive = document.getElementById('ctrl-back-to-live');
const episodesGrid = document.getElementById('episodes-grid');

const accountsModal = document.getElementById('accounts-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const accountsList = document.getElementById('accounts-list');
const accountForm = document.getElementById('account-form');
const btnSyncXtream = document.getElementById('btn-sync-xtream');
const btnToggleGuide = document.getElementById('btn-toggle-guide');
const btnEpgRefresh = document.getElementById('btn-epg-refresh');
const btnEpgClose = document.getElementById('btn-epg-close');
const epgGridContainer = document.getElementById('epg-grid-container');
const epgGridScroll = document.getElementById('epg-grid-scroll');
const epgGridUpdated = document.getElementById('epg-grid-updated');
const accountFormTitle = document.getElementById('account-form-title');
const btnSaveAccount = document.getElementById('btn-save-account');
const btnCancelEdit = document.getElementById('btn-cancel-edit');

const m3uModal = document.getElementById('m3u-modal');
const btnCloseM3uModal = document.getElementById('btn-close-m3u-modal');

// State Variables
let channels = [];
let categories = new Set();
let mpegtsPlayer = null;

let activePlaylistType = 'm3u'; // 'm3u' or 'xtream'
let activeAccount = null;
let activeTab = 'live'; // 'live', 'vod', 'series'
let activeStreamUrl = '';
let seekOffset = 0;
let isSeeking = false;
let vodDuration = 0;
let activeSeriesData = null;
let streamLoadTimeout = null;
let seekDebounceTimeout = null;
let editingAccountId = null;
let controlsTimeout = null;

// MPV playback state
let isAlwaysMpvEnabled = localStorage.getItem('alwaysUseMpv') === 'true';
let isMpvActive = false;

const btnToggleAlwaysMpv = document.getElementById('btn-toggle-always-mpv');
const mpvStatusBar = document.getElementById('mpv-status-bar');
const mpvStatusText = document.getElementById('mpv-status-text');
const btnMpvStop = document.getElementById('btn-mpv-stop');
const btnMpvInternal = document.getElementById('btn-mpv-internal');

function updateAlwaysMpvButtonState() {
  if (!btnToggleAlwaysMpv) return;
  if (isAlwaysMpvEnabled) {
    btnToggleAlwaysMpv.classList.add('active');
    btnToggleAlwaysMpv.textContent = '🎬 MPV Mode: ON';
  } else {
    btnToggleAlwaysMpv.classList.remove('active');
    btnToggleAlwaysMpv.textContent = '🎬 MPV Mode: OFF';
  }
}

function setEpgContainerDisplay(display) {
  if (!liveEpgContainer) return;
  liveEpgContainer.style.display = display;
  if (display === 'flex') {
    appContainer.classList.add('epg-open');
  } else {
    appContainer.classList.remove('epg-open');
  }
}

function setupMpvIntegrations() {
  updateAlwaysMpvButtonState();

  if (btnToggleAlwaysMpv) {
    btnToggleAlwaysMpv.addEventListener('click', () => {
      isAlwaysMpvEnabled = !isAlwaysMpvEnabled;
      localStorage.setItem('alwaysUseMpv', isAlwaysMpvEnabled);
      updateAlwaysMpvButtonState();
    });
  }

  if (btnMpvStop) {
    btnMpvStop.addEventListener('click', () => {
      window.electronAPI.stopMpv();
    });
  }

  if (btnMpvInternal) {
    btnMpvInternal.addEventListener('click', () => {
      window.electronAPI.stopMpv();
      if (activeStreamUrl) {
        const tempAlways = isAlwaysMpvEnabled;
        isAlwaysMpvEnabled = false; // Bypass setting temporarily
        playChannel(activeChannelName.textContent, activeChannelGroup.textContent, currentLiveChannelLogo, activeStreamUrl);
        isAlwaysMpvEnabled = tempAlways;
      }
    });
  }

  window.electronAPI.onMpvStatusChanged((data) => {
    isMpvActive = data.active;
    if (data.active) {
      appContainer.classList.add('mpv-active');
      if (mpvStatusBar) {
        mpvStatusBar.style.display = 'flex';
        mpvStatusText.textContent = `MPV läuft: ${data.name}`;
      }
      // Auto-pause internal player
      if (!videoPlayer.paused) {
        videoPlayer.pause();
        ctrlPlay.textContent = "▶";
      }
    } else {
      appContainer.classList.remove('mpv-active');
      if (mpvStatusBar) {
        mpvStatusBar.style.display = 'none';
      }
    }
  });
}

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

  setupEventListeners();
  setupPlayerControls();
  setupAccountsModal();
  setupM3uModal();
  setupGlobalModalDismissal();
  setupTranscodeStatusListener();
  setupMpvIntegrations();
  
  // Restore previously loaded provider and stream
  await restoreLastState();
});

// Load Preset M3U Channels
function loadPresetChannels(list) {
  activePlaylistType = 'm3u';
  sidebarTabs.style.display = 'none';
  timelineContainer.style.display = 'none';
  episodesContainer.style.display = 'none';
  videoContainer.style.display = 'flex';
  
  if (btnSyncXtream) {
    btnSyncXtream.style.display = 'none';
  }
  if (btnToggleGuide) btnToggleGuide.style.display = 'none';
  
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
      loadXtreamSidebar();
    });
  });

  btnSyncXtream.addEventListener('click', () => {
    if (activeAccount) {
      connectXtreamAccount(activeAccount, true);
    }
  });

  if (btnToggleGuide) btnToggleGuide.addEventListener('click', () => {
    if (appContainer.classList.contains('guide-open')) closeEpgGrid();
    else openEpgGrid();
  });
  if (btnEpgClose) btnEpgClose.addEventListener('click', closeEpgGrid);
  if (btnEpgRefresh) btnEpgRefresh.addEventListener('click', async () => {
    btnEpgRefresh.disabled = true;
    const prev = btnEpgRefresh.textContent;
    btnEpgRefresh.textContent = '⏳ ...';
    try {
      await fetchAndStoreEpg(activeAccount);
      await renderEpgGrid();
    } catch (e) {
      console.warn('[EPG] refresh failed:', e.message);
    } finally {
      btnEpgRefresh.disabled = false;
      btnEpgRefresh.textContent = prev;
    }
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

    if (activePlaylistType === 'm3u' || activeTab !== 'series') {
      const mpvBtn = document.createElement('button');
      mpvBtn.className = 'mpv-direct-btn';
      mpvBtn.innerHTML = '🎬';
      mpvBtn.title = 'Direkt in MPV abspielen';
      mpvBtn.addEventListener('click', (e) => {
        e.stopPropagation();
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
          window.electronAPI.openInMpv(streamUrl, ch.name);
        }
      });
      li.appendChild(mpvBtn);
    }

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

// Handle playback
function playChannel(name, group, logo, streamUrl) {
  if (isAlwaysMpvEnabled) {
    activeChannelName.textContent = name;
    activeChannelGroup.textContent = group || 'Live Stream';
    activeStreamUrl = streamUrl;
    window.electronAPI.openInMpv(streamUrl, name);
    return;
  }
  activeChannelName.textContent = name;
  activeChannelGroup.textContent = group || 'Live Stream';
  
  if (logo) {
    activeLogoContainer.innerHTML = `<img src="${logo}" style="width: 100%; height: 100%; object-fit: contain; border-radius: var(--border-radius);">`;
  } else {
    activeLogoContainer.innerHTML = '📡';
  }

  destroyPlayer();
  playbackErrorOverlay.style.display = 'none';
  episodesContainer.style.display = 'none';
  videoContainer.style.display = 'flex';

  loaderOverlay.classList.add('active');
  loaderText.textContent = "Decoding stream...";
  statusText.textContent = "Loading stream...";
  statusDot.className = "pulse-dot orange";

  activeStreamUrl = streamUrl;
  seekOffset = 0;
  vodDuration = 0;

  if (isTimeshiftActive && timeshiftProgramInfo) {
    const start = Number(timeshiftProgramInfo.start_timestamp);
    const end = Number(timeshiftProgramInfo.stop_timestamp || timeshiftProgramInfo.end_timestamp);
    vodDuration = Math.floor(end - start) || 3600;
  }
  
  // Notify main process of active stream
  window.electronAPI.setPlaybackActive(name, streamUrl);
  
  if (ctrlMpv) {
    ctrlMpv.style.display = 'inline-flex';
  }
  
  // Save stream details to localStorage for startup restoration
  localStorage.setItem('lastStreamUrl', streamUrl);
  localStorage.setItem('lastStreamName', name);
  localStorage.setItem('lastStreamGroup', group || '');
  localStorage.setItem('lastStreamLogo', logo || '');

  // Display Seek timeline only for VOD / Movies / Series Episodes (Xtream Mode) or active Live Timeshift
  if ((activePlaylistType === 'xtream' && activeTab !== 'live') || isTimeshiftActive) {
    timelineContainer.style.display = 'flex';
    seekBar.value = 0;
    timeCurrent.textContent = '00:00:00';
    if (isTimeshiftActive && vodDuration) {
      seekBar.max = vodDuration;
      timeDuration.textContent = formatTime(vodDuration);
    } else {
      timeDuration.textContent = '00:00:00';
    }
  } else {
    timelineContainer.style.display = 'none';
  }

  const proxyUrl = window.electronAPI.getProxyUrl(streamUrl, supportsHEVC);
  loadStream(proxyUrl);
}

function loadStream(proxyUrl) {
  if (mpegts.getFeatureList().mseLivePlayback) {
    const isRealLiveStream = (activePlaylistType === 'm3u' || activeTab === 'live') && !isTimeshiftActive;
    const isLiveStream = isRealLiveStream || isTimeshiftActive;
    mpegtsPlayer = mpegts.createPlayer({
      type: 'mpegts',
      isLive: isLiveStream,
      url: proxyUrl,
      enableWorker: true,
      enableStashBuffer: !isLiveStream,           // Disable stash buffer for live streams to minimize startup delay
      liveBufferLatencyChasing: isRealLiveStream, // Chase buffer latency only for real live streams (not timeshift archives)
      liveSync: isRealLiveStream,                 // Latency chasing on timeshift causes constant jumps/stutter
      autoCleanupSourceBuffer: isTimeshiftActive, // Prevent MSE buffer overflow on long timeshift programs
      autoCleanupMaxBackwardDuration: 60,
      autoCleanupMinBackwardDuration: 30
    });

    // Set a timeout of 15 seconds for decoding to complete.
    streamLoadTimeout = setTimeout(() => {
      if (loaderOverlay.classList.contains('active')) {
        console.warn("[Player Timeout] Decoding stream took too long.");
        handlePlayError("Connection timed out. The stream took too long to respond or decode.");
        destroyPlayer();
      }
    }, 15000);

    mpegtsPlayer.attachMediaElement(videoPlayer);
    mpegtsPlayer.load();
    
    mpegtsPlayer.play().catch(e => {
      // Ignore normal play interruption from switching channels/pausing
      if (e.name === 'AbortError') {
        console.log("Playback play() request aborted (normal switch/pause).");
        return;
      }
      if (streamLoadTimeout) {
        clearTimeout(streamLoadTimeout);
        streamLoadTimeout = null;
      }
      console.error("Mpegts.js playback start error:", e.name, e.message);
      handlePlayError(`Playback start failed: ${e.name} - ${e.message}`);
    });

    mpegtsPlayer.on(mpegts.Events.ERROR, (type, detail, info) => {
      if (streamLoadTimeout) {
        clearTimeout(streamLoadTimeout);
        streamLoadTimeout = null;
      }
      console.error("Mpegts.js Player Error:", type, detail, info);
      handlePlayError(`Player error: ${type} (${detail})`);
    });

    videoPlayer.onplaying = () => {
      if (streamLoadTimeout) {
        clearTimeout(streamLoadTimeout);
        streamLoadTimeout = null;
      }
      loaderOverlay.classList.remove('active');
      statusText.textContent = "Playing";
      statusDot.className = "pulse-dot green";
      ctrlPlay.textContent = "⏸";
    };

    videoPlayer.oncanplay = () => {
      if (streamLoadTimeout) {
        clearTimeout(streamLoadTimeout);
        streamLoadTimeout = null;
      }
      loaderOverlay.classList.remove('active');
      if (videoPlayer.paused) {
        statusText.textContent = "Paused";
        statusDot.className = "pulse-dot orange";
        ctrlPlay.textContent = "▶";
      } else {
        statusText.textContent = "Playing";
        statusDot.className = "pulse-dot green";
        ctrlPlay.textContent = "⏸";
      }
    };

    videoPlayer.onwaiting = () => {
      // Don't show full loading overlay for transient buffering
      statusText.textContent = "Buffering...";
      statusDot.className = "pulse-dot orange";
    };

    videoPlayer.onended = () => {
      console.log("Stream playback ended.");
      if (isTimeshiftActive) {
        // Try to find the next program in the EPG listings to continue playing seamlessly
        const currentIndex = currentEpgListings.findIndex(listing => 
          Number(listing.start_timestamp) === Number(timeshiftProgramInfo.start_timestamp)
        );
        
        if (currentIndex !== -1 && currentIndex + 1 < currentEpgListings.length) {
          const nextListing = currentEpgListings[currentIndex + 1];
          const now = Math.floor(Date.now() / 1000);
          const startTimestamp = Number(nextListing.start_timestamp);
          const endTimestamp = Number(nextListing.stop_timestamp || nextListing.end_timestamp);
          
          if (startTimestamp < now) {
            if (endTimestamp <= now) {
              // The next program is also a completed archive program, play it!
              console.log("Timeshift program finished. Auto-playing next program:", nextListing.title);
              
              // Highlight the next program in the EPG sidebar list
              if (epgList) {
                const activeItems = epgList.querySelectorAll('.epg-item.playing');
                activeItems.forEach(el => el.classList.remove('playing'));
                
                const items = epgList.querySelectorAll('.epg-item');
                if (items && items[currentIndex + 1]) {
                  items[currentIndex + 1].classList.add('playing');
                }
              }
              
              playTimeshift(nextListing, currentLiveChannelId);
              return;
            } else {
              // The next program is currently running live, return to live!
              console.log("Timeshift program finished. Next program is currently Live. Returning to Live.");
            }
          } else {
            console.log("Timeshift program finished. Next program is in the future. Returning to Live.");
          }
        }
        
        // Fallback: Return to live stream
        if (ctrlBackToLive) {
          ctrlBackToLive.click();
        }
      } else {
        statusText.textContent = "Ended";
        statusDot.className = "pulse-dot orange";
        ctrlPlay.textContent = "▶";
      }
    };

    videoPlayer.onerror = (e) => {
      if (streamLoadTimeout) {
        clearTimeout(streamLoadTimeout);
        streamLoadTimeout = null;
      }
      console.error("HTML5 Video element error:", e);
      const mediaError = videoPlayer.error;
      let errorMsg = "HTML5 Video playback error.";
      if (mediaError) {
        switch (mediaError.code) {
          case mediaError.MEDIA_ERR_ABORTED:
            errorMsg = "Playback aborted by user.";
            break;
          case mediaError.MEDIA_ERR_NETWORK:
            errorMsg = "Network error: Failed to download stream from proxy server.";
            break;
          case mediaError.MEDIA_ERR_DECODE:
            errorMsg = "Decode error: Stream corrupted or video format not supported.";
            break;
          case mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorMsg = "Format/codec not supported by player.";
            break;
        }
      }
      handlePlayError(errorMsg);
    };
  }
}

function handlePlayError(message = "Failed to decode stream. The stream might be offline or URL incorrect.") {
  loaderOverlay.classList.remove('active');
  statusText.textContent = "Playback Error";
  statusDot.className = "pulse-dot orange";
  
  playbackErrorText.textContent = message;
  playbackErrorOverlay.style.display = 'flex';
}

function destroyPlayer() {
  if (streamLoadTimeout) {
    clearTimeout(streamLoadTimeout);
    streamLoadTimeout = null;
  }
  if (playbackBadge) {
    playbackBadge.style.display = 'none';
  }
  if (ctrlMpv) {
    ctrlMpv.style.display = 'none';
  }
  if (mpegtsPlayer) {
    try {
      mpegtsPlayer.pause();
      mpegtsPlayer.unload();
      mpegtsPlayer.detachMediaElement();
      mpegtsPlayer.destroy();
    } catch (e) {
      console.error("Error destroying player:", e);
    }
    mpegtsPlayer = null;
  }
  ctrlPlay.textContent = "▶";
}

function stopPlayback() {
  destroyPlayer();
  
  // Notify main process playback stopped
  window.electronAPI.setPlaybackInactive();
  
  videoPlayer.removeAttribute('src');
  videoPlayer.load();
  
  // Clear last saved stream so it doesn't autoplay on startup next time
  localStorage.removeItem('lastStreamUrl');
  localStorage.removeItem('lastStreamName');
  localStorage.removeItem('lastStreamGroup');
  localStorage.removeItem('lastStreamLogo');
  
  activeChannelName.textContent = "No Channel Selected";
  activeChannelGroup.textContent = "Select a stream from the sidebar to begin playback";
  activeChannelGroup.className = "neon-text";
  activeLogoContainer.innerHTML = '📡';
  
  timelineContainer.style.display = 'none';
  playbackErrorOverlay.style.display = 'none';
  loaderOverlay.classList.remove('active');
  
  statusText.textContent = activeAccount ? `Active: ${activeAccount.name}` : "Ready";
  statusDot.className = "pulse-dot green";
}

// Custom Player Controls
function setupPlayerControls() {
  setupBasicPlaybackControls();
  setupViewModeToggles();
  setupExternalMpvPlayer();
  setupTimelineSeeking();
  setupControlAutohide();
}

function setupBasicPlaybackControls() {
  btnCloseError.addEventListener('click', () => {
    playbackErrorOverlay.style.display = 'none';
  });

  ctrlPlay.addEventListener('click', () => {
    if (!videoPlayer.src) return;
    if (videoPlayer.paused) {
      videoPlayer.play();
      ctrlPlay.textContent = "⏸";
    } else {
      videoPlayer.pause();
      ctrlPlay.textContent = "▶";
    }
  });

  ctrlStop.addEventListener('click', stopPlayback);

  ctrlMute.addEventListener('click', () => {
    videoPlayer.muted = !videoPlayer.muted;
    ctrlMute.textContent = videoPlayer.muted ? "🔇" : "🔊";
  });

  ctrlVolume.addEventListener('input', (e) => {
    videoPlayer.volume = e.target.value;
    ctrlMute.textContent = videoPlayer.volume === 0 ? "🔇" : "🔊";
  });

  if (ctrlBackToLive) {
    ctrlBackToLive.addEventListener('click', () => {
      isTimeshiftActive = false;
      ctrlBackToLive.style.display = 'none';
      
      const streamInfo = document.getElementById('stream-info');
      if (streamInfo) {
        streamInfo.textContent = 'LIVE';
        streamInfo.style.background = 'red';
        streamInfo.style.boxShadow = '0 0 8px rgba(255, 0, 0, 0.4)';
      }
      
      if (epgList) {
        const activeItems = epgList.querySelectorAll('.epg-item.playing');
        activeItems.forEach(el => el.classList.remove('playing'));
      }
      
      playChannel(currentLiveChannelName, currentLiveChannelGroup, currentLiveChannelLogo, currentLiveChannelUrl);
    });
  }
}

function setupViewModeToggles() {
  ctrlFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      videoPlayer.requestFullscreen().catch(err => {
        console.error(`Fullscreen error: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  });

  if (ctrlPlayerOnly && appContainer) {
    ctrlPlayerOnly.addEventListener('click', () => {
      appContainer.classList.toggle('player-only');
    });
  }
}

function setupExternalMpvPlayer() {
  if (ctrlMpv) {
    ctrlMpv.addEventListener('click', () => {
      if (!activeStreamUrl) return;
      console.log('[MPV] Opening stream in MPV:', activeStreamUrl);
      window.electronAPI.openInMpv(activeStreamUrl);
      // Auto-pause internal player if running
      if (!videoPlayer.paused) {
        videoPlayer.pause();
        ctrlPlay.textContent = "▶";
      }
    });
  }
}

function setupTimelineSeeking() {
  // Timeline seeking for VOD
  videoPlayer.addEventListener('durationchange', () => {
    if ((activePlaylistType === 'xtream' && activeTab !== 'live') || isTimeshiftActive) {
      const playerDuration = videoPlayer.duration;
      if (playerDuration && isFinite(playerDuration) && playerDuration > 0) {
        if (!vodDuration || playerDuration > vodDuration) {
          vodDuration = Math.floor(playerDuration);
          seekBar.max = vodDuration;
          timeDuration.textContent = formatTime(vodDuration);
        }
      }
    }
  });

  videoPlayer.addEventListener('timeupdate', () => {
    if ((activePlaylistType === 'xtream' && activeTab !== 'live') || isTimeshiftActive) {
      const displayTime = seekOffset + videoPlayer.currentTime;
      timeCurrent.textContent = formatTime(displayTime);
      if (!isSeeking) {
        seekBar.value = Math.floor(displayTime);
      }
    }
  });

  seekBar.addEventListener('input', () => {
    isSeeking = true;
  });

  seekBar.addEventListener('change', () => {
    isSeeking = false;
    const targetSeconds = Math.floor(Number(seekBar.value));

    if (seekDebounceTimeout) {
      clearTimeout(seekDebounceTimeout);
    }
    seekDebounceTimeout = setTimeout(() => {
      seekDebounceTimeout = null;
      seekOffset = targetSeconds;

      destroyPlayer();

      loaderOverlay.classList.add('active');
      loaderText.textContent = `Seeking to ${formatTime(targetSeconds)}...`;

      const seekProxyUrl = window.electronAPI.getProxySeekUrl(activeStreamUrl, targetSeconds, supportsHEVC);
      loadStream(seekProxyUrl);
    }, 300);
  });
}

function setupControlAutohide() {
  // Control bar auto-hide logic (based strictly on inactivity)
  if (videoContainer) {
    const showControls = () => {
      videoContainer.classList.add('show-controls');
      clearTimeout(controlsTimeout);
      controlsTimeout = setTimeout(hideControls, 3000);
    };

    const hideControls = () => {
      videoContainer.classList.remove('show-controls');
    };

    videoContainer.addEventListener('mousemove', showControls);
    videoContainer.addEventListener('mouseenter', showControls);
    window.addEventListener('blur', hideControls);
    
    if (videoPlayer) {
      videoPlayer.addEventListener('play', () => showControls());
      videoPlayer.addEventListener('pause', () => showControls());
    }
  }
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds === Infinity) return "00:00:00";
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function setupTranscodeStatusListener() {
  window.electronAPI.onTranscodeStatus((data) => {
    console.log('[Transcode IPC] Received status:', data);
    
    // Only show badge if url matches active stream
    if (data && data.url) {
      if (data.duration && data.duration > 0 && activePlaylistType === 'xtream' && activeTab !== 'live') {
        vodDuration = Math.floor(data.duration);
        seekBar.max = vodDuration;
        timeDuration.textContent = formatTime(vodDuration);
      }
      
      playbackBadge.style.display = 'flex';
      if (data.transcoding) {
        playbackBadge.className = 'playback-badge transcode';
        playbackBadge.innerHTML = `⚡ Transcoding (${data.codec.toUpperCase()})`;
      } else {
        playbackBadge.className = 'playback-badge direct';
        playbackBadge.innerHTML = `⚡ Direct Play (${data.codec.toUpperCase()})`;
      }
    } else {
      playbackBadge.style.display = 'none';
    }
  });

  window.electronAPI.onStopPlayback(() => {
    console.log('[Renderer] Received stop-playback request from main process');
    destroyPlayer();
    videoContainer.style.display = 'none';
    timelineContainer.style.display = 'none';
    if (appContainer && appContainer.classList.contains('player-only')) {
      appContainer.classList.remove('player-only');
    }
  });
}

function clearEditState() {
  editingAccountId = null;
  accountForm.reset();
  if (accountFormTitle) accountFormTitle.textContent = 'Add New Account';
  if (btnSaveAccount) btnSaveAccount.textContent = 'Save Profile';
  if (btnCancelEdit) btnCancelEdit.style.display = 'none';
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
            btnSyncXtream.style.display = 'none';
            if (btnToggleGuide) btnToggleGuide.style.display = 'none';
          }
        }

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
      
      const info = document.createElement('div');
      info.className = 'account-info';
      
      const name = document.createElement('div');
      name.className = 'account-name';
      name.textContent = acc.name;
      
      const host = document.createElement('div');
      host.className = 'account-host';
      host.textContent = acc.host;
      
      info.appendChild(name);
      info.appendChild(host);

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
      actions.appendChild(btnEdit);
      actions.appendChild(btnDelete);
      
      li.appendChild(info);
      li.appendChild(actions);
      accountsList.appendChild(li);
    });
  } catch (err) {
    console.error('Failed to load accounts list:', err);
  }
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
  
  // Show sync button
  btnSyncXtream.style.display = 'inline-flex';
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
    isTimeshiftActive = false;
    
    if (ctrlBackToLive) {
      ctrlBackToLive.style.display = 'none';
    }
    
    const streamInfo = document.getElementById('stream-info');
    if (streamInfo) {
      streamInfo.textContent = 'LIVE';
      streamInfo.style.background = 'red';
      streamInfo.style.boxShadow = '0 0 8px rgba(255, 0, 0, 0.4)';
    }

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
        btnSyncXtream.style.display = 'inline-flex';
        if (btnToggleGuide) btnToggleGuide.style.display = 'flex';
        statusText.textContent = `Active: ${account.name}`;
        statusDot.className = "pulse-dot green";

        // Load sidebar contents
        await loadXtreamSidebar();
        
        // 2. Restore active stream if saved
        restoreLastStream();
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
      
      restoreLastStream('M3U');
    } else {
      loadPresetChannels(defaultChannels);
    }
  } else {
    loadPresetChannels(defaultChannels);
  }
}

// --- EPG & Timeshift helpers ---

// Fetch the full XMLTV dump, parse it (worker w/ main-thread fallback), and cache it.
async function fetchAndStoreEpg(account) {
  const query = new URLSearchParams({
    host: account.host,
    username: account.username,
    password: account.password
  });
  const url = `http://127.0.0.1:18080/xtream/xmltv?${query.toString()}`;
  console.log('[EPG] fetching XMLTV via proxy:', url);
  const res = await fetch(url);
  console.log('[EPG] proxy response status:', res.status, res.ok);
  if (!res.ok) throw new Error(`XMLTV HTTP ${res.status}`);
  const xml = await res.text();
  console.log('[EPG] XMLTV downloaded, length:', xml.length, 'chars; first 120:', xml.slice(0, 120));
  const channelMap = await parseXmltvAsync(xml);
  const channelCount = Object.keys(channelMap || {}).length;
  const programmeCount = Object.values(channelMap || {}).reduce((n, arr) => n + (arr ? arr.length : 0), 0);
  console.log('[EPG] parsed channelMap:', channelCount, 'channels,', programmeCount, 'programmes');
  console.log('[EPG] saving to IndexedDB (saveEpg)...');
  await IPTVDb.saveEpg(account.id, channelMap);
  console.log('[EPG] saveEpg complete for account', account.id);
  return channelMap;
}

// Parse XMLTV off the UI thread when possible, else fall back to the global parseXmltv.
function parseXmltvAsync(xml) {
  return new Promise((resolve) => {
    const fallback = (why) => {
      console.warn('[EPG] parsing on main thread (fallback). reason:', why);
      const map = (typeof parseXmltv === 'function') ? parseXmltv(xml) : {};
      console.log('[EPG] main-thread parse produced', Object.keys(map || {}).length, 'channels');
      resolve(map);
    };

    if (typeof Worker === 'undefined') {
      fallback('Worker unavailable');
      return;
    }
    let worker;
    try {
      worker = new Worker('epg-worker.js');
    } catch (e) {
      fallback('Worker constructor threw: ' + (e && e.message));
      return;
    }

    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); try { worker.terminate(); } catch (_) {} fn(); };

    // Watchdog: if the worker neither responds nor errors, don't hang the whole sync.
    const timer = setTimeout(() => {
      finish(() => fallback('worker timeout (no response in 30s)'));
    }, 30000);

    console.log('[EPG] worker created, posting', xml.length, 'chars for off-thread parse');
    worker.onmessage = (ev) => {
      if (ev.data && ev.data.error) {
        finish(() => fallback('worker reported error: ' + ev.data.error));
      } else {
        const map = (ev.data && ev.data.channelMap) || {};
        console.log('[EPG] worker returned', Object.keys(map).length, 'channels');
        finish(() => resolve(map));
      }
    };
    worker.onerror = (e) => {
      console.warn('[EPG] worker.onerror:', e && e.message, '@', e && e.filename, 'line', e && e.lineno);
      finish(() => fallback('worker.onerror'));
    };
    worker.postMessage({ xml });
  });
}

const EPG_PX_PER_MIN = 5;
const EPG_CHAN_WIDTH = 200;

function openEpgGrid() {
  if (activePlaylistType !== 'xtream' || !activeAccount) return;
  appContainer.classList.add('guide-open');
  if (epgGridContainer) epgGridContainer.style.display = 'flex';
  renderEpgGrid();
}

function closeEpgGrid() {
  appContainer.classList.remove('guide-open');
  if (epgGridContainer) epgGridContainer.style.display = 'none';
}

function epgFormatClock(epochSec) {
  return new Date(epochSec * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

async function renderEpgGrid() {
  if (!epgGridScroll) return;
  epgGridScroll.innerHTML = '<div class="epg-grid-empty">Lade Programmübersicht...</div>';

  // Channels of the current live category (reuse the sidebar's category filter).
  const categoryId = (activeTab === 'live') ? (categoryFilter.value || 'all') : 'all';
  const channels = (await IPTVDb.getStreamsByCategory('live_streams', activeAccount.id, categoryId)) || [];

  const meta = await IPTVDb.getEpgMeta(activeAccount.id);
  if (epgGridUpdated) {
    epgGridUpdated.textContent = meta && meta.lastFetched
      ? `Stand: ${new Date(meta.lastFetched).toLocaleString('de-DE')}`
      : 'Keine Guide-Daten';
  }

  if (!channels.length) {
    epgGridScroll.innerHTML = '<div class="epg-grid-empty">Keine Kanäle in dieser Kategorie.</div>';
    return;
  }

  const epgIds = channels.map(c => c.epgChannelId).filter(Boolean);
  const epgMap = await IPTVDb.getEpgForChannels(activeAccount.id, epgIds);

  const now = Math.floor(Date.now() / 1000);
  const maxCatchupDays = channels.reduce((m, c) => Math.max(m, Number(c.catchupDays) || 0), 0);
  const windowStart = now - maxCatchupDays * 86400;

  // Window end = latest programme stop across channels, fallback now + 3h.
  let windowEnd = now + 3 * 3600;
  channels.forEach(c => {
    const list = epgMap[c.epgChannelId] || [];
    if (list.length) windowEnd = Math.max(windowEnd, list[list.length - 1].stop);
  });

  const totalMin = Math.max(1, (windowEnd - windowStart) / 60);
  const trackWidth = Math.round(totalMin * EPG_PX_PER_MIN);

  epgGridScroll.innerHTML = '';
  epgGridScroll.style.setProperty('--epg-chan-w', EPG_CHAN_WIDTH + 'px');

  // Timeline header (hourly ticks aligned to the hour).
  const timeline = document.createElement('div');
  timeline.className = 'epg-grid-timeline';
  const corner = document.createElement('div');
  corner.className = 'epg-corner';
  timeline.appendChild(corner);

  const firstHour = Math.ceil(windowStart / 3600) * 3600;
  for (let t = firstHour; t < windowEnd; t += 3600) {
    const tick = document.createElement('div');
    tick.className = 'epg-tick';
    tick.style.width = (60 * EPG_PX_PER_MIN) + 'px';
    tick.style.marginLeft = (t === firstHour ? Math.round((firstHour - windowStart) / 60 * EPG_PX_PER_MIN) : 0) + 'px';
    tick.textContent = epgFormatClock(t);
    timeline.appendChild(tick);
  }
  epgGridScroll.appendChild(timeline);

  // Now-line.
  const nowLine = document.createElement('div');
  nowLine.className = 'epg-now-line';
  nowLine.style.left = (EPG_CHAN_WIDTH + Math.round((now - windowStart) / 60 * EPG_PX_PER_MIN)) + 'px';
  epgGridScroll.appendChild(nowLine);

  channels.forEach(channel => {
    const row = document.createElement('div');
    row.className = 'epg-grid-row';

    const chanCell = document.createElement('div');
    chanCell.className = 'epg-grid-channel';
    const img = document.createElement('img');
    img.src = channel.logo || 'assets/placeholder.png';
    img.onerror = () => { img.src = 'assets/placeholder.png'; };
    const nameSpan = document.createElement('span');
    nameSpan.textContent = channel.name || 'Channel';
    chanCell.appendChild(img);
    chanCell.appendChild(nameSpan);
    chanCell.addEventListener('click', () => playEpgLive(channel));
    row.appendChild(chanCell);

    const track = document.createElement('div');
    track.className = 'epg-grid-track';
    track.style.width = trackWidth + 'px';

    const programmes = epgMap[channel.epgChannelId] || [];
    if (!programmes.length) {
      const ph = document.createElement('div');
      ph.className = 'epg-prog';
      ph.style.left = '4px';
      ph.style.width = '180px';
      ph.style.opacity = '0.5';
      ph.textContent = 'Keine Programmdaten';
      track.appendChild(ph);
    }

    programmes.forEach(p => {
      if (p.stop <= windowStart || p.start >= windowEnd) return;
      const left = Math.round((p.start - windowStart) / 60 * EPG_PX_PER_MIN);
      const width = Math.max(2, Math.round((p.stop - p.start) / 60 * EPG_PX_PER_MIN) - 2);
      const block = document.createElement('div');
      block.className = 'epg-prog';
      block.style.left = left + 'px';
      block.style.width = width + 'px';

      const isLive = p.start <= now && p.stop > now;
      const isPast = p.stop <= now;
      const isFuture = p.start > now;
      const hasCatchup = channel.catchup === 1 && isPast && p.start >= (now - (Number(channel.catchupDays) || 0) * 86400);

      if (isLive) block.classList.add('current');
      else if (hasCatchup) block.classList.add('archive');
      else if (isFuture) block.classList.add('future');

      const title = document.createElement('div');
      title.className = 'epg-prog-title';
      title.textContent = p.title || '—';
      const time = document.createElement('div');
      time.className = 'epg-prog-time';
      time.textContent = `${epgFormatClock(p.start)}–${epgFormatClock(p.stop)}`;
      block.appendChild(title);
      block.appendChild(time);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        handleEpgProgramClick(channel, p, { isLive, hasCatchup, isFuture });
      });
      block.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        epgContextMenu(channel, p, { isLive, hasCatchup });
      });

      track.appendChild(block);
    });

    row.appendChild(track);
    epgGridScroll.appendChild(row);
  });

  // Scroll so the now-line is roughly centered.
  epgGridScroll.scrollLeft = Math.max(0, (now - windowStart) / 60 * EPG_PX_PER_MIN - 300);
}

// Adapt an XMLTV programme to the base64 shape playTimeshift/showContextMenu expect.
function epgToListing(p) {
  return {
    start_timestamp: p.start,
    stop_timestamp: p.stop,
    title: btoa(unescape(encodeURIComponent(p.title || '')))
  };
}

function playEpgLive(channel) {
  const baseUrl = getAccountBaseUrl(activeAccount);
  const url = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${channel.streamId}.ts`;
  currentLiveChannelUrl = url;
  currentLiveChannelName = channel.name;
  currentLiveChannelGroup = channel.group || 'Live Channel';
  currentLiveChannelLogo = channel.logo;
  isTimeshiftActive = false;

  if (ctrlBackToLive) {
    ctrlBackToLive.style.display = 'none';
  }

  const streamInfo = document.getElementById('stream-info');
  if (streamInfo) {
    streamInfo.textContent = 'LIVE';
    streamInfo.style.background = 'red';
    streamInfo.style.boxShadow = '0 0 8px rgba(255, 0, 0, 0.4)';
  }

  localStorage.setItem('lastSelectedId_live', channel.streamId);
  closeEpgGrid();
  playChannel(channel.name, 'Live Channel', channel.logo, url);
  loadEpgSidebar(channel.streamId, channel.catchup === 1);
}

function handleEpgProgramClick(channel, p, flags) {
  currentLiveChannelName = channel.name;
  currentLiveChannelLogo = channel.logo;
  if (flags.isLive) {
    playEpgLive(channel);
  } else if (flags.hasCatchup) {
    closeEpgGrid();
    loadEpgSidebar(channel.streamId, channel.catchup === 1);
    playTimeshift(epgToListing(p), channel.streamId);
  } else {
    showEpgDetails(channel, p);
  }
}

function epgContextMenu(channel, p, flags) {
  const baseUrl = getAccountBaseUrl(activeAccount);
  if (flags.isLive) {
    const url = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${channel.streamId}.ts`;
    window.electronAPI.showContextMenu(channel.name, url);
  } else if (flags.hasCatchup) {
    const durationMins = Math.floor((p.stop - p.start) / 60) || 60;
    const startFormatted = formatTimeshiftDate(p.start);
    const url = `${baseUrl}/timeshift/${activeAccount.username}/${activeAccount.password}/${durationMins}/${startFormatted}/${channel.streamId}.ts`;
    window.electronAPI.showContextMenu(`${channel.name} (Archiv: ${p.title})`, url);
  }
}

function showEpgDetails(channel, p) {
  const when = `${epgFormatClock(p.start)}–${epgFormatClock(p.stop)}`;
  alert(`${channel.name}\n${p.title}\n${when}\n\n${p.desc || ''}`.trim());
}

function safeBase64Decode(str) {
  if (!str) return "";
  try {
    return decodeURIComponent(escape(atob(str)));
  } catch (e) {
    return str;
  }
}

function formatTimeshiftDate(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}:${hour}-${minute}`;
}

async function loadEpgSidebar(streamId, hasCatchup) {
  if (!liveEpgContainer || !epgList) return;
  
  if (activePlaylistType !== 'xtream') {
    setEpgContainerDisplay('none');
    return;
  }

  currentLiveChannelId = streamId;
  setEpgContainerDisplay('flex');
  epgList.innerHTML = '<div class="empty-list-placeholder">Lade Programmübersicht...</div>';
  
  try {
    const res = await fetchXtreamApi(activeAccount, 'get_simple_data_table', { stream_id: streamId });
    epgList.innerHTML = '';
    
    if (res && res.epg_listings && res.epg_listings.length > 0) {
      currentEpgListings = res.epg_listings;
      let scrollToElement = null;
      res.epg_listings.forEach(listing => {
        const item = document.createElement('li');
        item.className = 'epg-item';
        
        const title = safeBase64Decode(listing.title);
        const desc = safeBase64Decode(listing.description);
        
        const startTimestamp = Number(listing.start_timestamp);
        const endTimestamp = Number(listing.stop_timestamp || listing.end_timestamp);
        
        const dateObj = new Date(startTimestamp * 1000);
        const dateStr = dateObj.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        const startTimeStr = dateObj.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
        const endTimeStr = new Date(endTimestamp * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
        
        const timeSpan = document.createElement('div');
        timeSpan.className = 'epg-time';
        timeSpan.textContent = `${dateStr} | ${startTimeStr} - ${endTimeStr}`;
        item.appendChild(timeSpan);
        
        const titleRow = document.createElement('div');
        titleRow.className = 'epg-title-row';
        titleRow.style.display = 'flex';
        titleRow.style.alignItems = 'center';
        titleRow.style.justifyContent = 'space-between';
        titleRow.style.width = '100%';

        const titleSpan = document.createElement('div');
        titleSpan.className = 'epg-title';
        titleSpan.textContent = title;
        titleRow.appendChild(titleSpan);

        let descSpan = null;
        if (desc) {
          const toggleBtn = document.createElement('button');
          toggleBtn.className = 'epg-toggle-desc';
          toggleBtn.innerHTML = '▼';
          toggleBtn.style.background = 'none';
          toggleBtn.style.border = 'none';
          toggleBtn.style.color = 'var(--text-muted)';
          toggleBtn.style.cursor = 'pointer';
          toggleBtn.style.fontSize = '10px';
          toggleBtn.style.padding = '4px';
          toggleBtn.style.marginLeft = '8px';
          titleRow.appendChild(toggleBtn);

          descSpan = document.createElement('div');
          descSpan.className = 'epg-desc';
          descSpan.textContent = desc;
          descSpan.style.display = 'none';

          toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (descSpan.style.display === 'none') {
              descSpan.style.display = 'block';
              toggleBtn.innerHTML = '▲';
              toggleBtn.style.color = 'var(--accent-cyan)';
            } else {
              descSpan.style.display = 'none';
              toggleBtn.innerHTML = '▼';
              toggleBtn.style.color = 'var(--text-muted)';
            }
          });
        }
        item.appendChild(titleRow);
        
        if (descSpan) {
          item.appendChild(descSpan);
        }
        
        const now = Math.floor(Date.now() / 1000);
        const hasArchive = hasCatchup && (endTimestamp < now);
        const isCurrentTimeshift = isTimeshiftActive && timeshiftProgramInfo && 
          Number(listing.start_timestamp) === Number(timeshiftProgramInfo.start_timestamp);
        const isLiveProgram = (startTimestamp <= now && endTimestamp >= now);

        if (isCurrentTimeshift) {
          item.classList.add('playing');
          scrollToElement = item;
        } else if (isLiveProgram) {
          item.classList.add('current-program');
          const badge = document.createElement('span');
          badge.className = 'epg-badge current';
          badge.textContent = 'Live';
          item.appendChild(badge);
          
          if (!scrollToElement) {
            scrollToElement = item;
          }
        } else if (hasArchive) {
          item.classList.add('has-catchup');
          const badge = document.createElement('span');
          badge.className = 'epg-badge archive';
          badge.textContent = 'Archiv';
          item.appendChild(badge);

          const mpvBtn = document.createElement('button');
          mpvBtn.className = 'mpv-direct-btn';
          mpvBtn.innerHTML = '🎬 MPV';
          mpvBtn.title = 'In MPV abspielen';
          mpvBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const baseUrl = getAccountBaseUrl(activeAccount);
            const durationMins = Math.floor((Number(listing.stop_timestamp || listing.end_timestamp) - Number(listing.start_timestamp)) / 60) || 60;
            const startFormatted = formatTimeshiftDate(listing.start_timestamp);
            const url = `${baseUrl}/timeshift/${activeAccount.username}/${activeAccount.password}/${durationMins}/${startFormatted}/${streamId}.ts`;
            const title = safeBase64Decode(listing.title);
            window.electronAPI.openInMpv(url, `${currentLiveChannelName} (Archiv: ${title})`);
          });
          item.appendChild(mpvBtn);
          
          item.addEventListener('click', () => {
            const activeItems = epgList.querySelectorAll('.epg-item.playing');
            activeItems.forEach(el => el.classList.remove('playing'));
            item.classList.add('playing');
            
            playTimeshift(listing, streamId);
          });

          item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const baseUrl = getAccountBaseUrl(activeAccount);
            const durationMins = Math.floor((Number(listing.stop_timestamp || listing.end_timestamp) - Number(listing.start_timestamp)) / 60) || 60;
            const startFormatted = formatTimeshiftDate(listing.start_timestamp);
            const url = `${baseUrl}/timeshift/${activeAccount.username}/${activeAccount.password}/${durationMins}/${startFormatted}/${streamId}.ts`;
            const title = safeBase64Decode(listing.title);
            window.electronAPI.showContextMenu(`${currentLiveChannelName} (Archiv: ${title})`, url);
          });
        }
        
        epgList.appendChild(item);
      });

      if (scrollToElement) {
        setTimeout(() => {
          scrollToElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 150);
      }
    } else {
      epgList.innerHTML = '<div class="empty-list-placeholder">Keine Programmdaten verfügbar.</div>';
    }
  } catch (e) {
    console.error("EPG fetch failed:", e);
    epgList.innerHTML = '<div class="empty-list-placeholder">Fehler beim Laden des EPGs.</div>';
  }
}

function playTimeshift(epgListing, streamId) {
  isTimeshiftActive = true;
  timeshiftProgramInfo = epgListing;
  
  const baseUrl = getAccountBaseUrl(activeAccount);
  const durationMins = Math.floor((Number(epgListing.stop_timestamp || epgListing.end_timestamp) - Number(epgListing.start_timestamp)) / 60) || 60;
  const startFormatted = formatTimeshiftDate(epgListing.start_timestamp);
  
  const url = `${baseUrl}/timeshift/${activeAccount.username}/${activeAccount.password}/${durationMins}/${startFormatted}/${streamId}.ts`;
  
  const title = safeBase64Decode(epgListing.title);
  
  if (ctrlBackToLive) {
    ctrlBackToLive.style.display = 'inline-flex';
  }
  
  const streamInfo = document.getElementById('stream-info');
  if (streamInfo) {
    streamInfo.textContent = 'ARCHIV';
    streamInfo.style.background = 'var(--accent-cyan)';
    streamInfo.style.boxShadow = '0 0 8px rgba(0, 242, 254, 0.4)';
  }
  
  playChannel(`${currentLiveChannelName} (Archiv: ${title})`, 'Timeshift TV', currentLiveChannelLogo, url);
}
