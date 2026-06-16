/**
 * IndexedDB Database Helper for IPTV Player (db.js)
 * Manages cache for Xtream Codes Accounts, Categories, and Streams.
 */
const IPTVDb = {
  dbName: 'IPTVPlayerDB',
  dbVersion: 3,
  db: null,

  /**
   * Opens the IndexedDB connection and initializes object stores.
   */
  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = (event) => {
        console.error('Database failed to open:', event.target.error);
        reject(event.target.error);
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('Database opened successfully. Version:', this.db.version);
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // 1. Accounts store
        if (!db.objectStoreNames.contains('accounts')) {
          const accountsStore = db.createObjectStore('accounts', { keyPath: 'id' });
          accountsStore.createIndex('name', 'name', { unique: false });
        }

        // 2. Categories stores (Live, VOD, Series)
        const catStores = ['live_categories', 'vod_categories', 'series_categories'];
        catStores.forEach(storeName => {
          if (!db.objectStoreNames.contains(storeName)) {
            const store = db.createObjectStore(storeName, { keyPath: 'compoundKey' });
            store.createIndex('accountId', 'accountId', { unique: false });
            store.createIndex('categoryId', 'categoryId', { unique: false });
          }
        });

        // 3. Streams stores (Live, VOD, Series)
        if (!db.objectStoreNames.contains('live_streams')) {
          const liveStore = db.createObjectStore('live_streams', { keyPath: 'compoundKey' });
          liveStore.createIndex('accountId', 'accountId', { unique: false });
          liveStore.createIndex('categoryId', 'categoryId', { unique: false });
          liveStore.createIndex('name', 'name', { unique: false });
        }

        if (!db.objectStoreNames.contains('vod_streams')) {
          const vodStore = db.createObjectStore('vod_streams', { keyPath: 'compoundKey' });
          vodStore.createIndex('accountId', 'accountId', { unique: false });
          vodStore.createIndex('categoryId', 'categoryId', { unique: false });
          vodStore.createIndex('name', 'name', { unique: false });
        }

        if (!db.objectStoreNames.contains('series')) {
          const seriesStore = db.createObjectStore('series', { keyPath: 'compoundKey' });
          seriesStore.createIndex('accountId', 'accountId', { unique: false });
          seriesStore.createIndex('categoryId', 'categoryId', { unique: false });
          seriesStore.createIndex('name', 'name', { unique: false });
        }

        // 4. EPG stores (added in v3)
        if (!db.objectStoreNames.contains('epg_programmes')) {
          const epgStore = db.createObjectStore('epg_programmes', { keyPath: 'compoundKey' });
          epgStore.createIndex('accountId', 'accountId', { unique: false });
        }
        if (!db.objectStoreNames.contains('epg_meta')) {
          db.createObjectStore('epg_meta', { keyPath: 'accountId' });
        }
      };
    });
  },

  // --- Account Operations ---

  addAccount(account) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['accounts'], 'readwrite');
      const store = transaction.objectStore('accounts');
      const request = store.put(account);

      request.onsuccess = () => resolve(account.id);
      request.onerror = (e) => reject(e.target.error);
    });
  },

  getAccounts() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['accounts'], 'readonly');
      const store = transaction.objectStore('accounts');
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e.target.error);
    });
  },

  deleteAccount(id) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['accounts'], 'readwrite');
      const store = transaction.objectStore('accounts');
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e.target.error);
    });
  },

  // --- Bulk Cache Operations ---

  saveCategories(storeName, accountId, categoriesList) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(categoriesList)) {
        console.warn(`[DB saveCategories] ${storeName} list is not an array:`, typeof categoriesList);
        resolve();
        return;
      }

      console.log(`[DB saveCategories] Starting ${storeName} cache. Count: ${categoriesList.length}`);
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      transaction.oncomplete = () => {
        console.log(`[DB saveCategories] Completed transaction for ${storeName}`);
        resolve();
      };
      transaction.onerror = (e) => {
        console.error(`[DB saveCategories] Transaction error for ${storeName}:`, e.target.error);
        reject(e.target.error);
      };

      categoriesList.forEach(cat => {
        if (!cat || !cat.category_id) return;
        const compoundKey = `${accountId}_${cat.category_id}`;
        store.put({
          compoundKey,
          accountId,
          categoryId: cat.category_id,
          categoryName: cat.category_name
        });
      });
    });
  },

  saveStreams(storeName, accountId, streamsList) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(streamsList)) {
        resolve();
        return;
      }

      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);

      transaction.oncomplete = () => resolve();
      transaction.onerror = (e) => reject(e.target.error);

      streamsList.forEach(item => {
        if (!item) return;
        let streamId = item.stream_id || item.series_id;
        if (!streamId) return;
        const compoundKey = `${accountId}_${streamId}`;
        
        let record = {
          compoundKey,
          accountId,
          categoryId: item.category_id,
          name: item.name || item.title,
          logo: item.stream_icon || item.cover
        };

        if (storeName === 'live_streams') {
          record.streamId = streamId;
          record.streamType = item.stream_type;
          record.epgChannelId = item.epg_channel_id || null;
          const isArchiveTrue = item.tv_archive && item.tv_archive !== 0 && item.tv_archive !== '0' && item.tv_archive !== false;
          const isCatchupTrue = item.catchup && item.catchup !== 0 && item.catchup !== '0' && item.catchup !== false;
          const hasCatchup = isArchiveTrue || isCatchupTrue;
          record.catchup = hasCatchup ? 1 : 0;
          record.catchupDays = parseInt(item.tv_archive_duration || item.catchup_days) || 0;
        } else if (storeName === 'vod_streams') {
          record.streamId = streamId;
          record.containerExtension = item.container_extension;
          record.added = item.added;
        } else if (storeName === 'series') {
          record.seriesId = streamId;
          record.releaseDate = item.releaseDate;
        }

        store.put(record);
      });
    });
  },

  // --- Query Operations ---

  // Internal helper: open a readonly IDB transaction on storeName, query by accountId,
  // and resolve with the full results array.
  _idbQueryByAccountId(storeName, accountId) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index('accountId');
      const request = index.getAll(IDBKeyRange.only(accountId));
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e.target.error);
    });
  },

  getCategories(storeName, accountId) {
    console.log(`[DB getCategories] Querying ${storeName} for accountId:`, accountId);
    return this._idbQueryByAccountId(storeName, accountId).then(result => {
      console.log(`[DB getCategories] Query success for ${storeName}. Found:`, result.length);
      return result;
    });
  },

  getStreamsByCategory(storeName, accountId, categoryId) {
    return this._idbQueryByAccountId(storeName, accountId).then(items => {
      if (categoryId === 'all') return items;
      return items.filter(item => String(item.categoryId) === String(categoryId));
    });
  },

  searchStreams(storeName, accountId, query) {
    return this._idbQueryByAccountId(storeName, accountId).then(items => {
      if (!query) return items;
      const lowerQuery = query.toLowerCase();
      return items.filter(item => item.name && item.name.toLowerCase().includes(lowerQuery));
    });
  },

  saveEpg(accountId, channelMap) {
    return new Promise((resolve, reject) => {
      const channelIds = Object.keys(channelMap || {});
      const tx = this.db.transaction(['epg_programmes', 'epg_meta'], 'readwrite');
      const epgStore = tx.objectStore('epg_programmes');
      const metaStore = tx.objectStore('epg_meta');

      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);

      let programmeCount = 0;
      channelIds.forEach(channelId => {
        const programmes = channelMap[channelId] || [];
        programmeCount += programmes.length;

        const key = `${accountId}_${channelId}`;
        const req = epgStore.get(key);
        req.onsuccess = () => {
          let merged = programmes;
          if (req.result && req.result.programmes) {
            const existing = req.result.programmes;
            const seen = new Set();
            const combined = [];

            programmes.forEach(p => {
              combined.push(p);
              seen.add(p.start);
            });

            existing.forEach(p => {
              if (!seen.has(p.start)) {
                combined.push(p);
                seen.add(p.start);
              }
            });

            combined.sort((a, b) => a.start - b.start);
            merged = combined;
          }

          const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
          merged = merged.filter(p => p.stop > cutoff);

          epgStore.put({
            compoundKey: key,
            accountId,
            epgChannelId: channelId,
            programmes: merged
          });
        };
      });

      metaStore.put({
        accountId,
        lastFetched: Date.now(),
        channelCount: channelIds.length,
        programmeCount
      });
    });
  },

  getEpgForChannels(accountId, epgChannelIds) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['epg_programmes'], 'readonly');
      const store = tx.objectStore('epg_programmes');
      const result = {};
      let pending = 0;
      let done = false;

      const finish = () => { if (done && pending === 0) resolve(result); };

      (epgChannelIds || []).forEach(id => {
        if (!id) return;
        pending++;
        const req = store.get(`${accountId}_${id}`);
        req.onsuccess = () => {
          if (req.result) result[id] = req.result.programmes || [];
          pending--;
          finish();
        };
        req.onerror = (e) => reject(e.target.error);
      });

      done = true;
      finish();
    });
  },

  getLiveStream(accountId, streamId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['live_streams'], 'readonly');
      const store = tx.objectStore('live_streams');
      const req = store.get(`${accountId}_${streamId}`);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  mergeChannelEpg(accountId, epgChannelId, newProgrammes) {
    return new Promise((resolve, reject) => {
      if (!epgChannelId) return resolve();
      const tx = this.db.transaction(['epg_programmes'], 'readwrite');
      const store = tx.objectStore('epg_programmes');
      const key = `${accountId}_${epgChannelId}`;

      const req = store.get(key);
      req.onsuccess = () => {
        let merged = newProgrammes;
        if (req.result && req.result.programmes) {
          const existing = req.result.programmes;
          const seen = new Set();
          const combined = [];

          newProgrammes.forEach(p => {
            combined.push(p);
            seen.add(p.start);
          });

          existing.forEach(p => {
            if (!seen.has(p.start)) {
              combined.push(p);
              seen.add(p.start);
            }
          });

          combined.sort((a, b) => a.start - b.start);
          merged = combined;
        }

        const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
        merged = merged.filter(p => p.stop > cutoff);

        store.put({
          compoundKey: key,
          accountId,
          epgChannelId,
          programmes: merged
        }).onsuccess = () => resolve();
      };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  getEpgMeta(accountId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['epg_meta'], 'readonly');
      const store = tx.objectStore('epg_meta');
      const req = store.get(accountId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  clearAccountCache(accountId) {
    const stores = ['live_categories', 'vod_categories', 'series_categories', 'live_streams', 'vod_streams', 'series', 'epg_programmes'];
    const promises = stores.map(storeName => {
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const index = store.index('accountId');
        const request = index.openCursor(IDBKeyRange.only(accountId));

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = (e) => reject(e.target.error);
      });
    });

    promises.push(new Promise((resolve, reject) => {
      const tx = this.db.transaction(['epg_meta'], 'readwrite');
      const req = tx.objectStore('epg_meta').delete(accountId);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    }));

    return Promise.all(promises);
  }
};
