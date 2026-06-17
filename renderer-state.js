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

const btnToggleGuide = document.getElementById('btn-toggle-guide');
const btnEpgClose = document.getElementById('btn-epg-close');
const epgGridContainer = document.getElementById('epg-grid-container');
const epgGridScroll = document.getElementById('epg-grid-scroll');
const epgGridCategory = document.getElementById('epg-grid-category');
const accountFormTitle = document.getElementById('account-form-title');
const btnSaveAccount = document.getElementById('btn-save-account');
const btnCancelEdit = document.getElementById('btn-cancel-edit');
const btnAddAccount = document.getElementById('btn-add-account');
const accountActiveBadge = document.getElementById('account-active-badge');
const accountDetailMeta = document.getElementById('account-detail-meta');
const accountMetaSync = document.getElementById('account-meta-sync');
const accountMetaProgrammes = document.getElementById('account-meta-programmes');
const accountMetaChannels = document.getElementById('account-meta-channels');
const accountDetailActions = document.getElementById('account-detail-actions');
const btnAccountConnect = document.getElementById('btn-account-connect');
const btnAccountSync = document.getElementById('btn-account-sync');
const btnAccountDelete = document.getElementById('btn-account-delete');

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
let selectedAccountId = null;
let controlsTimeout = null;

// MPV playback state
let isAlwaysMpvEnabled = localStorage.getItem('alwaysUseMpv') === 'true';
let isMpvActive = false;

const btnToggleAlwaysMpv = document.getElementById('btn-toggle-always-mpv');
const mpvStatusBar = document.getElementById('mpv-status-bar');
const mpvStatusText = document.getElementById('mpv-status-text');
const btnMpvStop = document.getElementById('btn-mpv-stop');
const btnMpvInternal = document.getElementById('btn-mpv-internal');
