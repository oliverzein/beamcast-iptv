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
const episodesGrid = document.getElementById('episodes-grid');

const accountsModal = document.getElementById('accounts-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const accountsList = document.getElementById('accounts-list');
const accountForm = document.getElementById('account-form');
const btnSyncXtream = document.getElementById('btn-sync-xtream');

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
  setupTranscodeStatusListener();
  
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
      reader.onload = (event) => {
        const parsed = parseM3U(event.target.result);
        if (parsed.length > 0) {
          loadPresetChannels(parsed);
        } else {
          alert("No channels found in this file.");
        }
      };
      reader.readAsText(file);
    }
  });

  channelSearch.addEventListener('input', filterChannels);
  categoryFilter.addEventListener('change', () => {
    localStorage.setItem('lastSelectedCategory', categoryFilter.value);
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
}

// Fetch M3U Playlist
async function fetchPlaylist(url) {
  statusText.textContent = "Loading playlist...";
  statusDot.className = "pulse-dot orange";
  
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch playlist");
    const text = await response.text();
    const parsed = parseM3U(text);
    if (parsed.length > 0) {
      loadPresetChannels(parsed);
      statusText.textContent = "Ready";
      statusDot.className = "pulse-dot green";
    } else {
      alert("No channels found in the playlist.");
      resetStatus();
    }
  } catch (err) {
    console.error("Error fetching playlist:", err);
    alert(`Could not load playlist: ${err.message}`);
    resetStatus();
  }
}

