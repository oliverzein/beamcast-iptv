/**
 * IndexedDB Database Helper for IPTV Player (db.js)
 * Manages cache for Xtream Codes Accounts, Categories, and Streams.
 */
const IPTVDb = {
  dbName: 'IPTVPlayerDB',
  dbVersion: 2,
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

  getCategories(storeName, accountId) {
    return new Promise((resolve, reject) => {
      console.log(`[DB getCategories] Querying ${storeName} for accountId:`, accountId);
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index('accountId');
      const request = index.getAll(IDBKeyRange.only(accountId));

      request.onsuccess = () => {
        console.log(`[DB getCategories] Query success for ${storeName}. Found:`, request.result.length);
        resolve(request.result);
      };
      request.onerror = (e) => {
        console.error(`[DB getCategories] Query error for ${storeName}:`, e.target.error);
        reject(e.target.error);
      };
    });
  },

  getStreamsByCategory(storeName, accountId, categoryId) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index('accountId');
      const request = index.getAll(IDBKeyRange.only(accountId));

      request.onsuccess = () => {
        const items = request.result;
        if (categoryId === 'all') {
          resolve(items);
        } else {
          resolve(items.filter(item => String(item.categoryId) === String(categoryId)));
        }
      };
      request.onerror = (e) => reject(e.target.error);
    });
  },

  searchStreams(storeName, accountId, query) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index('accountId');
      const request = index.getAll(IDBKeyRange.only(accountId));

      request.onsuccess = () => {
        const items = request.result;
        if (!query) {
          resolve(items);
        } else {
          const lowerQuery = query.toLowerCase();
          resolve(items.filter(item => item.name && item.name.toLowerCase().includes(lowerQuery)));
        }
      };
      request.onerror = (e) => reject(e.target.error);
    });
  },

  clearAccountCache(accountId) {
    const stores = ['live_categories', 'vod_categories', 'series_categories', 'live_streams', 'vod_streams', 'series'];
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

    return Promise.all(promises);
  }
};
