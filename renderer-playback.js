function resetToLive() {
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
}

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
    localStorage.setItem('epgView', 'sidebar');
  } else {
    appContainer.classList.remove('epg-open');
    // Only clear if not switching to grid view
    if (!appContainer.classList.contains('guide-open')) {
      localStorage.setItem('epgView', 'none');
    }
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