function resetStatus() {
  statusText.textContent = "Ready";
  statusDot.className = "pulse-dot green";
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

    if (activeChannelName && activeChannelName.textContent === ch.name) {
      li.classList.add('active');
      setTimeout(() => {
        li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 100);
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
  
  if (ctrlMpv) {
    ctrlMpv.style.display = 'inline-flex';
  }
  
  // Save stream details to localStorage for startup restoration
  localStorage.setItem('lastStreamUrl', streamUrl);
  localStorage.setItem('lastStreamName', name);
  localStorage.setItem('lastStreamGroup', group || '');
  localStorage.setItem('lastStreamLogo', logo || '');

  // Display Seek timeline only for VOD / Movies / Series Episodes (Xtream Mode)
  if (activePlaylistType === 'xtream' && activeTab !== 'live') {
    timelineContainer.style.display = 'flex';
    seekBar.value = 0;
    timeCurrent.textContent = '00:00:00';
    timeDuration.textContent = '00:00:00';
  } else {
    timelineContainer.style.display = 'none';
  }

  const proxyUrl = window.electronAPI.getProxyUrl(streamUrl, supportsHEVC);
  loadStream(proxyUrl);
}

function loadStream(proxyUrl) {
  if (mpegts.getFeatureList().mseLivePlayback) {
    const isLiveStream = activePlaylistType === 'm3u' || activeTab === 'live';
    mpegtsPlayer = mpegts.createPlayer({
      type: 'mpegts',
      isLive: isLiveStream,
      url: proxyUrl,
      enableWorker: true,
      enableStashBuffer: !isLiveStream,           // Disable stash buffer for live streams to minimize startup delay
      liveBufferLatencyChasing: isLiveStream,     // Chase buffer latency to keep playback realtime
      liveSync: isLiveStream                      // Chase latency by adjusting playback speed if needed
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

  ctrlFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      videoPlayer.requestFullscreen().catch(err => {
        console.error(`Fullscreen error: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  });

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

  // Timeline seeking for VOD
  videoPlayer.addEventListener('durationchange', () => {
    if (activePlaylistType === 'xtream' && activeTab !== 'live') {
      vodDuration = Math.floor(videoPlayer.duration);
      seekBar.max = vodDuration;
      timeDuration.textContent = formatTime(vodDuration);
    }
  });

  videoPlayer.addEventListener('timeupdate', () => {
    if (activePlaylistType === 'xtream' && activeTab !== 'live') {
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
    seekOffset = targetSeconds;
    
    destroyPlayer();
    
    loaderOverlay.classList.add('active');
    loaderText.textContent = `Seeking to ${formatTime(targetSeconds)}...`;
    
    const seekProxyUrl = window.electronAPI.getProxySeekUrl(activeStreamUrl, targetSeconds, supportsHEVC);
    loadStream(seekProxyUrl);
  });
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
}

// --- Xtream Codes Account Manager Modals & Database logic ---

function setupAccountsModal() {
  // Main Menu IPC listener
  window.electronAPI.onShowAccountsModal(() => {
    showAccountsModal();
  });

  btnCloseModal.addEventListener('click', () => {
    accountsModal.style.display = 'none';
  });

  // Save Account Submit
  accountForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('acc-name').value.trim();
    const host = document.getElementById('acc-host').value.trim();
    const username = document.getElementById('acc-user').value.trim();
    const password = document.getElementById('acc-pass').value.trim();
    
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
      actions.appendChild(btnDelete);
      
      li.appendChild(info);
      li.appendChild(actions);
      accountsList.appendChild(li);
    });
  } catch (err) {
    console.error('Failed to load accounts list:', err);
  }
}

// Connect and Cache Xtream Codes Account
async function connectXtreamAccount(account, forceSync = false) {
  accountsModal.style.display = 'none';
  
  // Check if cache is valid (less than 24 hours old) and not forcing sync
  const cacheAgeLimit = 24 * 60 * 60 * 1000; // 24 hours
  const isCacheValid = account.lastSync && (Date.now() - account.lastSync < cacheAgeLimit);

  if (isCacheValid && !forceSync) {
    console.log(`[Xtream Connect] Using cached data for account: ${account.name}`);
    activeAccount = account;
    activePlaylistType = 'xtream';
    activeTab = 'live';
    sidebarTabs.style.display = 'flex';
    tabButtons.forEach(b => b.classList.remove('active'));
    document.querySelector('.tab-btn[data-tab="live"]').classList.add('active');
    
    // Save state to localStorage
    localStorage.setItem('lastPlaylistType', 'xtream');
    localStorage.setItem('lastAccountId', account.id);
    localStorage.setItem('lastTab', activeTab);
    localStorage.setItem('lastSelectedCategory', 'all');
    
    // Show sync button
    btnSyncXtream.style.display = 'inline-flex';
    
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

    // Update account sync timestamp in IndexedDB
    account.lastSync = Date.now();
    await IPTVDb.addAccount(account);

    // Set Active Account
    activeAccount = account;
    activePlaylistType = 'xtream';
    activeTab = 'live';
    sidebarTabs.style.display = 'flex';
    tabButtons.forEach(b => b.classList.remove('active'));
    document.querySelector('.tab-btn[data-tab="live"]').classList.add('active');

    // Save state to localStorage
    localStorage.setItem('lastPlaylistType', 'xtream');
    localStorage.setItem('lastAccountId', account.id);
    localStorage.setItem('lastTab', activeTab);
    localStorage.setItem('lastSelectedCategory', 'all');

    // Show sync button
    btnSyncXtream.style.display = 'inline-flex';

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
  const lastSelectedCategory = localStorage.getItem('lastSelectedCategory') || 'all';
  const hasOption = Array.from(categoryFilter.options).some(opt => opt.value === lastSelectedCategory);
  if (hasOption) {
    categoryFilter.value = lastSelectedCategory;
  } else {
    categoryFilter.value = 'all';
    localStorage.setItem('lastSelectedCategory', 'all');
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
    const url = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${item.streamId}.ts`;
    playChannel(item.name, 'Live Channel', item.logo, url);
  } else if (activeTab === 'vod') {
    const ext = item.containerExtension || 'mp4';
    const url = `${baseUrl}/movie/${activeAccount.username}/${activeAccount.password}/${item.streamId}.${ext}`;
    playChannel(item.name, 'Movie', item.logo, url);
  } else if (activeTab === 'series') {
    loadSeriesEpisodes(item);
  }
}

// Loads Season/Episodes selector grid
async function loadSeriesEpisodes(seriesItem) {
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
    seasonSelect.onchange = () => renderEpisodesGrid(seasonSelect.value);
    
    // Select first season by default
    if (seasons.length > 0) {
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

    episodesGrid.appendChild(card);
  });
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
        statusText.textContent = `Active: ${account.name}`;
        statusDot.className = "pulse-dot green";

        // Load sidebar contents
        await loadXtreamSidebar();
        
        // 2. Restore active stream if saved
        const streamUrl = localStorage.getItem('lastStreamUrl');
        const streamName = localStorage.getItem('lastStreamName');
        const streamGroup = localStorage.getItem('lastStreamGroup');
        const streamLogo = localStorage.getItem('lastStreamLogo');
        
        if (streamUrl && streamName) {
          console.log(`[State Restore] Restoring stream: ${streamName}`);
          playChannel(streamName, streamGroup, streamLogo, streamUrl);
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
      await fetchPlaylist(lastM3uUrl);
      
      const streamUrl = localStorage.getItem('lastStreamUrl');
      const streamName = localStorage.getItem('lastStreamName');
      const streamGroup = localStorage.getItem('lastStreamGroup');
      const streamLogo = localStorage.getItem('lastStreamLogo');
      
      if (streamUrl && streamName) {
        console.log(`[State Restore] Restoring M3U stream: ${streamName}`);
        playChannel(streamName, streamGroup, streamLogo, streamUrl);
      }
    } else {
      loadPresetChannels(defaultChannels);
    }
  } else {
    loadPresetChannels(defaultChannels);
  }
}
