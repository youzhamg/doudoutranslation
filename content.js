(function() {
    'use strict';

    // ============================================================
    // 0. 原生扩展 API 兼容垫片层
    // ============================================================
    const storageCache = {};

    function GM_getValue(key, defaultVal) {
        return storageCache[key] !== undefined ? storageCache[key] : defaultVal;
    }

    function GM_setValue(key, value) {
        storageCache[key] = String(value);
        try { chrome.storage.local.set({ [key]: String(value) }); } catch(e) {}
    }

    function GM_deleteValue(key) {
        delete storageCache[key];
        try { chrome.storage.local.remove(key); } catch(e) {}
    }

    function GM_addStyle(css) {
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    function GM_xmlhttpRequest(options) {
        try {
            chrome.runtime.sendMessage({
                type: 'FETCH_CROSS_DOMAIN',
                options: {
                    url: options.url,
                    method: options.method || 'GET',
                    headers: options.headers || {},
                    data: options.data,
                    responseType: options.responseType
                }
            }, (res) => {
                if (!res) {
                    if (options.onerror) options.onerror(new Error('未收到后台响应'));
                    return;
                }
                if (options.responseType === 'arraybuffer' && res.base64Data) {
                    const bin = atob(res.base64Data);
                    const buf = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
                    if (options.onload) options.onload({ status: res.status, response: buf.buffer });
                } else {
                    if (options.onload) options.onload({ status: res.status, responseText: res.data || '' });
                }
            });
        } catch(err) {
            if (options.onerror) options.onerror(err);
        }
    }

    // 接收主页面 inject.js 截获的字幕响应
    window.__bilingual_cached_subs = window.__bilingual_cached_subs || {};
    window.__bilingual_last_sub = window.__bilingual_last_sub || '';
    window.addEventListener('__bilingual_yt_sub_caught', (e) => {
        try {
            const { url, text } = e.detail || {};
            if (!text || text.length < 30) return;
            window.__bilingual_last_sub = text;
            const parsed = new URL(url, location.href);
            const v = parsed.searchParams.get('v') || new URLSearchParams(location.search).get('v');
            if (v) window.__bilingual_cached_subs[v] = text;
        } catch(err) {}
    });

    // ============================================================
    // 1. 安全过滤与存储
    // ============================================================
    function cleanHTML(dirty) {
        if (!dirty) return '';
        if (typeof DOMPurify !== 'undefined' && DOMPurify.sanitize) {
            return DOMPurify.sanitize(dirty, {
                ADD_TAGS: ['style'],
                ADD_ATTR: ['target', 'suppresshydrationwarning']
            });
        }
        return dirty.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    }

    function setSafeHTML(el, htmlString) {
        if (!el) return;
        if (!htmlString) { el.textContent = ''; return; }
        const sanitized = cleanHTML(htmlString);
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(sanitized, 'text/html');
            el.textContent = '';
            while (doc.body.firstChild) { el.appendChild(doc.body.firstChild); }
            return;
        } catch (e) {}
        try { el.innerHTML = sanitized; return; } catch (e) {}
        el.textContent = sanitized;
    }

    function safeStorage(key, val) {
        try {
            if (val !== undefined) {
                GM_setValue(key, String(val));
                return String(val);
            }
            return String(GM_getValue(key, '') ?? '');
        } catch (e) { return ''; }
    }

    function renderSimpleMarkdown(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/```([\s\S]*?)```/g, '<pre style="background:#1e293b;color:#f8fafc;padding:8px 12px;border-radius:6px;overflow-x:auto;font-family:monospace;font-size:12px;margin:6px 0;"><code>$1</code></pre>')
            .replace(/`([^`]+)`/g, '<code style="background:#e2e8f0;color:#0f172a;padding:2px 4px;border-radius:4px;font-family:monospace;font-size:12px;">$1</code>')
            .replace(/^### (.*$)/gim, '<div style="font-weight:bold;font-size:14px;margin:8px 0 4px 0;color:#0f172a;">$1</div>')
            .replace(/^## (.*$)/gim, '<div style="font-weight:bold;font-size:15px;margin:10px 0 4px 0;color:#0f172a;border-bottom:1px solid #e2e8f0;padding-bottom:2px;">$1</div>')
            .replace(/^# (.*$)/gim, '<div style="font-weight:bold;font-size:16px;margin:12px 0 6px 0;color:#0f172a;">$1</div>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#0f172a;">$1</strong>')
            .replace(/^\s*[-*]\s+(.*$)/gim, '<div style="display:flex;gap:6px;margin:2px 0;"><span style="color:#2563eb;">•</span><span>$1</span></div>')
            .replace(/\n/g, '<br/>');
    }

    // ============================================================
    // 2. 跨域永久存储引擎
    // ============================================================
    const DB_NAME = 'BilingualPdfDB';
    const STORE_NAME = 'local_pdf_files';

    function openPdfDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = (e) => reject(e);
        });
    }

    function bufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        const chunkSize = 0x8000;
        for (let i = 0; i < len; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
        }
        return btoa(binary);
    }

    function base64ToBuffer(base64) {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    const PDF_CHUNK_SIZE = 1024 * 1024;

    async function savePermanentPdf(id, buffer) {
        try {
            const base64 = bufferToBase64(buffer);
            const totalChunks = Math.ceil(base64.length / PDF_CHUNK_SIZE);
            GM_setValue(`pdf_meta_${id}`, JSON.stringify({ totalChunks, time: Date.now() }));
            for (let i = 0; i < totalChunks; i++) {
                const chunk = base64.slice(i * PDF_CHUNK_SIZE, (i + 1) * PDF_CHUNK_SIZE);
                GM_setValue(`pdf_chunk_${id}_${i}`, chunk);
            }
        } catch (e) {}
        try {
            const db = await openPdfDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put({ id: id, data: buffer });
        } catch (e) {}
    }

    async function getPermanentPdf(id) {
        try {
            const metaStr = GM_getValue(`pdf_meta_${id}`, null);
            if (metaStr) {
                const meta = JSON.parse(metaStr);
                let base64 = '';
                for (let i = 0; i < meta.totalChunks; i++) {
                    base64 += GM_getValue(`pdf_chunk_${id}_${i}`, '');
                }
                if (base64) return base64ToBuffer(base64);
            }
        } catch (e) {}
        try {
            const db = await openPdfDB();
            return new Promise((resolve) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const req = tx.objectStore(STORE_NAME).get(id);
                req.onsuccess = () => resolve(req.result ? req.result.data : null);
                req.onerror = () => resolve(null);
            });
        } catch (e) { return null; }
    }

    async function deletePermanentPdf(id) {
        try {
            const metaStr = GM_getValue(`pdf_meta_${id}`, null);
            if (metaStr) {
                const meta = JSON.parse(metaStr);
                for (let i = 0; i < meta.totalChunks; i++) {
                    GM_deleteValue(`pdf_chunk_${id}_${i}`);
                }
                GM_deleteValue(`pdf_meta_${id}`);
            }
        } catch (e) {}
        try {
            const db = await openPdfDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(id);
        } catch (e) {}
    }

    function normalizeHistoryTitle(title) {
        if (!title) return '未命名文档';
        return String(title).replace(/[\r\n\t\x00-\x1f]/g, ' ').trim().slice(0, 100);
    }

    function isPdfMagicBytes(uint8) {
        if (!uint8 || uint8.length < 5) return false;
        const checkLen = Math.min(uint8.length - 4, 1024);
        for (let i = 0; i < checkLen; i++) {
            if (uint8[i] === 0x25 && uint8[i+1] === 0x50 && uint8[i+2] === 0x44 && uint8[i+3] === 0x46 && uint8[i+4] === 0x2D) return true;
        }
        return false;
    }

    function isSafeOnlinePdfUrl(urlStr) {
        try {
            const u = new URL(urlStr);
            if (!['http:', 'https:'].includes(u.protocol)) return false;
            if (u.username || u.password) return false;
            const host = u.hostname.toLowerCase();
            if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
            if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return false;
            if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.)/.test(host)) return false;
            return true;
        } catch (e) { return false; }
    }

    // ============================================================
    // 3. 全局样式
    // ============================================================
    GM_addStyle(`
        .bilingual-trans-node {
            display: block !important;
            color: #0284c7 !important;
            font-size: 15px !important;
            line-height: 1.6 !important;
            margin-top: 6px !important;
            margin-bottom: 10px !important;
            font-weight: 400 !important;
            user-select: text !important;
            pointer-events: auto !important;
            opacity: 1 !important;
            visibility: visible !important;
            max-width: 100% !important;
            word-break: break-word !important;
            overflow-wrap: break-word !important;
        }
        .bilingual-trans-heading {
            font-size: 18px !important;
            font-weight: 600 !important;
            line-height: 1.4 !important;
            margin-top: 8px !important;
            margin-bottom: 12px !important;
        }
        #yt-fixed-bilingual-sub {
            position: absolute !important;
            bottom: 75px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
            color: #FDE047 !important;
            font-size: 22px !important;
            font-weight: bold !important;
            line-height: 1.35 !important;
            text-align: center !important;
            text-shadow: 2px 2px 4px #000, -2px -2px 4px #000, 2px -2px 4px #000, -2px 2px 4px #000, 0 0 8px rgba(0,0,0,0.95) !important;
            background: rgba(0, 0, 0, 0.72) !important;
            border-radius: 6px !important;
            padding: 4px 14px !important;
            z-index: 60 !important;
            pointer-events: none !important;
            max-width: 88% !important;
            transition: all 0.15s ease !important;
        }
        .uni-video-sub-overlay {
            position: absolute !important;
            bottom: 50px !important;
            left: 50% !important;
            transform: translateX(-50%) !important;
            color: #FDE047 !important;
            font-size: 21px !important;
            font-weight: bold !important;
            line-height: 1.4 !important;
            text-shadow: 2px 2px 3px #000, -2px -2px 3px #000, 2px -2px 3px #000, -2px 2px 3px #000, 0 0 6px rgba(0,0,0,0.95) !important;
            background: rgba(0, 0, 0, 0.75) !important;
            border-radius: 6px !important;
            padding: 4px 12px !important;
            text-align: center !important;
            z-index: 2147483647 !important;
            pointer-events: none !important;
            max-width: 85% !important;
        }
    `);

    const SHADOW_CSS = `
        #bilingual-panel {
            position: fixed; bottom: 30px; right: 30px; z-index: 2147483647;
            display: none; align-items: center;
            background: rgba(255, 255, 255, 0.98); backdrop-filter: blur(12px);
            padding: 6px 12px; border-radius: 50px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.22); border: 1px solid rgba(0,0,0,0.12);
            font-family: system-ui, -apple-system, sans-serif; cursor: move; user-select: none;
            pointer-events: auto !important;
        }
        #bilingual-lang-select { border: 1px solid #cbd5e1; background: #fff; color: #334155; padding: 5px 8px; border-radius: 20px; font-size: 13px; outline: none; cursor: pointer; margin-right: 6px; }
        #bilingual-toggle-btn { background-color: #2563eb; color: #ffffff; border: none; border-radius: 20px; padding: 6px 14px; font-size: 13px; font-weight: bold; cursor: pointer; transition: all 0.2s ease; margin-right: 6px; }
        #bilingual-toggle-btn.active { background-color: #16a34a !important; }
        
        .bilingual-tool-btn { background: none; border: none; color: #64748b; font-size: 13px; font-weight: bold; cursor: pointer; padding: 4px 8px; border-radius: 12px; display: flex; align-items: center; justify-content: center; transition: background 0.2s; margin-right: 4px; }
        .bilingual-tool-btn:hover { background: #f1f5f9; color: #0f172a; }
        .bilingual-tool-btn.active { background: #e0f2fe; color: #0284c7; }
        
        /* 默认极简小圆球 */
        #bilingual-mini-btn {
            position: fixed; bottom: 25px; right: 25px; z-index: 2147483647;
            width: 44px; height: 44px; border-radius: 50%;
            background: linear-gradient(135deg, #2563eb, #1d4ed8);
            color: #ffffff; display: flex; align-items: center; justify-content: center;
            font-size: 20px; box-shadow: 0 6px 20px rgba(37, 99, 235, 0.45);
            cursor: pointer; user-select: none; transition: transform 0.2s, box-shadow 0.2s;
            pointer-events: auto !important;
        }
        #bilingual-mini-btn:hover { transform: scale(1.1); box-shadow: 0 8px 24px rgba(37, 99, 235, 0.6); }

        /* 气泡卡片：支持单词与长句音符 */
        #bilingual-vocab-popover {
            position: fixed; z-index: 2147483647; display: none;
            background: #ffffff; border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.06);
            border: 1px solid #e2e8f0; width: 240px; padding: 12px 14px;
            font-family: system-ui, -apple-system, sans-serif;
            transform: translate(-50%, -100%); margin-top: -12px;
            animation: vocabFadeIn 0.15s ease-out; box-sizing: border-box;
            pointer-events: auto !important;
        }
        #bilingual-vocab-popover.sentence-mode { width: 340px !important; max-width: 90vw !important; }
        @keyframes vocabFadeIn {
            from { opacity: 0; transform: translate(-50%, -90%); }
            to { opacity: 1; transform: translate(-50%, -100%); }
        }
        #bilingual-vocab-popover::after {
            content: ''; position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%);
            border-width: 6px 6px 0; border-style: solid; border-color: #ffffff transparent;
            display: block; width: 0;
        }
        .vpop-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 6px; }
        .vpop-word-wrap { display: flex; align-items: flex-start; gap: 8px; flex: 1; }
        .vpop-audio-btn {
            background: #eff6ff; border: 1px solid #bfdbfe; color: #2563eb;
            width: 26px; height: 26px; min-width: 26px; border-radius: 50%; display: flex;
            align-items: center; justify-content: center; cursor: pointer; font-size: 13px;
        }
        .vpop-audio-btn:hover { background: #dbeafe; }
        .vpop-audio-btn.playing { background: #fee2e2; color: #ef4444; border-color: #fca5a5; }
        .vpop-word { font-weight: bold; font-size: 15px; color: #0f172a; line-height: 1.35; max-height: 60px; overflow-y: auto; word-break: break-word; }
        .vpop-phonetic { font-size: 11px; color: #64748b; margin-top: 1px; display: flex; align-items: center; gap: 4px; }
        .vpop-music-tag { background: #fdf2f8; color: #db2777; border-radius: 4px; padding: 0 4px; font-weight: bold; }
        .vpop-trans { font-size: 13px; color: #0369a1; font-weight: 500; margin: 6px 0 10px 0; line-height: 1.45; max-height: 120px; overflow-y: auto; word-break: break-word; }
        .vpop-actions { display: flex; gap: 6px; }
        .vpop-btn {
            flex: 1; padding: 5px 0; font-size: 11px; font-weight: bold; border-radius: 6px;
            cursor: pointer; text-align: center; border: 1px solid transparent; transition: all 0.15s;
        }
        .vpop-btn.learned { background: #f1f5f9; color: #64748b; border-color: #e2e8f0; }
        .vpop-btn.learn { background: #f59e0b; color: #ffffff; }
        .vpop-btn.learn.saved { background: #10b981; }

        /* 生词本主界面（带长句开关与重复精听） */
        #bilingual-vocab-modal {
            position: fixed; top: 120px; right: 30px; width: 370px; height: 520px;
            background: #ffffff; border-radius: 14px; box-shadow: 0 12px 36px rgba(0,0,0,0.22);
            border: 1px solid #cbd5e1; z-index: 2147483647; display: none;
            flex-direction: column; overflow: hidden; font-family: system-ui, sans-serif;
            pointer-events: auto !important;
        }
        .vmodal-head { background: #f8fafc; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e2e8f0; }
        .vmodal-title { font-weight: bold; font-size: 13px; color: #0f172a; }
        .vmodal-subhead {
            background: #f1f5f9; padding: 8px 14px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e2e8f0; font-size: 12px;
        }
        #vmodal-toggle-sentence {
            background: #ffffff; border: 1px solid #cbd5e1; border-radius: 14px; padding: 3px 8px; font-size: 11px; font-weight: bold; cursor: pointer; transition: all 0.15s;
        }
        #vmodal-toggle-sentence.active {
            background: #16a34a !important; color: #ffffff !important; border-color: #16a34a !important;
        }
        .vmodal-list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        .vcard { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 9px 11px; display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
        .vcard-main { flex: 1; }
        .vcard-word { font-weight: bold; font-size: 13px; color: #1e293b; display: flex; align-items: center; gap: 6px; line-height: 1.4; word-break: break-word; }
        .vcard-tag { font-size: 10px; padding: 1px 4px; border-radius: 4px; font-weight: bold; }
        .vcard-tag.sentence { background: #fce7f3; color: #be185d; }
        .vcard-tag.word { background: #e0f2fe; color: #0369a1; }
        .vcard-trans { font-size: 12px; color: #0284c7; margin-top: 4px; line-height: 1.4; word-break: break-word; }
        .vcard-ctrls { display: flex; align-items: center; gap: 4px; }
        .vcard-btn { border: none; background: none; cursor: pointer; font-size: 13px; color: #64748b; padding: 2px 4px; border-radius: 4px; }
        .vcard-btn:hover { background: #e2e8f0; color: #0f172a; }
        .vcard-btn.playing { color: #ef4444; font-weight: bold; }

        #bilingual-pdf-modal { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(8px); z-index: 2147483647; display: none; align-items: center; justify-content: center; pointer-events: auto !important; }
        #bilingual-pdf-container { width: 92%; max-width: 1350px; height: 94vh; background: #ffffff; border-radius: 16px; box-shadow: 0 20px 40px rgba(0,0,0,0.35); display: flex; flex-direction: column; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }
        #bilingual-pdf-container.fullscreen { width: 100vw !important; height: 100vh !important; max-width: none !important; border-radius: 0 !important; }
        #bilingual-pdf-header { padding: 10px 18px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .pdf-header-left { display: flex; align-items: center; gap: 8px; flex: 1; flex-wrap: wrap; }
        .pdf-header-right { display: flex; align-items: center; gap: 6px; }
        .pdf-win-btn { background: none; border: none; font-size: 13px; cursor: pointer; color: #64748b; padding: 4px 8px; border-radius: 6px; }
        .pdf-win-btn:hover { background: #e2e8f0; color: #0f172a; }
        #pdf-url-input { padding: 5px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; width: 220px; outline: none; }
        #bilingual-pdf-main-area { display: flex; flex: 1; overflow: hidden; background: #f1f5f9; }
        #pdf-sidebar { width: 330px; background: #f8fafc; border-right: 1px solid #e2e8f0; display: flex; flex-direction: column; }
        #pdf-sidebar.collapsed { width: 0px !important; border-right: none; overflow: hidden; }
        #pdf-sidebar-tabs { display: flex; border-bottom: 1px solid #e2e8f0; background: #f1f5f9; }
        .sidebar-tab-btn { flex: 1; padding: 10px 0; border: none; background: none; font-size: 13px; font-weight: bold; color: #64748b; cursor: pointer; }
        .sidebar-tab-btn.active { background: #ffffff; color: #2563eb; border-bottom: 2px solid #2563eb; }
        #pdf-history-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
        #pdf-history-list { flex: 1; overflow-y: auto; padding: 10px; }
        .history-item { padding: 8px 10px; margin-bottom: 6px; border-radius: 8px; background: #ffffff; border: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; cursor: pointer; font-size: 12px; color: #334155; }
        .history-item:hover { background: #eff6ff; border-color: #93c5fd; }
        .history-badge { font-size: 10px; padding: 1px 4px; border-radius: 4px; margin-right: 4px; font-weight: bold; }
        .history-badge.local { background: #dbeafe; color: #1e40af; }
        .history-badge.online { background: #dcfce7; color: #166534; }
        .history-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-right: 6px; }
        .history-del-btn { border: none; background: none; color: #94a3b8; cursor: pointer; font-size: 13px; }
        .history-del-btn:hover { color: #ef4444; }
        #gemini-chat-view { flex: 1; display: none; flex-direction: column; overflow: hidden; background: #ffffff; }
        #gemini-msg-container { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
        .gemini-msg { padding: 8px 12px; border-radius: 10px; font-size: 13px; line-height: 1.55; max-width: 92%; word-break: break-word; }
        .gemini-msg.user { background: #2563eb; color: #ffffff; align-self: flex-end; border-bottom-right-radius: 2px; white-space: pre-wrap; }
        .gemini-msg.ai { background: #f8fafc; color: #1e293b; align-self: flex-start; border-bottom-left-radius: 2px; border: 1px solid #e2e8f0; }
        .gemini-msg-img { max-width: 100%; max-height: 140px; border-radius: 6px; margin-top: 4px; display: block; }
        #gemini-input-area { padding: 8px 10px; border-top: 1px solid #e2e8f0; background: #f8fafc; display: flex; flex-direction: column; gap: 6px; }
        #gemini-attach-preview { display: none; align-items: center; gap: 8px; background: #e2e8f0; padding: 4px 8px; border-radius: 6px; font-size: 11px; color: #334155; }
        #gemini-attach-thumb { width: 28px; height: 28px; object-fit: cover; border-radius: 4px; border: 1px solid #cbd5e1; }
        #gemini-remove-img { border: none; background: none; color: #ef4444; cursor: pointer; font-weight: bold; margin-left: auto; }
        #gemini-quote-preview { display: none; font-size: 11px; color: #64748b; background: #e2e8f0; padding: 4px 8px; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #gemini-input-box { width: 100%; height: 52px; padding: 6px 8px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 6px; outline: none; resize: none; box-sizing: border-box; }
        .gemini-tool-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 4px; }
        .gemini-btn { background: #2563eb; color: #fff; border: none; padding: 4px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: bold; }
        .gemini-quote-btn { background: #f1f5f9; border: 1px solid #cbd5e1; color: #475569; font-size: 11px; padding: 3px 6px; border-radius: 4px; cursor: pointer; }
        .gemini-quote-btn:hover { background: #e2e8f0; }
        #bilingual-pdf-body { flex: 1; padding: 25px 35px; overflow-y: auto; line-height: 1.7; color: #1e293b; }
        .pdf-page-card { background: #ffffff; border-radius: 12px; padding: 24px; margin-bottom: 35px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
        .pdf-page-title { font-size: 13px; font-weight: bold; color: #64748b; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #f1f5f9; padding-bottom: 6px; }
        .pdf-canvas-container { text-align: center; margin-bottom: 20px; background: #f8fafc; border-radius: 8px; padding: 10px; border: 1px solid #f1f5f9; }
        .pdf-page-canvas { display: inline-block; max-width: 100%; height: auto; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); background: #ffffff; }
        .pdf-block { margin-bottom: 18px; padding-bottom: 12px; border-bottom: 1px dashed #f1f5f9; }
        .pdf-origin { font-size: var(--pdf-font-size, 15px); line-height: 1.65; color: #334155; }
        .pdf-trans { font-size: var(--pdf-font-size, 15px); line-height: 1.65; color: #0284c7; margin-top: 6px; font-weight: 500; }
        #bilingual-pdf-container.fullscreen #bilingual-pdf-body { padding: 35px 80px !important; }

        #bilingual-video-panel {
            position: fixed; top: 100px; right: 25px; width: 420px; height: 560px;
            background: rgba(255, 255, 255, 0.98); backdrop-filter: blur(12px);
            border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.3);
            border: 1px solid #cbd5e1; z-index: 2147483647; display: none;
            flex-direction: column; overflow: hidden; resize: both; min-width: 320px; min-height: 360px;
            font-family: system-ui, -apple-system, sans-serif; box-sizing: border-box;
            pointer-events: auto !important;
        }
        #uni-note-header { background: #f1f5f9; padding: 10px 14px; cursor: move; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e2e8f0; user-select: none; }
        .unote-title { font-weight: bold; font-size: 13px; color: #1e293b; display: flex; align-items: center; gap: 6px; }
        .unote-ctrls { display: flex; align-items: center; gap: 5px; }
        .unote-ctrls button { background: none; border: none; font-size: 12px; cursor: pointer; color: #64748b; padding: 3px 6px; border-radius: 6px; }
        .unote-ctrls button:hover { background: #e2e8f0; color: #0f172a; }
        #unote-full-extract-btn { background: #f59e0b !important; color: #ffffff !important; font-weight: bold; padding: 3px 8px !important; border-radius: 6px; }
        #unote-full-extract-btn:hover { background: #d97706 !important; }
        #uni-note-tabs { display: flex; border-bottom: 1px solid #e2e8f0; background: #fff; }
        .unote-tab { flex: 1; padding: 9px 0; text-align: center; font-size: 12px; font-weight: bold; color: #64748b; cursor: pointer; border-bottom: 2px solid transparent; }
        .unote-tab.active { color: #2563eb; border-bottom: 2px solid #2563eb; background: #f8fafc; }
        #uni-note-stream { flex: 1; overflow-y: auto; padding: 14px; background: #ffffff; display: flex; flex-direction: column; gap: 10px; scroll-behavior: smooth; }
        .unote-line { border-left: 3px solid #38bdf8; padding-left: 10px; margin-bottom: 4px; cursor: pointer; border-radius: 0 4px 4px 0; }
        .unote-line:hover { background: #f8fafc; }
        .unote-time-tag { font-size: 10px; color: #0284c7; background: #e0f2fe; padding: 1px 5px; border-radius: 4px; font-weight: bold; display: inline-block; margin-bottom: 3px; }
        .unote-en { font-size: 12px; color: #64748b; margin-bottom: 2px; line-height: 1.4; word-break: break-word; }
        .unote-zh { font-size: 13px; color: #0f172a; font-weight: 600; line-height: 1.4; word-break: break-word; }
        #uni-note-history { flex: 1; overflow-y: auto; padding: 12px; background: #f8fafc; display: none; flex-direction: column; gap: 8px; }
        .uhist-card { background: #fff; padding: 12px; border-radius: 8px; border: 1px solid #e2e8f0; cursor: pointer; position: relative; }
        .uhist-title { font-size: 12px; font-weight: bold; color: #1e293b; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 140px; }
        .uhist-meta { font-size: 11px; color: #94a3b8; }
        .uhist-btns { position: absolute; right: 8px; top: 10px; display: flex; gap: 4px; }
        .uhist-btn { border: none; padding: 3px 6px; border-radius: 4px; font-size: 11px; cursor: pointer; font-weight: 500; }
        .uhist-btn.dl { background: #2563eb; color: #fff; }
        .uhist-btn.srt { background: #10b981; color: #fff; }
        .uhist-btn.del { background: #fee2e2; color: #ef4444; }
    `;

    // ============================================================
    // 4. PDF 引擎加载器
    // ============================================================
    async function ensurePdfJsLoaded(onProgress) {
        if (typeof window.pdfjsLib !== 'undefined') {
            if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
                window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('libs/pdf.worker.min.js');
            }
            return window.pdfjsLib;
        }
        throw new Error('未加载到本地 PDF.js 引擎，请确认 libs 目录文件完整');
    }

    // ============================================================
    // 5. Shadow DOM 宿主
    // ============================================================
    let shadowRootNode = null;
    let shadowHostElement = null;

    function getShadowRoot() {
        if (shadowRootNode) {
            syncFullscreenRoot();
            return shadowRootNode;
        }

        const host = document.createElement('div');
        host.id = 'bilingual-shadow-host';
        host.setAttribute('suppresshydrationwarning', 'true');
        host.style.cssText = 'position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; pointer-events: none !important;';
        
        (document.body || document.documentElement).appendChild(host);

        shadowHostElement = host;
        shadowRootNode = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = SHADOW_CSS;
        shadowRootNode.appendChild(style);

        syncFullscreenRoot();
        return shadowRootNode;
    }

    function syncFullscreenRoot() {
        if (!shadowHostElement) return;
        const fs = document.fullscreenElement;
        const targetParent = fs || (document.body || document.documentElement);
        if (shadowHostElement.parentElement !== targetParent) {
            try { targetParent.appendChild(shadowHostElement); } catch (e) {}
        }
    }

    document.addEventListener('fullscreenchange', syncFullscreenRoot, true);

    // ============================================================
    // 6. 双引擎智能翻译池：Google优先 + DeepL备用
    // ============================================================
    const translateCache = new Map();
    const CACHE_MAX_SIZE = 3000;
    const translateInFlight = new Map();

    function lruGet(key) {
        if (!translateCache.has(key)) return undefined;
        const val = translateCache.get(key);
        translateCache.delete(key);
        translateCache.set(key, val);
        return val;
    }

    function lruSet(key, val) {
        if (translateCache.size >= CACHE_MAX_SIZE) {
            const oldestKey = translateCache.keys().next().value;
            translateCache.delete(oldestKey);
        }
        translateCache.set(key, val);
    }

    function toDeepLLangCode(lang) {
        if (!lang) return 'ZH';
        const l = lang.toLowerCase();
        if (l.startsWith('zh')) return 'ZH';
        if (l.startsWith('en')) return 'EN';
        if (l.startsWith('ja')) return 'JA';
        if (l.startsWith('es')) return 'ES';
        if (l.startsWith('ko')) return 'KO';
        if (l.startsWith('ar')) return 'AR';
        return lang.toUpperCase();
    }

    function callGoogleAPI(text, targetLang) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`,
                timeout: 3000,
                onload: (res) => {
                    try {
                        const result = JSON.parse(res.responseText)[0].map(i => i[0]).join('');
                        if (result) resolve(result);
                        else reject(new Error('Google返回为空'));
                    } catch (e) { reject(e); }
                },
                onerror: reject,
                ontimeout: () => reject(new Error('Google超时'))
            });
        });
    }

    function callDeepLAPI(text, targetLang) {
        const dlLang = toDeepLLangCode(targetLang);
        return new Promise((resolve, reject) => {
            const id = Math.floor(Math.random() * 89999 + 100000) * 1000;
            const postBody = {
                jsonrpc: "2.0",
                method: "LMT_handle_jobs",
                params: {
                    jobs: [{ kind: "default", sentences: [{ text: text, id: 0, prefix: "" }] }],
                    lang: { target_lang: dlLang, source_lang_user_selected: "auto" },
                    priority: -1
                },
                id: id
            };

            GM_xmlhttpRequest({
                method: "POST",
                url: "https://www2.deepl.com/jsonrpc?client=chrome-extension",
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify(postBody),
                timeout: 3500,
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        const trans = data?.result?.translations?.[0]?.beams?.[0]?.sentences?.[0]?.text;
                        if (trans) return resolve(trans);
                    } catch (e) {}

                    GM_xmlhttpRequest({
                        method: "POST",
                        url: "https://deeplx.regery.com/translate",
                        headers: { "Content-Type": "application/json" },
                        data: JSON.stringify({ text: text, target_lang: dlLang }),
                        timeout: 3000,
                        onload: (r2) => {
                            try {
                                const d2 = JSON.parse(r2.responseText);
                                if (d2.data) return resolve(d2.data);
                            } catch(e) {}
                            reject(new Error('DeepL备用节点无响应'));
                        },
                        onerror: reject,
                        ontimeout: reject
                    });
                },
                onerror: reject,
                ontimeout: () => reject(new Error('DeepL超时'))
            });
        });
    }

    function fetchBilingualTranslate(text, targetLang) {
        const normalizedText = (text || '').trim();
        if (!normalizedText) return Promise.resolve('');
        const cacheKey = `${targetLang}::${normalizedText}`;
        const cached = lruGet(cacheKey);
        if (cached !== undefined) return Promise.resolve(cached);

        if (translateInFlight.has(cacheKey)) {
            return translateInFlight.get(cacheKey);
        }

        const reqPromise = (async () => {
            try {
                const resGoogle = await callGoogleAPI(normalizedText, targetLang);
                if (resGoogle) {
                    lruSet(cacheKey, resGoogle);
                    return resGoogle;
                }
            } catch (errGoogle) {
                try {
                    const resDeepL = await callDeepLAPI(normalizedText, targetLang);
                    if (resDeepL) {
                        lruSet(cacheKey, resDeepL);
                        return resDeepL;
                    }
                } catch (errDeepL) {}
            }
            return '';
        })().finally(() => {
            translateInFlight.delete(cacheKey);
        });

        translateInFlight.set(cacheKey, reqPromise);
        return reqPromise;
    }

    async function runWithConcurrency(tasks, limit = 3) {
        const results = [];
        const executing = [];
        for (const task of tasks) {
            const p = Promise.resolve().then(() => task());
            results.push(p);
            if (limit <= tasks.length) {
                const e = p.then(() => executing.splice(executing.indexOf(e), 1));
                executing.push(e);
                if (executing.length >= limit) {
                    await Promise.race(executing);
                }
            }
        }
        return Promise.all(results);
    }

    // ============================================================
    // 7. 视频字幕引擎
    // ============================================================
    let isVideoNoteRecording = false;

    function getVideoUniqueKey() {
        try {
            if (window.location.hostname.includes('youtube.com')) {
                return 'yt_' + (new URLSearchParams(window.location.search).get('v') || window.location.pathname);
            }
            return window.location.hostname + window.location.pathname;
        } catch(e) {
            return 'video_' + Date.now();
        }
    }

    function getVideoNotesDB() {
        try {
            return JSON.parse(safeStorage('uni_video_notes_db') || '{}');
        } catch(e) { return {}; }
    }

    function saveVideoNotesDB(db) {
        try {
            safeStorage('uni_video_notes_db', JSON.stringify(db));
        } catch(e) {}
    }

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '00:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    function formatSrtTime(seconds) {
        if (!seconds || isNaN(seconds)) return '00:00:00,000';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    }

    function getCurrentVideoTimeData() {
        const v = document.querySelector('video');
        if (v && !isNaN(v.currentTime)) {
            return { text: formatTime(v.currentTime), sec: Math.floor(v.currentTime) };
        }
        return { text: '', sec: 0 };
    }

    let lastSavedSubtitleText = '';
    let currentWatchedVideoKey = '';

    function appendAndSaveVideoNote(enText, zhText) {
        if (!isVideoNoteRecording || !enText) return;

        const cleanEn = enText.trim();
        if (cleanEn === lastSavedSubtitleText) return;

        const timeData = getCurrentVideoTimeData();
        const vKey = getVideoUniqueKey();
        const shadow = getShadowRoot();
        const streamView = shadow ? shadow.querySelector('#uni-note-stream') : null;

        const db = getVideoNotesDB();
        if (!db[vKey]) {
            const title = document.title.replace(' - YouTube', '').replace(' | TED Talk', '');
            db[vKey] = {
                title: title || '未命名视频',
                date: new Date().toLocaleString(),
                lines: []
            };
        }
        if (!Array.isArray(db[vKey].lines)) db[vKey].lines = [];

        const lines = db[vKey].lines;
        const lastLine = lines.length > 0 ? lines[lines.length - 1] : null;

        const isExtension = lastLine && (
            cleanEn.startsWith(lastLine.en) ||
            cleanEn.toLowerCase().startsWith(lastLine.en.toLowerCase())
        ) && (timeData.sec - (lastLine.sec || 0) <= 4);

        if (isExtension) {
            lastLine.en = cleanEn;
            lastLine.zh = zhText;
            lastLine.time = timeData.text;
            lastLine.sec = timeData.sec;

            if (streamView && streamView.lastElementChild && streamView.lastElementChild.classList.contains('unote-line')) {
                const targetNode = streamView.lastElementChild;
                const enEl = targetNode.querySelector('.unote-en');
                const zhEl = targetNode.querySelector('.unote-zh');
                if (enEl) enEl.textContent = cleanEn;
                if (zhEl) zhEl.textContent = zhText;
            }
        } else {
            lines.push({ en: cleanEn, zh: zhText, time: timeData.text, sec: timeData.sec });

            if (streamView) {
                if (streamView.textContent.includes('记录已暂停') || streamView.textContent.includes('点击') || streamView.textContent.includes('已开始监听')) {
                    streamView.textContent = '';
                }
                const line = document.createElement('div');
                line.className = 'unote-line';
                line.title = '点击跳转播放';
                line.onclick = () => {
                    const v = document.querySelector('video');
                    if (v && timeData.sec) v.currentTime = timeData.sec;
                };

                setSafeHTML(line, `
                    ${timeData.text ? `<span class="unote-time-tag">⏱️ ${timeData.text}</span>` : ''}
                    <div class="unote-en"></div>
                    <div class="unote-zh"></div>
                `);
                line.querySelector('.unote-en').textContent = cleanEn;
                line.querySelector('.unote-zh').textContent = zhText;

                streamView.appendChild(line);
                streamView.scrollTop = streamView.scrollHeight;
            }
        }

        lastSavedSubtitleText = cleanEn;
        saveVideoNotesDB(db);
    }

    function restoreCurrentVideoNotes() {
        const vKey = getVideoUniqueKey();
        const db = getVideoNotesDB();
        const shadow = getShadowRoot();
        const streamView = shadow ? shadow.querySelector('#uni-note-stream') : null;
        if (!streamView) return;

        if (!db[vKey] || !Array.isArray(db[vKey].lines) || db[vKey].lines.length === 0) {
            setSafeHTML(streamView, `
                <div style="font-size:12px;color:#94a3b8;text-align:center;padding-top:40px;">
                    ${isVideoNoteRecording ? '🟢 正在监听视频字幕...' : '⏸️ 记录已暂停<br><br>💡 点击 <b>【⚡ 全轨抓取】</b> 瞬间导出整部视频全篇双语字幕<br>或点击 <b>【▶️ 实时记录】</b> 边看边录'}
                </div>
            `);
            return;
        }

        streamView.textContent = '';
        db[vKey].lines.forEach(item => {
            const line = document.createElement('div');
            line.className = 'unote-line';
            line.title = '点击跳转播放';
            line.onclick = () => {
                const v = document.querySelector('video');
                if (v && item.sec) v.currentTime = item.sec;
            };
            setSafeHTML(line, `
                ${item.time ? `<span class="unote-time-tag">⏱️ ${item.time}</span>` : ''}
                <div class="unote-en"></div>
                <div class="unote-zh"></div>
            `);
            line.querySelector('.unote-en').textContent = item.en;
            line.querySelector('.unote-zh').textContent = item.zh;
            streamView.appendChild(line);
        });

        if (db[vKey].lines.length > 0) {
            lastSavedSubtitleText = db[vKey].lines[db[vKey].lines.length - 1].en;
        }
        setTimeout(() => { streamView.scrollTop = streamView.scrollHeight; }, 100);
    }

    function renderVideoHistoryUI() {
        const shadow = getShadowRoot();
        const histView = shadow ? shadow.querySelector('#uni-note-history') : null;
        if (!histView) return;

        const db = getVideoNotesDB();
        histView.textContent = '';
        const keys = Object.keys(db).reverse();

        if (keys.length === 0) {
            setSafeHTML(histView, '<div style="font-size:12px;color:#94a3b8;text-align:center;padding-top:40px;">暂无历史视频笔记~</div>');
            return;
        }

        keys.forEach(k => {
            const data = db[k];
            if (!data || !Array.isArray(data.lines)) return;

            const card = document.createElement('div');
            card.className = 'uhist-card';
            setSafeHTML(card, `
                <div class="uhist-title"></div>
                <div class="uhist-meta">${data.date} | 共 ${data.lines.length} 句</div>
                <div class="uhist-btns">
                    <button class="uhist-btn dl">TXT</button>
                    <button class="uhist-btn srt">SRT字幕</button>
                    <button class="uhist-btn del">删除</button>
                </div>
            `);
            card.querySelector('.uhist-title').textContent = data.title;
            card.querySelector('.uhist-title').title = data.title;

            card.querySelector('.dl').onclick = (e) => {
                e.stopPropagation();
                let txt = `【全篇双语视频字幕】\n视频标题: ${data.title}\n提取时间: ${data.date}\n总行数: ${data.lines.length}\n\n====================\n\n`;
                data.lines.forEach(l => {
                    const tag = l.time ? `[${l.time}] ` : '';
                    txt += `${tag}${l.en}\n${tag}${l.zh}\n\n`;
                });
                downloadTextFile(`[双语笔记] ${data.title.slice(0, 25)}.txt`, txt);
            };

            card.querySelector('.srt').onclick = (e) => {
                e.stopPropagation();
                let srt = '';
                data.lines.forEach((l, idx) => {
                    const startSec = l.sec || (idx * 3);
                    const dur = l.dur || 3;
                    const endSec = startSec + dur;
                    srt += `${idx + 1}\n`;
                    srt += `${formatSrtTime(startSec)} --> ${formatSrtTime(endSec)}\n`;
                    srt += `${l.zh}\n${l.en}\n\n`;
                });
                downloadTextFile(`[双语字幕] ${data.title.slice(0, 25)}.srt`, srt);
            };

            card.querySelector('.del').onclick = (e) => {
                e.stopPropagation();
                if (confirm('确定删除该视频的历史笔记？')) {
                    const curDb = getVideoNotesDB();
                    delete curDb[k];
                    saveVideoNotesDB(curDb);
                    renderVideoHistoryUI();
                }
            };

            card.onclick = () => {
                const tabLive = shadow.querySelector('#tab-live');
                if (tabLive) tabLive.click();
                const streamView = shadow.querySelector('#uni-note-stream');
                if (!streamView) return;

                streamView.textContent = '';
                const archiveHeader = document.createElement('div');
                archiveHeader.style.cssText = 'background:#f1f5f9;padding:8px;border-radius:6px;font-size:12px;font-weight:bold;color:#1e293b;margin-bottom:8px;';
                archiveHeader.textContent = `📖 回放档案: ${data.title}`;
                streamView.appendChild(archiveHeader);

                data.lines.forEach(item => {
                    const line = document.createElement('div');
                    line.className = 'unote-line';
                    line.title = '点击跳转播放';
                    line.onclick = () => {
                        const v = document.querySelector('video');
                        if (v && item.sec) v.currentTime = item.sec;
                    };
                    setSafeHTML(line, `
                        ${item.time ? `<span class="unote-time-tag">⏱️ ${item.time}</span>` : ''}
                        <div class="unote-en"></div>
                        <div class="unote-zh"></div>
                    `);
                    line.querySelector('.unote-en').textContent = item.en;
                    line.querySelector('.unote-zh').textContent = item.zh;
                    streamView.appendChild(line);
                });
            };

            histView.appendChild(card);
        });
    }

    function getYouTubeCurrentTracks() {
        try {
            const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
            if (player && typeof player.getOption === 'function') {
                const active = player.getOption('captions', 'track');
                const url = active?.baseUrl || active?.url;
                if (url) return [{ baseUrl: url, languageCode: active.languageCode || 'en', name: active.name }];
                const trks = player.getOption('captions', 'tracklist');
                if (trks && trks.length > 0) return trks;
            }
            if (player && typeof player.getPlayerResponse === 'function') {
                const trks = player.getPlayerResponse()?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                if (trks && trks.length > 0) return trks;
            }
        } catch (e) {}
        return null;
    }

    function fetchWithFullAuth(url, ms = 4000) {
        return new Promise((resolve) => {
            let isDone = false;
            const finish = (text) => {
                if (!isDone) { isDone = true; resolve(text || ''); }
            };
            const timer = setTimeout(() => finish(''), ms);

            try {
                fetch(url, { credentials: 'include' })
                    .then(response => response.ok ? response.text() : '')
                    .then(text => { clearTimeout(timer); if (text) finish(text); })
                    .catch(() => {});
            } catch (e) {}

            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: Math.max(1000, ms - 500),
                    onload: (response) => {
                        if (response.status >= 200 && response.status < 300) {
                            finish(response.responseText || '');
                        }
                    }
                });
            } catch (e) {}
        });
    }

    function parseYouTubeSubtitles(raw) {
        if (!raw || typeof raw !== 'string') return [];
        const text = raw.trim();
        const list = [];

        if (text.includes('<text')) {
            const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
            let m;
            while ((m = re.exec(text)) !== null) {
                const attrs = m[1];
                let cue = m[2] || '';
                const startMatch = attrs.match(/\bstart="([\d.]+)"/);
                const durMatch = attrs.match(/\bdur="([\d.]+)"/);
                if (startMatch) {
                    const start = parseFloat(startMatch[1]) || 0;
                    const dur = durMatch ? (parseFloat(durMatch[1]) || 3) : 3;
                    cue = cue
                        .replace(/&amp;#39;|&#39;|&apos;/g, "'")
                        .replace(/&amp;quot;|&quot;/g, '"')
                        .replace(/&amp;lt;|&lt;/g, '<')
                        .replace(/&amp;gt;|&gt;/g, '>')
                        .replace(/&amp;/g, '&')
                        .replace(/<[^>]*>/g, '')
                        .replace(/\n/g, ' ')
                        .trim();
                    if (cue) list.push({ start, dur, text: cue });
                }
            }
            if (list.length > 0) return list;
        }

        if (text.includes('<p ') && text.includes('</p>')) {
            const reP = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
            let m;
            while ((m = reP.exec(text)) !== null) {
                const attrs = m[1];
                let cue = m[2] || '';
                const tMatch = attrs.match(/\bt="(\d+)"/);
                const dMatch = attrs.match(/\bd="(\d+)"/);
                if (tMatch) {
                    const start = parseInt(tMatch[1], 10) / 1000;
                    const dur = dMatch ? (parseInt(dMatch[1], 10) / 1000) : 3;
                    cue = cue.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\n/g, ' ').trim();
                    if (cue) list.push({ start, dur, text: cue });
                }
            }
            if (list.length > 0) return list;
        }

        if (text.startsWith('{') && text.includes('"events"')) {
            try {
                const data = JSON.parse(text);
                if (Array.isArray(data.events)) {
                    data.events.forEach(ev => {
                        if (ev.segs && Array.isArray(ev.segs)) {
                            const cueText = ev.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
                            if (cueText) {
                                list.push({
                                    start: (ev.tStartMs || 0) / 1000,
                                    dur: (ev.dDurationMs || 3000) / 1000,
                                    text: cueText
                                });
                            }
                        }
                    });
                }
                if (list.length > 0) return list;
            } catch (e) {}
        }

        return list;
    }

    let isFullExtracting = false;
    let lastYouTubeOriginalCues = [];
    let lastYouTubeBilingualResults = [];
    let lastYouTubeSubtitleTitle = 'YouTube字幕';

    async function extractFullVideoSubtitles(targetLang) {
        if (isFullExtracting) return;
        const shadow = getShadowRoot();
        const streamView = shadow ? shadow.querySelector('#uni-note-stream') : null;
        const extractBtn = shadow ? shadow.querySelector('#unote-full-extract-btn') : null;
        const vKey = getVideoUniqueKey();

        let realTitle = '';
        try {
            const player = document.getElementById('movie_player');
            realTitle = player?.getVideoData?.()?.title;
        } catch(e) {}
        if (!realTitle) {
            realTitle = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent || document.title;
        }
        realTitle = realTitle.replace(' - YouTube', '').trim() || '完整视频字幕';

        isFullExtracting = true;
        if (extractBtn) extractBtn.innerText = '⚡ 提取中...';

        if (streamView) {
            setSafeHTML(streamView, `
                <div style="padding:25px;text-align:center;background:#f8fafc;border-radius:10px;border:1px dashed #cbd5e1;">
                    <div style="font-size:14px;font-weight:bold;color:#1e293b;margin-bottom:8px;">⚡ 正在直连当前视频音轨...</div>
                    <div id="full-extract-status" style="font-size:12px;color:#64748b;">正在检索播放器字幕数据...</div>
                </div>
            `);
        }

        const statusEl = streamView ? streamView.querySelector('#full-extract-status') : null;

        try {
            let fullResults = [];
            let origList = [];

            if (window.location.hostname.includes('youtube.com')) {
                const curVid = new URLSearchParams(location.search).get('v');
                let rawSubText = window.__bilingual_cached_subs?.[curVid] || window.__bilingual_last_sub || '';
                if (rawSubText) origList = parseYouTubeSubtitles(rawSubText);

                if (origList.length === 0) {
                    const tracks = getYouTubeCurrentTracks();
                    if (tracks && tracks.length > 0) {
                        let track = tracks.find(t => t.languageCode === 'en' || t.languageCode?.startsWith('en')) || tracks[0];
                        const trackUrl = track.baseUrl || track.url;
                        if (trackUrl) {
                            if (statusEl) statusEl.innerText = `锁定当前音轨，下载中...`;
                            rawSubText = await fetchWithFullAuth(trackUrl, 4000);
                            origList = parseYouTubeSubtitles(rawSubText);
                            if (origList.length === 0) {
                                const sep = trackUrl.includes('?') ? '&' : '?';
                                rawSubText = await fetchWithFullAuth(`${trackUrl}${sep}fmt=srv3`, 3000);
                                origList = parseYouTubeSubtitles(rawSubText);
                            }
                        }
                    }
                }

                if (origList.length === 0) {
                    const video = document.querySelector('video');
                    if (video && video.textTracks && video.textTracks.length > 0) {
                        for (let i = 0; i < video.textTracks.length; i++) {
                            const trk = video.textTracks[i];
                            if (trk.cues && trk.cues.length > 0) {
                                for (let j = 0; j < trk.cues.length; j++) {
                                    const c = trk.cues[j];
                                    const text = (c.text || '').replace(/<[^>]*>/g, '').trim();
                                    if (text) origList.push({ start: c.startTime, dur: c.endTime - c.startTime, text: text });
                                }
                                break;
                            }
                        }
                    }
                }

                if (origList.length === 0) throw new Error('未检测到字幕数据。请确认播放器底部的 [CC] 按钮已开启。');

                if (statusEl) statusEl.innerText = `✅ 成功提取 ${origList.length} 句字幕，正在调用智能双引擎翻译...`;
                fullResults = await batchTranslateCues(origList, targetLang, statusEl);

            } else {
                const video = document.querySelector('video');
                let cuesList = [];
                if (video && video.textTracks && video.textTracks.length > 0) {
                    const track = Array.from(video.textTracks).find(t => t.cues && t.cues.length > 0) || video.textTracks[0];
                    if (track && track.cues) {
                        for (let i = 0; i < track.cues.length; i++) {
                            const c = track.cues[i];
                            const raw = c.text.replace(/<[^>]*>/g, '').trim();
                            if (raw) cuesList.push({ start: c.startTime, dur: c.endTime - c.startTime, text: raw });
                        }
                    }
                }
                if (cuesList.length === 0) throw new Error('当前页面未挂载完整字幕轨。');
                if (statusEl) statusEl.innerText = `已抓取 ${cuesList.length} 句，启动智能双引擎翻译...`;
                fullResults = await batchTranslateCues(cuesList, targetLang, statusEl);
            }

            fullResults.sort((a, b) => a.sec - b.sec);
            if (window.location.hostname.includes('youtube.com')) {
                lastYouTubeOriginalCues = origList.slice().sort((a, b) => a.start - b.start);
                lastYouTubeBilingualResults = fullResults.slice();
                lastYouTubeSubtitleTitle = realTitle;
            }
            const db = getVideoNotesDB();
            db[vKey] = {
                title: realTitle,
                date: new Date().toLocaleString() + ' (全轨极速)',
                lines: fullResults
            };
            saveVideoNotesDB(db);

            restoreCurrentVideoNotes();
            alert(`⚡ 提取完毕！共完成《${realTitle.slice(0, 20)}》${fullResults.length} 句双语字幕！\n可在【历史存档查看】一键下载 TXT 或导出标准 SRT 外挂字幕！`);
        } catch (err) {
            if (streamView) {
                setSafeHTML(streamView, `
                    <div style="padding:20px;text-align:center;color:#ef4444;font-size:12px;">
                        ❌ 提取失败：${cleanHTML(err.message || '未知错误')}<br><br>
                        💡 提示：请确保视频播放器的 [CC] 按钮已点亮。
                    </div>
                `);
            }
        } finally {
            isFullExtracting = false;
            if (extractBtn) extractBtn.innerText = '⚡ 全轨抓取';
        }
    }

    async function batchTranslateCues(cuesList, targetLang, statusEl) {
        const BATCH_SIZE = 25;
        const batches = [];
        for (let i = 0; i < cuesList.length; i += BATCH_SIZE) batches.push(cuesList.slice(i, i + BATCH_SIZE));

        let finishedCount = 0;
        const tasks = batches.map((batch) => async () => {
            const combinedText = batch.map(b => b.text).join('\n\n====\n\n');
            let translatedChunk = '';
            try { translatedChunk = await fetchBilingualTranslate(combinedText, targetLang); } catch (e) {}

            const translatedLines = translatedChunk ? translatedChunk.split(/\n*====\n*/) : [];
            const chunkResults = [];

            for (let j = 0; j < batch.length; j++) {
                const item = batch[j];
                const zhText = (translatedLines[j] || item.text).trim();
                chunkResults.push({
                    en: item.text,
                    zh: zhText,
                    time: formatTime(item.start),
                    sec: Math.floor(item.start),
                    dur: item.dur
                });
            }

            finishedCount += batch.length;
            if (statusEl) statusEl.innerText = `双模智能翻译中: ${Math.min(finishedCount, cuesList.length)} / ${cuesList.length} 句...`;
            return chunkResults;
        });

        const nestedResults = await runWithConcurrency(tasks, 4);
        const finalResults = [];
        nestedResults.forEach(subList => { if (Array.isArray(subList)) finalResults.push(...subList); });
        return finalResults;
    }

    let lastRenderedEnText = '';

    function processYouTubeCaptions(targetLang) {
        if (!window.location.hostname.includes('youtube.com')) return;
        const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
        const segments = document.querySelectorAll('.ytp-caption-segment');

        let fixedSub = document.querySelector('#yt-fixed-bilingual-sub');
        if (!fixedSub && player) {
            fixedSub = document.createElement('div');
            fixedSub.id = 'yt-fixed-bilingual-sub';
            player.appendChild(fixedSub);
        }

        if (!segments || segments.length === 0) {
            if (fixedSub) fixedSub.style.display = 'none';
            return;
        }

        let rawText = '';
        segments.forEach(seg => {
            for (const node of seg.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) rawText += node.nodeValue;
            }
        });
        rawText = rawText.trim().replace(/\s+/g, ' ');
        if (!rawText) {
            if (fixedSub) fixedSub.style.display = 'none';
            return;
        }

        if (rawText === lastRenderedEnText) return;
        lastRenderedEnText = rawText;

        fetchBilingualTranslate(rawText, targetLang).then(translated => {
            if (!translated) return;
            if (fixedSub) {
                fixedSub.textContent = translated;
                fixedSub.style.display = 'block';
            }
            if (isVideoNoteRecording) {
                appendAndSaveVideoNote(rawText, translated);
            }
        }).catch(() => {});
    }

    function processTEDandUniversalTracks(targetLang) {
        if (!isVideoNoteRecording || window.location.hostname.includes('youtube.com')) return;
        const videos = document.querySelectorAll('video');
        if (!videos || videos.length === 0) return;

        videos.forEach(video => {
            if (!video.textTracks) return;
            for (let i = 0; i < video.textTracks.length; i++) {
                const track = video.textTracks[i];
                if (track.mode === 'disabled') track.mode = 'hidden';
                if (!track.__bilingual_hooked) {
                    track.__bilingual_hooked = true;
                    track.addEventListener('cuechange', function() {
                        if (!isVideoNoteRecording) return;
                        if (this.activeCues && this.activeCues.length > 0) {
                            const cueText = Array.from(this.activeCues)
                                .map(c => c.text.replace(/<[^>]*>/g, ''))
                                .join(' ')
                                .trim();
                            if (!cueText) return;
                            fetchBilingualTranslate(cueText, targetLang).then(translated => {
                                if (!translated) return;
                                appendAndSaveVideoNote(cueText, translated);
                                renderTEDOverlay(video, translated);
                            });
                        }
                    });
                }
            }
        });
    }

    function renderTEDOverlay(video, text) {
        const container = video.parentElement || video.parentNode;
        if (!container) return;

        let overlay = container.querySelector('.uni-video-sub-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'uni-video-sub-overlay';
            if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
            container.appendChild(overlay);
        }
        overlay.innerText = text;
        overlay.style.display = 'block';

        clearTimeout(overlay.__timer);
        overlay.__timer = setTimeout(() => { overlay.style.display = 'none'; }, 4000);
    }

    // ============================================================
    // 8. 统一用户界面组件（瘦身主条，仅留生词本入库）
    // ============================================================
    let isSentenceReadingEnabled = false;

    function initUI() {
        const shadow = getShadowRoot();
        if (!shadow || shadow.querySelector('#bilingual-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'bilingual-panel';

        const miniBtn = document.createElement('div');
        miniBtn.id = 'bilingual-mini-btn';
        miniBtn.innerText = '🌐';
        miniBtn.title = '打开双语翻译面板 (Alt+W)';
        shadow.appendChild(miniBtn);

        const langSelect = document.createElement('select');
        langSelect.id = 'bilingual-lang-select';
        const langOptions = [
            { v: 'zh-CN', t: '🇨🇳 中文' },
            { v: 'ja', t: '🇯🇵 日本語' },
            { v: 'es', t: '🇪🇸 西班牙语' },
            { v: 'ar', t: '🇸🇦 阿拉伯语' },
            { v: 'en', t: '🇺🇸 英语' },
            { v: 'ko', t: '🇰🇷 韩语' }
        ];
        langOptions.forEach(opt => {
            const o = document.createElement('option');
            o.value = opt.v; o.textContent = opt.t;
            langSelect.appendChild(o);
        });
        const savedLang = safeStorage('bilingual_target_lang');
        if (savedLang) langSelect.value = savedLang;
        langSelect.addEventListener('change', () => safeStorage('bilingual_target_lang', langSelect.value));

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'bilingual-toggle-btn';
        toggleBtn.innerText = '🌐 网页双语';

        const videoBtn = document.createElement('button');
        videoBtn.id = 'bilingual-video-btn';
        videoBtn.className = 'bilingual-tool-btn';
        videoBtn.textContent = '📺 视频笔记';

        const vocabBtn = document.createElement('button');
        vocabBtn.id = 'bilingual-vocab-btn';
        vocabBtn.className = 'bilingual-tool-btn';
        vocabBtn.textContent = '📖 生词本';

        const pdfBtn = document.createElement('button');
        pdfBtn.id = 'bilingual-pdf-btn';
        pdfBtn.className = 'bilingual-tool-btn';
        pdfBtn.textContent = '📄 翻译PDF';

        const minBtn = document.createElement('button');
        minBtn.className = 'bilingual-tool-btn';
        minBtn.textContent = '🗕';
        minBtn.title = '收起到小圆点';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'bilingual-tool-btn';
        closeBtn.textContent = '✕';
        closeBtn.title = '收起面板';

        panel.appendChild(langSelect);
        panel.appendChild(toggleBtn);
        panel.appendChild(videoBtn);
        panel.appendChild(vocabBtn);
        panel.appendChild(pdfBtn);
        panel.appendChild(minBtn);
        panel.appendChild(closeBtn);
        shadow.appendChild(panel);

        let isDragging = false, initialX, initialY;
        panel.addEventListener('mousedown', (e) => {
            if (['SELECT', 'BUTTON', 'INPUT'].includes(e.target.tagName)) return;
            isDragging = true;
            initialX = e.clientX - panel.offsetLeft;
            initialY = e.clientY - panel.offsetTop;
        });
        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                e.preventDefault();
                panel.style.left = `${e.clientX - initialX}px`;
                panel.style.top = `${e.clientY - initialY}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
            }
        });
        document.addEventListener('mouseup', () => { isDragging = false; });

        minBtn.addEventListener('click', () => { panel.style.display = 'none'; miniBtn.style.display = 'flex'; });
        miniBtn.addEventListener('click', () => { panel.style.display = 'flex'; miniBtn.style.display = 'none'; });
        closeBtn.addEventListener('click', () => { panel.style.display = 'none'; miniBtn.style.display = 'flex'; });

        initVideoNotesModal(shadow, videoBtn, langSelect);
        initPdfModal(shadow, pdfBtn, miniBtn, langSelect);
        initUniversalTranslatorEngine(toggleBtn, langSelect);
        initVocabSystem(shadow, vocabBtn, langSelect);

        setInterval(() => {
            syncFullscreenRoot();
            const curKey = getVideoUniqueKey();
            if (curKey && curKey !== currentWatchedVideoKey) {
                currentWatchedVideoKey = curKey;
                lastSavedSubtitleText = '';
                lastRenderedEnText = '';
                restoreCurrentVideoNotes();
            }
            try { processYouTubeCaptions(langSelect.value); } catch(e) {}
            try { processTEDandUniversalTracks(langSelect.value); } catch(e) {}
        }, 150);
    }

    function downloadTextFile(filename, content) {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    function buildOriginalSubtitleText(cues) {
        return cues.map(c => `[${formatTime(c.start)}] ${c.text}`).join('\n\n');
    }

    function buildBilingualSubtitleText(lines) {
        return lines.map(l => {
            const time = l.time ? `[${l.time}] ` : '';
            return `${time}${l.en}\n${time}${l.zh}`;
        }).join('\n\n');
    }

    function initVideoNotesModal(shadow, videoBtn, langSelect) {
        const videoPanel = document.createElement('div');
        videoPanel.id = 'bilingual-video-panel';
        setSafeHTML(videoPanel, `
            <div id="uni-note-header">
                <div class="unote-title">🎬 视频双语字幕笔记</div>
                <div class="unote-ctrls">
                    <button id="unote-full-extract-btn" title="直接完整抓取整部视频的全轨字幕并翻译为双语">⚡ 全轨抓取</button>
                    <button id="unote-download-original" title="下载最近一次抓取的原文字幕">⬇️ 原文</button>
                    <button id="unote-download-bilingual" title="下载最近一次抓取的双语字幕">⬇️ 双语</button>
                    <button id="unote-toggle-record" style="background:#2563eb; color:#ffffff; font-weight:bold; padding:3px 8px; border-radius:6px; border:none; cursor:pointer; font-size:12px; transition:all 0.2s;">▶️ 实时记录</button>
                    <button id="unote-clear-cur" title="清空当前视频记录">🗑️</button>
                    <button id="unote-close-btn" title="隐藏面板">✕</button>
                </div>
            </div>
            <div id="uni-note-tabs">
                <div id="tab-live" class="unote-tab active">📺 字幕工作台</div>
                <div id="tab-archive" class="unote-tab">📚 历史存档查看</div>
            </div>
            <div id="uni-note-stream">
                <div style="font-size:12px;color:#94a3b8;text-align:center;padding-top:40px;">
                    ⏸️ 记录已暂停<br><br>
                    💡 点击 <b>【⚡ 全轨抓取】</b> 瞬间导出整部视频全篇双语字幕<br>
                    或点击 <b>【▶️ 实时记录】</b> 边看边录<br>
                    （点击字幕行可自动跳到对应播放进度）
                </div>
            </div>
            <div id="uni-note-history"></div>
        `);
        shadow.appendChild(videoPanel);

        const header = videoPanel.querySelector('#uni-note-header');
        const btnClose = videoPanel.querySelector('#unote-close-btn');
        const btnClear = videoPanel.querySelector('#unote-clear-cur');
        const btnRecord = videoPanel.querySelector('#unote-toggle-record');
        const btnDownloadOriginal = videoPanel.querySelector('#unote-download-original');
        const btnDownloadBilingual = videoPanel.querySelector('#unote-download-bilingual');

        if (btnDownloadOriginal) btnDownloadOriginal.addEventListener('click', () => {
            if (!lastYouTubeOriginalCues.length) { alert('请先在 YouTube 点击【⚡ 全轨抓取】成功获取字幕。'); return; }
            downloadTextFile(`[原文字幕] ${lastYouTubeSubtitleTitle.slice(0, 40)}.txt`, buildOriginalSubtitleText(lastYouTubeOriginalCues));
        });
        if (btnDownloadBilingual) btnDownloadBilingual.addEventListener('click', () => {
            if (!lastYouTubeBilingualResults.length) { alert('请先在 YouTube 点击【⚡ 全轨抓取】成功生成双语字幕。'); return; }
            downloadTextFile(`[双语字幕] ${lastYouTubeSubtitleTitle.slice(0, 40)}.txt`, buildBilingualSubtitleText(lastYouTubeBilingualResults));
        });
        const btnFullExtract = videoPanel.querySelector('#unote-full-extract-btn');
        const tabLive = videoPanel.querySelector('#tab-live');
        const tabArchive = videoPanel.querySelector('#tab-archive');
        const viewStream = videoPanel.querySelector('#uni-note-stream');
        const viewHist = videoPanel.querySelector('#uni-note-history');

        if (btnFullExtract) btnFullExtract.addEventListener('click', () => {
            tabLive.click();
            extractFullVideoSubtitles(langSelect.value);
        });

        if (btnRecord) btnRecord.addEventListener('click', () => {
            isVideoNoteRecording = !isVideoNoteRecording;
            if (isVideoNoteRecording) {
                btnRecord.innerText = '🔴 录制中...';
                btnRecord.style.background = '#dc2626';
                if (viewStream && (viewStream.textContent.includes('记录已暂停') || viewStream.textContent.includes('点击'))) {
                    setSafeHTML(viewStream, '<div style="font-size:12px;color:#16a34a;text-align:center;padding-top:20px;">🟢 已开始监听视频字幕，正在实时记录...</div>');
                }
            } else {
                btnRecord.innerText = '▶️ 实时记录';
                btnRecord.style.background = '#2563eb';
            }
        });

        let isDrag = false, startX = 0, startY = 0;
        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDrag = true;
            const rect = videoPanel.getBoundingClientRect();
            startX = e.clientX - rect.left;
            startY = e.clientY - rect.top;
            videoPanel.style.left = `${rect.left}px`;
            videoPanel.style.top = `${rect.top}px`;
            videoPanel.style.right = 'auto';
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDrag) return;
            e.preventDefault();
            videoPanel.style.left = `${e.clientX - startX}px`;
            videoPanel.style.top = `${e.clientY - startY}px`;
            videoPanel.style.right = 'auto';
            videoPanel.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => { isDrag = false; });

        videoBtn.addEventListener('click', () => {
            const isOpen = videoPanel.style.display === 'flex';
            if (isOpen) {
                videoPanel.style.display = 'none';
            } else {
                videoPanel.style.display = 'flex';
                renderVideoHistoryUI();
                restoreCurrentVideoNotes();
            }
        });

        btnClose.addEventListener('click', () => { videoPanel.style.display = 'none'; });

        btnClear.addEventListener('click', () => {
            const vKey = getVideoUniqueKey();
            if (confirm('清空当前视频的笔记记录？')) {
                const db = getVideoNotesDB();
                if (db[vKey]) delete db[vKey];
                saveVideoNotesDB(db);
                if (viewStream) setSafeHTML(viewStream, '<div style="font-size:12px;color:#94a3b8;text-align:center;padding-top:40px;">已清空，等待新记录...</div>');
            }
        });

        tabLive.addEventListener('click', () => {
            tabLive.classList.add('active');
            tabArchive.classList.remove('active');
            viewStream.style.display = 'flex';
            viewHist.style.display = 'none';
        });

        tabArchive.addEventListener('click', () => {
            tabArchive.classList.add('active');
            tabLive.classList.remove('active');
            viewHist.style.display = 'flex';
            viewStream.style.display = 'none';
            renderVideoHistoryUI();
        });
    }

    // ============================================================
    // Alt + W 智能双向开关
    // ============================================================
    window.addEventListener('keydown', (e) => {
        if (e.altKey && (e.key === 'w' || e.key === 'W')) {
            const shadow = getShadowRoot();
            if (!shadow) return;

            const panel = shadow.querySelector('#bilingual-panel');
            const mini = shadow.querySelector('#bilingual-mini-btn');
            const videoPanel = shadow.querySelector('#bilingual-video-panel');
            const pdfModal = shadow.querySelector('#bilingual-pdf-modal');
            const vocabModal = shadow.querySelector('#bilingual-vocab-modal');

            const isAnyOpen = (panel && panel.style.display === 'flex') ||
                              (videoPanel && videoPanel.style.display === 'flex') ||
                              (pdfModal && pdfModal.style.display === 'flex') ||
                              (vocabModal && vocabModal.style.display === 'flex');

            if (isAnyOpen) {
                if (panel) panel.style.display = 'none';
                if (videoPanel) videoPanel.style.display = 'none';
                if (pdfModal) pdfModal.style.display = 'none';
                if (vocabModal) vocabModal.style.display = 'none';
                if (mini) mini.style.display = 'flex';
            } else {
                if (panel) {
                    panel.style.display = 'flex';
                    panel.style.right = '30px'; panel.style.bottom = '30px';
                    panel.style.left = 'auto'; panel.style.top = 'auto';
                }
                if (mini) mini.style.display = 'none';
                if (document.querySelector('video') && videoPanel) {
                    videoPanel.style.display = 'flex';
                    restoreCurrentVideoNotes();
                }
            }
        }
    });

    // ============================================================
    // 9. PDF 与 Gemini 伴读模块
    // ============================================================
    function initPdfModal(shadow, pdfBtn, miniBtn, langSelect) {
        let currentFontSize = 16;
        let currentQuotedText = '';
        let currentAttachedImage = null;
        let geminiBusy = false;

        const modal = document.createElement('div');
        modal.id = 'bilingual-pdf-modal';
        setSafeHTML(modal, `
            <div id="bilingual-pdf-container">
                <div id="bilingual-pdf-header">
                    <div class="pdf-header-left">
                        <button id="pdf-sidebar-toggle" class="pdf-win-btn">📑 侧边栏</button>
                        <span style="font-weight:bold; font-size:14px; color:#0f172a;">PDF 图文学术工作台</span>
                        <button id="pdf-choose-btn" style="padding:4px 9px; font-size:12px; background:#e2e8f0; border:none; border-radius:6px; cursor:pointer;">📁 打开本地</button>
                        <input type="file" id="pdf-file-input" accept="application/pdf" style="display:none;" />
                        <input type="text" id="pdf-url-input" placeholder="粘贴在线 PDF 链接..." />
                        <button id="pdf-fetch-btn" style="padding:4px 9px; font-size:12px; background:#2563eb; color:#fff; border:none; border-radius:6px; cursor:pointer;">解析</button>
                        <span id="pdf-status" style="font-size:12px; color:#64748b;">就绪</span>
                    </div>
                    <div class="pdf-header-right">
                        <button id="pdf-font-dec" class="pdf-win-btn">A-</button>
                        <button id="pdf-font-inc" class="pdf-win-btn">A+</button>
                        <button id="pdf-minimize-btn" class="pdf-win-btn">🗕</button>
                        <button id="pdf-fullscreen-btn" class="pdf-win-btn">⛶</button>
                        <button id="pdf-close-btn" class="pdf-win-btn" style="font-weight:bold; color:#ef4444;">✕</button>
                    </div>
                </div>
                <div id="bilingual-pdf-main-area">
                    <div id="pdf-sidebar">
                        <div id="pdf-sidebar-tabs">
                            <button id="tab-history" class="sidebar-tab-btn active">📚 历史</button>
                            <button id="tab-gemini" class="sidebar-tab-btn">✨ Ask Gemini</button>
                        </div>
                        <div id="pdf-history-view">
                            <div style="padding:8px 12px; font-size:12px; display:flex; justify-content:space-between; border-bottom:1px solid #e2e8f0;">
                                <span style="color:#64748b;">书架（永久本地存储）</span>
                                <button id="pdf-clear-history" style="border:none; background:none; color:#ef4444; font-size:11px; cursor:pointer;">清空</button>
                            </div>
                            <div id="pdf-history-list"></div>
                        </div>
                        <div id="gemini-chat-view">
                            <div style="padding:6px 12px; font-size:11px; background:#f1f5f9; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
                                <span id="gemini-model-badge" style="color:#475569; font-weight:bold;">✨ 模型: gemini-3.7-flash</span>
                                <button id="gemini-set-key" style="border:none; background:none; color:#2563eb; cursor:pointer; font-size:11px; font-weight:bold;">⚙️ 设置</button>
                            </div>
                            <div id="gemini-msg-container">
                                <div class="gemini-msg ai">👋 你好！我是多模态伴读助手，支持公式和图片解析！</div>
                            </div>
                            <div id="gemini-input-area">
                                <div id="gemini-attach-preview">
                                    <img id="gemini-attach-thumb" src="" />
                                    <span id="gemini-attach-name">截图</span>
                                    <button id="gemini-remove-img">✕</button>
                                </div>
                                <div id="gemini-quote-preview"></div>
                                <textarea id="gemini-input-box" placeholder="提问或 Ctrl+V 粘贴截图..."></textarea>
                                <div class="gemini-tool-row">
                                    <div style="display:flex; gap:4px;">
                                        <button id="gemini-quote-btn" class="gemini-quote-btn">📌 引用</button>
                                        <button id="gemini-img-btn" class="gemini-quote-btn">🖼️ 图片</button>
                                        <input type="file" id="gemini-img-input" accept="image/*" style="display:none;" />
                                    </div>
                                    <button id="gemini-send-btn" class="gemini-btn">发送 🚀</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div id="bilingual-pdf-body">
                        <div style="text-align:center; padding:80px 0; color:#94a3b8;">可输入在线 PDF 或打开本地文件进行逐段双语对照。</div>
                    </div>
                </div>
            </div>
        `);
        shadow.appendChild(modal);

        const pdfContainer = modal.querySelector('#bilingual-pdf-container');
        const sidebar = modal.querySelector('#pdf-sidebar');
        const sidebarToggle = modal.querySelector('#pdf-sidebar-toggle');
        const tabHistory = modal.querySelector('#tab-history');
        const tabGemini = modal.querySelector('#tab-gemini');
        const historyView = modal.querySelector('#pdf-history-view');
        const geminiView = modal.querySelector('#gemini-chat-view');
        const historyListEl = modal.querySelector('#pdf-history-list');
        const clearHistoryBtn = modal.querySelector('#pdf-clear-history');
        const fileInput = modal.querySelector('#pdf-file-input');
        const chooseBtn = modal.querySelector('#pdf-choose-btn');
        const urlInput = modal.querySelector('#pdf-url-input');
        const fetchBtn = modal.querySelector('#pdf-fetch-btn');
        const statusText = modal.querySelector('#pdf-status');
        const pdfBody = modal.querySelector('#bilingual-pdf-body');
        const modalClose = modal.querySelector('#pdf-close-btn');
        const modalMin = modal.querySelector('#pdf-minimize-btn');
        const modalFullscreen = modal.querySelector('#pdf-fullscreen-btn');
        const fontInc = modal.querySelector('#pdf-font-inc');
        const fontDec = modal.querySelector('#pdf-font-dec');

        const geminiMsgBox = modal.querySelector('#gemini-msg-container');
        const geminiInput = modal.querySelector('#gemini-input-box');
        const geminiSend = modal.querySelector('#gemini-send-btn');
        const geminiQuoteBtn = modal.querySelector('#gemini-quote-btn');
        const geminiQuotePreview = modal.querySelector('#gemini-quote-preview');
        const geminiSetKey = modal.querySelector('#gemini-set-key');
        const geminiModelBadge = modal.querySelector('#gemini-model-badge');

        const geminiImgBtn = modal.querySelector('#gemini-img-btn');
        const geminiImgInput = modal.querySelector('#gemini-img-input');
        const geminiAttachPreview = modal.querySelector('#gemini-attach-preview');
        const geminiAttachThumb = modal.querySelector('#gemini-attach-thumb');
        const geminiRemoveImg = modal.querySelector('#gemini-remove-img');

        const FALLBACK_MODELS = [
            'gemini-3.7-flash',
            'gemini-3.8-flash',
            'gemini-3.6-flash',
            'gemini-3.1-pro-preview',
            'gemini-3.5-flash-lite',
            'gemini-2.5-flash',
            'gemini-1.5-flash'
        ];

        function getSelectedModel() {
            let m = safeStorage('bilingual_gemini_custom_model') || 'gemini-3.7-flash';
            let cleaned = m.trim().replace(/^models\//, '').replace(/[^a-zA-Z0-9._-]/g, '');
            return cleaned || 'gemini-3.7-flash';
        }

        function isModelBusyError(status, errMsg) {
            if (status === 429 || status === 503 || status === 500) return true;
            const msg = (errMsg || '').toLowerCase();
            return msg.includes('high demand') || msg.includes('overloaded') || msg.includes('resource exhausted') || msg.includes('quota') || msg.includes('temporarily unavailable');
        }

        function doGeminiRequest(modelName, key, postData, timeoutMs = 25000) {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: "POST",
                    url: `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
                    headers: {
                        "Content-Type": "application/json",
                        "x-goog-api-key": key
                    },
                    data: JSON.stringify(postData),
                    timeout: timeoutMs,
                    onload: (res) => {
                        try {
                            const data = JSON.parse(res.responseText);
                            if (res.status >= 200 && res.status < 300 && data.candidates?.[0]?.content?.parts?.[0]?.text) {
                                resolve({ success: true, text: data.candidates[0].content.parts[0].text, model: modelName });
                            } else {
                                const errMsg = data.error?.message || `HTTP ${res.status}`;
                                resolve({ success: false, busy: isModelBusyError(res.status, errMsg), error: errMsg, model: modelName });
                            }
                        } catch (e) {
                            resolve({ success: false, busy: isModelBusyError(res.status, res.responseText), error: '解析异常', model: modelName });
                        }
                    },
                    onerror: () => resolve({ success: false, busy: false, error: '网络错误', model: modelName }),
                    ontimeout: () => resolve({ success: false, busy: true, error: '请求超时', model: modelName })
                });
            });
        }

        pdfBtn.addEventListener('click', () => { modal.style.display = 'flex'; renderPdfHistorySidebar(); });
        modalClose.addEventListener('click', () => { modal.style.display = 'none'; });
        chooseBtn.addEventListener('click', () => { fileInput.click(); });
        sidebarToggle.addEventListener('click', () => { sidebar.classList.toggle('collapsed'); });

        tabHistory.addEventListener('click', () => {
            tabHistory.classList.add('active'); tabGemini.classList.remove('active');
            historyView.style.display = 'flex'; geminiView.style.display = 'none';
        });
        tabGemini.addEventListener('click', () => {
            tabGemini.classList.add('active'); tabHistory.classList.remove('active');
            geminiView.style.display = 'flex'; historyView.style.display = 'none';
        });

        modalMin.addEventListener('click', () => { modal.style.display = 'none'; miniBtn.style.display = 'flex'; });
        modalFullscreen.addEventListener('click', () => {
            pdfContainer.classList.toggle('fullscreen');
            modalFullscreen.innerText = pdfContainer.classList.contains('fullscreen') ? '❐' : '⛶';
        });

        fontInc.addEventListener('click', () => { currentFontSize = Math.min(currentFontSize + 2, 28); pdfBody.style.setProperty('--pdf-font-size', `${currentFontSize}px`); });
        fontDec.addEventListener('click', () => { currentFontSize = Math.max(currentFontSize - 2, 12); pdfBody.style.setProperty('--pdf-font-size', `${currentFontSize}px`); });

        geminiSetKey.addEventListener('click', () => {
            const curKey = safeStorage('bilingual_gemini_api_key');
            const curModel = getSelectedModel();
            const inputKey = prompt('请输入 Gemini API Key:', curKey);
            if (inputKey === null) return;
            safeStorage('bilingual_gemini_api_key', inputKey.trim());
            const inputModel = prompt('请输入模型 (如: gemini-3.7-flash):', curModel);
            if (inputModel !== null) {
                const cleanModel = inputModel.trim() || 'gemini-3.7-flash';
                safeStorage('bilingual_gemini_custom_model', cleanModel);
                geminiModelBadge.innerText = `✨ 模型: ${cleanModel}`;
            }
        });

        geminiQuoteBtn.addEventListener('click', () => {
            const selection = window.getSelection().toString().trim();
            if (!selection) return alert('请先选中文本！');
            currentQuotedText = selection;
            geminiQuotePreview.style.display = 'block';
            geminiQuotePreview.innerText = `📌 引用: "${selection.slice(0, 45)}..."`;
            geminiInput.focus();
        });

        function processImageFile(file) {
            if (!file || !file.type.startsWith('image/')) return alert('仅支持上传图片文件');
            if (file.size > 10 * 1024 * 1024) return alert('图片文件过大，请选择 10MB 以内的图片');
            const reader = new FileReader();
            reader.onload = function(e) {
                currentAttachedImage = { mimeType: file.type || 'image/png', base64: e.target.result.split(',')[1], dataUrl: e.target.result };
                geminiAttachThumb.src = e.target.result;
                geminiAttachPreview.style.display = 'flex';
            };
            reader.readAsDataURL(file);
        }

        geminiInput.addEventListener('paste', (e) => {
            const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.indexOf('image') !== -1) {
                    processImageFile(item.getAsFile());
                    e.preventDefault();
                    break;
                }
            }
        });
        geminiImgBtn.addEventListener('click', () => { geminiImgInput.click(); });
        geminiImgInput.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) processImageFile(e.target.files[0]);
        });
        geminiRemoveImg.addEventListener('click', () => {
            currentAttachedImage = null; geminiAttachPreview.style.display = 'none'; geminiImgInput.value = '';
        });

        function appendGeminiMessage(text, role, imgSrc = null) {
            const msg = document.createElement('div');
            msg.className = `gemini-msg ${role}`;
            if (role === 'ai') {
                setSafeHTML(msg, renderSimpleMarkdown(text));
            } else {
                msg.textContent = text;
            }
            if (imgSrc) {
                const img = document.createElement('img');
                img.src = imgSrc; img.className = 'gemini-msg-img';
                msg.appendChild(img);
            }
            geminiMsgBox.appendChild(msg);
            geminiMsgBox.scrollTop = geminiMsgBox.scrollHeight;
            return msg;
        }

        async function sendToGemini() {
            if (geminiBusy) return;
            const key = safeStorage('bilingual_gemini_api_key');
            if (!key) return alert('请先配置 API Key！');
            const query = geminiInput.value.trim();
            if (!query && !currentQuotedText && !currentAttachedImage) return;

            geminiBusy = true;
            try {
                let fullPrompt = query;
                if (currentQuotedText) fullPrompt = `【引用内容】：\n"${currentQuotedText}"\n\n【我的问题】：\n${query || '请解释'}`;

                const attachedImgCopy = currentAttachedImage;
                appendGeminiMessage(query || '请分析', 'user', attachedImgCopy ? attachedImgCopy.dataUrl : null);

                geminiInput.value = ''; currentQuotedText = ''; currentAttachedImage = null;
                geminiQuotePreview.style.display = 'none'; geminiAttachPreview.style.display = 'none';

                const aiMsgDiv = appendGeminiMessage('🤔 分析中...', 'ai');

                const parts = [{ text: `你是一名学术伴读导师，请用中文解答，排版清晰：\n\n${fullPrompt}` }];
                if (attachedImgCopy) parts.push({ inline_data: { mime_type: attachedImgCopy.mimeType, data: attachedImgCopy.base64 } });
                const postPayload = { contents: [{ parts }] };

                const currentModel = getSelectedModel();
                const modelQueue = [currentModel, ...FALLBACK_MODELS.filter(m => m !== currentModel)];

                let lastError = '未知错误';
                let finalSuccess = false;

                for (let i = 0; i < modelQueue.length; i++) {
                    const tryModel = modelQueue[i];
                    aiMsgDiv.innerText = i === 0 ? `🤔 [${tryModel}] 分析中...` : `⏳ 备用模型 [${tryModel}] 响应中...`;

                    const result = await doGeminiRequest(tryModel, key, postPayload);

                    if (result.success) {
                        const switchNotice = i > 0 ? `💡 (原模型高峰拥堵，已自动切换至 ${tryModel})\n\n` : '';
                        setSafeHTML(aiMsgDiv, renderSimpleMarkdown(switchNotice + result.text));
                        finalSuccess = true;
                        break;
                    } else {
                        lastError = result.error;
                        if (result.busy && i < modelQueue.length - 1) {
                            const nextModel = modelQueue[i + 1];
                            aiMsgDiv.innerText = `⚠️ [${tryModel}] 遇到并发拥堵/超时，正在切换至备用模型 [${nextModel}]...`;
                            await new Promise(r => setTimeout(r, 600));
                            continue;
                        } else if (!result.busy) {
                            break;
                        }
                    }
                }

                if (!finalSuccess) aiMsgDiv.innerText = `❌ 解析失败: ${lastError}`;
            } catch (err) {} finally {
                geminiBusy = false;
            }
        }
        geminiSend.addEventListener('click', sendToGemini);
        geminiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendToGemini(); } });

        function getPdfHistory() { try { return JSON.parse(safeStorage('bilingual_pdf_history') || '[]'); } catch(e) { return []; } }
        function savePdfHistoryItem(item) {
            let list = getPdfHistory().filter(i => (item.type === 'online' ? i.url !== item.url : i.id !== item.id));
            list.unshift(item);
            safeStorage('bilingual_pdf_history', JSON.stringify(list.slice(0, 30)));
            renderPdfHistorySidebar();
        }

        function renderPdfHistorySidebar() {
            const list = getPdfHistory();
            setSafeHTML(historyListEl, list.length === 0 ? '<div style="text-align:center; color:#94a3b8; padding:20px 0; font-size:12px;">暂无历史</div>' : '');
            list.forEach(item => {
                const row = document.createElement('div');
                row.className = 'history-item';
                const isLocal = item.type === 'local';
                setSafeHTML(row, `<span class="history-badge ${isLocal ? 'local' : 'online'}">${isLocal ? '本地' : '离线'}</span><span class="history-title"></span><button class="history-del-btn">🗑️</button>`);
                row.querySelector('.history-title').textContent = item.title;

                row.addEventListener('click', async () => {
                    statusText.innerText = '从永久存储调取中...';
                    const buf = await getPermanentPdf(item.id);
                    if (buf) {
                        renderPdfData(new Uint8Array(buf), item.title);
                    } else if (!isLocal && item.url) {
                        urlInput.value = item.url;
                        fetchAndRenderOnlinePdf(item.url, item.title);
                    } else {
                        alert('❌ 该文档缓存已被清理，无法离线打开');
                        statusText.innerText = '文件丢失';
                    }
                });

                row.querySelector('.history-del-btn').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await deletePermanentPdf(item.id);
                    savePdfHistoryItem(getPdfHistory().filter(i => i.id !== item.id));
                    renderPdfHistorySidebar();
                });
                historyListEl.appendChild(row);
            });
        }

        clearHistoryBtn.addEventListener('click', async () => {
            if (confirm('确定清空所有历史文档和永久存储？')) {
                const list = getPdfHistory();
                for (const item of list) await deletePermanentPdf(item.id);
                safeStorage('bilingual_pdf_history', '[]');
                renderPdfHistorySidebar();
            }
        });

        async function renderPdfData(typedarray, title = 'PDF') {
            statusText.innerText = `正在启动引擎...`;
            pdfBody.textContent = '';

            if (!isPdfMagicBytes(typedarray)) {
                statusText.innerText = '❌ 非有效 PDF（魔数校验未通过）';
                return;
            }

            try {
                const pdfLib = await ensurePdfJsLoaded((msg) => { statusText.innerText = msg; });
                statusText.innerText = `正在解析 ${title}...`;

                const pdf = await pdfLib.getDocument({
                    data: typedarray,
                    isEvalSupported: false,
                    enableScripting: false
                }).promise;
                const targetLang = langSelect.value;

                for (let i = 1; i <= pdf.numPages; i++) {
                    statusText.innerText = `正在渲染第 ${i}/${pdf.numPages} 页...`;
                    const page = await pdf.getPage(i);
                    const card = document.createElement('div');
                    card.className = 'pdf-page-card';
                    const cardTitle = document.createElement('div');
                    cardTitle.className = 'pdf-page-title';
                    cardTitle.textContent = `第 ${i} / ${pdf.numPages} 页`;
                    card.appendChild(cardTitle);

                    const viewport = page.getViewport({ scale: 1.5 });
                    const canvasBox = document.createElement('div');
                    canvasBox.className = 'pdf-canvas-container';
                    const canvas = document.createElement('canvas');
                    canvas.className = 'pdf-page-canvas';
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    canvasBox.appendChild(canvas);
                    card.appendChild(canvasBox);
                    pdfBody.appendChild(card);

                    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

                    const textContent = await page.getTextContent();
                    let pageText = textContent.items.map(it => it.str).join(' ');
                    const paras = pageText.split(/\.\s{2,}|\n\n/).filter(p => p.trim().length > 10);

                    const translateTasks = [];
                    for (const para of paras) {
                        const block = document.createElement('div');
                        block.className = 'pdf-block';
                        const originDiv = document.createElement('div');
                        originDiv.className = 'pdf-origin';
                        originDiv.textContent = para;
                        const transDiv = document.createElement('div');
                        transDiv.className = 'pdf-trans';
                        transDiv.textContent = '⏳ 排队翻译中...';
                        block.appendChild(originDiv);
                        block.appendChild(transDiv);
                        card.appendChild(block);

                        translateTasks.push(async () => {
                            transDiv.textContent = '⏳ 正在翻译...';
                            try {
                                const t = await fetchBilingualTranslate(para, targetLang);
                                transDiv.innerText = t || '（翻译未返回结果）';
                            } catch (e) {
                                transDiv.innerText = '❌ 翻译出错';
                            }
                        });
                    }
                    runWithConcurrency(translateTasks, 3);
                }
                statusText.innerText = `加载完成 (共 ${pdf.numPages} 页)`;
            } catch(e) {
                statusText.innerText = '❌ 解析失败：' + (e?.message || '文件损坏');
            }
        }

        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const isPdf = (file.type && file.type === 'application/pdf') || file.name.toLowerCase().endsWith('.pdf');
            if (!isPdf) return alert('请选择有效的 PDF 文件 (.pdf)');

            const safeTitle = normalizeHistoryTitle(file.name);
            statusText.innerText = '固化入永久存储中...';

            const reader = new FileReader();
            reader.onload = async function() {
                const uint8 = new Uint8Array(this.result);
                if (!isPdfMagicBytes(uint8)) {
                    alert('所选文件非合法的 PDF 格式');
                    statusText.innerText = '❌ 非有效 PDF';
                    return;
                }
                const fileId = 'pdf_' + Date.now();
                await savePermanentPdf(fileId, this.result);
                savePdfHistoryItem({ id: fileId, type: 'local', title: safeTitle });
                renderPdfData(uint8, safeTitle);
            };
            reader.readAsArrayBuffer(file);
        });

        function fetchAndRenderOnlinePdf(url, title = '在线文档') {
            const trimmedUrl = (url || '').trim();
            if (!trimmedUrl) return;

            if (!isSafeOnlinePdfUrl(trimmedUrl)) {
                statusText.innerText = '❌ 拒绝加载：URL 含有不安全主机或内网地址';
                return;
            }

            statusText.innerText = '下载并固化中...';
            const safeTitle = normalizeHistoryTitle(title);

            GM_xmlhttpRequest({
                method: "GET",
                url: trimmedUrl,
                responseType: "arraybuffer",
                timeout: 30000,
                onload: async (res) => {
                    if (res.status < 200 || res.status >= 300) {
                        statusText.innerText = `❌ 下载失败 (HTTP ${res.status})`;
                        return;
                    }
                    const uint8 = new Uint8Array(res.response);
                    if (!isPdfMagicBytes(uint8)) {
                        statusText.innerText = '❌ 响应内容非有效 PDF';
                        return;
                    }
                    const fileId = 'pdf_' + Date.now();
                    await savePermanentPdf(fileId, res.response);
                    savePdfHistoryItem({ id: fileId, type: 'online', title: safeTitle, url: trimmedUrl });
                    renderPdfData(uint8, safeTitle);
                },
                onerror: () => { statusText.innerText = '❌ 网络请求错误'; },
                ontimeout: () => { statusText.innerText = '❌ 下载超时'; }
            });
        }
        fetchBtn.addEventListener('click', () => fetchAndRenderOnlinePdf(urlInput.value.trim()));
    }

    // ============================================================
    // 10. 生词本与长句精听伴读系统（一体化高维重构）
    // ============================================================
    function initVocabSystem(shadow, vocabBtn, langSelect) {
        // 读取长句读译开关状态
        isSentenceReadingEnabled = safeStorage('bilingual_sentence_reading_on') === 'true';

        // 浮层气泡卡片
        const popover = document.createElement('div');
        popover.id = 'bilingual-vocab-popover';
        setSafeHTML(popover, `
            <div class="vpop-header">
                <div class="vpop-word-wrap">
                    <button class="vpop-audio-btn" title="朗读/停止">🔊</button>
                    <div>
                        <div class="vpop-word"></div>
                        <div class="vpop-phonetic"></div>
                    </div>
                </div>
            </div>
            <div class="vpop-trans">⏳ 正在解析...</div>
            <div class="vpop-actions">
                <button class="vpop-btn learned">关闭</button>
                <button class="vpop-btn learn">⭐ 存生词本</button>
            </div>
        `);
        shadow.appendChild(popover);

        const wordEl = popover.querySelector('.vpop-word');
        const phoneticEl = popover.querySelector('.vpop-phonetic');
        const transEl = popover.querySelector('.vpop-trans');
        const audioBtn = popover.querySelector('.vpop-audio-btn');
        const learnBtn = popover.querySelector('.vpop-btn.learn');
        const learnedBtn = popover.querySelector('.vpop-btn.learned');

        let currentActiveText = '';
        let currentActiveTrans = '';
        let isSpeaking = false;
        let isCurrentSentence = false;

        function stopSpeaking() {
            window.speechSynthesis.cancel();
            isSpeaking = false;
            audioBtn.innerText = '🔊';
            audioBtn.classList.remove('playing');
        }

        audioBtn.addEventListener('click', () => {
            if (!currentActiveText) return;
            if (isSpeaking) {
                stopSpeaking();
                return;
            }
            window.speechSynthesis.cancel();
            const utter = new SpeechSynthesisUtterance(currentActiveText);
            utter.rate = isCurrentSentence ? 1.0 : 0.9;
            utter.onend = () => {
                isSpeaking = false;
                audioBtn.innerText = '🔊';
                audioBtn.classList.remove('playing');
            };
            utter.onerror = () => {
                isSpeaking = false;
                audioBtn.innerText = '🔊';
                audioBtn.classList.remove('playing');
            };
            isSpeaking = true;
            audioBtn.innerText = '⏹️';
            audioBtn.classList.add('playing');
            window.speechSynthesis.speak(utter);
        });

        function getVocabDB() {
            try { return JSON.parse(safeStorage('bilingual_vocab_db') || '[]'); } catch(e) { return []; }
        }
        function saveVocabDB(list) {
            safeStorage('bilingual_vocab_db', JSON.stringify(list));
        }

        learnBtn.addEventListener('click', () => {
            if (!currentActiveText) return;
            let list = getVocabDB();
            if (!list.some(v => v.word.toLowerCase() === currentActiveText.toLowerCase())) {
                list.unshift({
                    word: currentActiveText,
                    trans: currentActiveTrans || '（未获取释义）',
                    type: isCurrentSentence ? 'sentence' : 'word',
                    date: new Date().toLocaleDateString()
                });
                saveVocabDB(list);
            }
            learnBtn.innerText = '✅ 已存入';
            learnBtn.classList.add('saved');
            renderVocabModal();
        });

        learnedBtn.addEventListener('click', () => {
            stopSpeaking();
            popover.style.display = 'none';
        });

        document.addEventListener('mouseup', async (e) => {
            if (e.target && e.target.closest && e.target.closest('#bilingual-shadow-host')) return;

            const selection = window.getSelection();
            const text = selection ? selection.toString().trim() : '';

            if (!text || text.length < 2) {
                stopSpeaking();
                popover.style.display = 'none';
                return;
            }

            const isLongSentence = text.length > 35 || /[.?!;；。\n]/.test(text) || text.split(/\s+/).length > 5;
            isCurrentSentence = isLongSentence;

            // 长句若未开启开关，则完全静默，避免打扰日常浏览
            if (isLongSentence && !isSentenceReadingEnabled) {
                popover.style.display = 'none';
                stopSpeaking();
                return;
            }

            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;

            currentActiveText = text;
            stopSpeaking();

            if (isLongSentence) {
                popover.classList.add('sentence-mode');
                wordEl.textContent = text.slice(0, 90) + (text.length > 90 ? '...' : '');
                setSafeHTML(phoneticEl, `<span class="vpop-music-tag">🎵 长句精听</span> <span>共 ${text.length} 字符</span>`);
                learnBtn.innerText = '⭐ 存入长句';
            } else {
                popover.classList.remove('sentence-mode');
                wordEl.textContent = text;
                phoneticEl.textContent = `[ ${text.toLowerCase()} ]`;
                learnBtn.innerText = '⭐ 存生词本';
            }

            learnBtn.classList.remove('saved');
            const db = getVocabDB();
            if (db.some(v => v.word.toLowerCase() === text.toLowerCase())) {
                learnBtn.innerText = '✅ 已收录';
                learnBtn.classList.add('saved');
            }

            transEl.textContent = '⏳ 正在翻译解析...';

            popover.style.left = `${rect.left + rect.width / 2}px`;
            popover.style.top = `${rect.top + window.scrollY}px`;
            popover.style.display = 'block';

            // 短词默认读一次，长句需手动点播放
            if (!isLongSentence) {
                try {
                    const utter = new SpeechSynthesisUtterance(text);
                    utter.rate = 1.0;
                    window.speechSynthesis.speak(utter);
                } catch(e) {}
            }

            const targetLang = langSelect.value;
            const translated = await fetchBilingualTranslate(text, targetLang);
            currentActiveTrans = translated;
            transEl.textContent = translated || '未匹配到译文';
        });

        // 生词本管理模态框 (集成长句开关与重复循环听)
        const vocabModal = document.createElement('div');
        vocabModal.id = 'bilingual-vocab-modal';
        setSafeHTML(vocabModal, `
            <div class="vmodal-head">
                <span class="vmodal-title">📖 我的专属生词/长句本</span>
                <div style="display:flex;gap:4px;">
                    <button id="vmodal-export-btn" style="background:#2563eb;color:#fff;border:none;padding:3px 8px;border-radius:6px;font-size:11px;cursor:pointer;font-weight:bold;">导出TXT</button>
                    <button id="vmodal-close-btn" style="border:none;background:none;color:#64748b;font-size:14px;cursor:pointer;">✕</button>
                </div>
            </div>
            <div class="vmodal-subhead">
                <span style="color:#475569;font-weight:bold;">划选设置：</span>
                <button id="vmodal-toggle-sentence">🔇 长句读译(关)</button>
            </div>
            <div id="vmodal-list-box" class="vmodal-list"></div>
        `);
        shadow.appendChild(vocabModal);

        const vlistBox = vocabModal.querySelector('#vmodal-list-box');
        const vClose = vocabModal.querySelector('#vmodal-close-btn');
        const vExport = vocabModal.querySelector('#vmodal-export-btn');
        const vToggleSentence = vocabModal.querySelector('#vmodal-toggle-sentence');

        // 同步长句开关状态
        function updateSentenceToggleUI() {
            vToggleSentence.innerText = isSentenceReadingEnabled ? '📢 长句读译(开)' : '🔇 长句读译(关)';
            vToggleSentence.classList.toggle('active', isSentenceReadingEnabled);
        }
        updateSentenceToggleUI();

        vToggleSentence.addEventListener('click', () => {
            isSentenceReadingEnabled = !isSentenceReadingEnabled;
            safeStorage('bilingual_sentence_reading_on', String(isSentenceReadingEnabled));
            updateSentenceToggleUI();
        });

        let currentModalAudio = null;

        function renderVocabModal() {
            const list = getVocabDB();
            if (!vlistBox) return;
            vlistBox.textContent = '';
            if (list.length === 0) {
                setSafeHTML(vlistBox, '<div style="font-size:12px;color:#94a3b8;text-align:center;padding-top:70px;">暂无收录内容<br><br>💡 划选单词或长句<br>点击气泡中的 ⭐ 即可沉淀到这里复习</div>');
                return;
            }
            list.forEach((item, idx) => {
                const card = document.createElement('div');
                card.className = 'vcard';
                const isSent = item.type === 'sentence';
                setSafeHTML(card, `
                    <div class="vcard-main">
                        <div class="vcard-word">
                            <span class="vcard-tag ${isSent ? 'sentence' : 'word'}">${isSent ? '🎵 长句' : '生词'}</span>
                            <span>${item.word}</span>
                        </div>
                        <div class="vcard-trans">${item.trans}</div>
                    </div>
                    <div class="vcard-ctrls">
                        <button class="vcard-btn play-btn" title="重复精听">▶️</button>
                        <button class="vcard-btn del-btn" title="移除">✕</button>
                    </div>
                `);

                const playBtn = card.querySelector('.play-btn');
                playBtn.onclick = () => {
                    if (currentModalAudio === item.word) {
                        window.speechSynthesis.cancel();
                        currentModalAudio = null;
                        playBtn.innerText = '▶️';
                        playBtn.classList.remove('playing');
                        return;
                    }
                    window.speechSynthesis.cancel();
                    // 重置其他播放中按钮
                    vlistBox.querySelectorAll('.play-btn').forEach(b => { b.innerText = '▶️'; b.classList.remove('playing'); });

                    const utter = new SpeechSynthesisUtterance(item.word);
                    utter.rate = isSent ? 0.95 : 0.85;
                    currentModalAudio = item.word;
                    playBtn.innerText = '⏹️';
                    playBtn.classList.add('playing');
                    utter.onend = () => { playBtn.innerText = '▶️'; playBtn.classList.remove('playing'); currentModalAudio = null; };
                    utter.onerror = () => { playBtn.innerText = '▶️'; playBtn.classList.remove('playing'); currentModalAudio = null; };
                    window.speechSynthesis.speak(utter);
                };

                card.querySelector('.del-btn').onclick = () => {
                    let curList = getVocabDB();
                    curList.splice(idx, 1);
                    saveVocabDB(curList);
                    renderVocabModal();
                };
                vlistBox.appendChild(card);
            });
        }

        vExport.addEventListener('click', () => {
            const list = getVocabDB();
            if (!list.length) return alert('生词本空空如也~');
            let content = `【我的双语生词/长句精听库】\n导出时间: ${new Date().toLocaleString()}\n总条数: ${list.length}\n\n====================\n\n`;
            list.forEach(v => {
                const tag = v.type === 'sentence' ? '[长句]' : '[生词]';
                content += `${tag} ${v.word}\n译文: ${v.trans}\n收录日期: ${v.date}\n\n`;
            });
            downloadTextFile(`[精听生词本] ${new Date().toISOString().slice(0, 10)}.txt`, content);
        });

        vocabBtn.addEventListener('click', () => {
            const isOpen = vocabModal.style.display === 'flex';
            vocabModal.style.display = isOpen ? 'none' : 'flex';
            if (!isOpen) {
                updateSentenceToggleUI();
                renderVocabModal();
            }
        });
        vClose.addEventListener('click', () => {
            window.speechSynthesis.cancel();
            vocabModal.style.display = 'none';
        });
    }

    // ============================================================
    // 11. 全网通双模翻译引擎
    // ============================================================
    function initUniversalTranslatorEngine(toggleBtn, langSelect) {
        let isAutoTranslateOn = false;
        let observer = null;
        let scrollTimer = null;
        let triggerBusy = false;
        const translatingElements = new WeakSet();

        function getTranslatableBlocks() {
            const blocks = new Set();
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
                acceptNode: function(node) {
                    const text = node.nodeValue ? node.nodeValue.trim() : '';
                    if (text.length < 3 || !/[a-zA-Z\u0600-\u06FF\u3040-\u30FF\uAC00-\uD7AF\u4e00-\u9fa5]/.test(text)) {
                        return NodeFilter.FILTER_SKIP;
                    }
                    const parent = node.parentElement;
                    if (!parent || parent.closest('#bilingual-shadow-host, script, style, textarea, input, button, nav, time, [translate="no"], .bilingual-trans-node, .uni-video-sub-overlay')) {
                        return NodeFilter.FILTER_SKIP;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            });

            let node;
            while (node = walker.nextNode()) {
                let el = node.parentElement;
                while (el && el !== document.body) {
                    if (el.getAttribute('data-block') === 'true' ||
                        el.getAttribute('data-testid') === 'tweetText' ||
                        ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'LI', 'BLOCKQUOTE', 'TH', 'TD'].includes(el.tagName)) {
                        break;
                    }
                    el = el.parentElement;
                }
                if (el && el !== document.body && !el.dataset.bilingualDone && !translatingElements.has(el)) {
                    if (el.offsetParent === null && el.tagName !== 'BODY') continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    blocks.add(el);
                }
            }
            return Array.from(blocks);
        }

        function prioritizeVisible(elements) {
            const visible = [], others = [];
            const vh = window.innerHeight;
            for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                const rect = el.getBoundingClientRect();
                if (rect.top < vh + 200 && rect.bottom > -100) {
                    visible.push(el);
                } else {
                    others.push(el);
                }
            }
            return visible.concat(others);
        }

        async function triggerTranslation() {
            if (!isAutoTranslateOn || triggerBusy) return;
            triggerBusy = true;
            try {
                const targetLang = langSelect.value;

                const allTweetTexts = document.querySelectorAll('[data-testid="tweetText"], [data-block="true"]');
                for (const el of allTweetTexts) {
                    if (!el.dataset.bilingualDone) continue;
                    const currentText = (el.innerText || '').trim();
                    const prevLen = parseInt(el.dataset.bilingualTextLen || '0', 10);
                    if (currentText.length > prevLen + 15) {
                        const next = el.nextElementSibling;
                        if (next && next.classList.contains('bilingual-trans-node')) next.remove();
                        el.querySelectorAll('.bilingual-trans-node').forEach(n => n.remove());
                        delete el.dataset.bilingualDone;
                        delete el.dataset.bilingualTextLen;
                        translatingElements.delete(el);
                    }
                }

                const rawNodes = getTranslatableBlocks();
                const freshNodes = prioritizeVisible(rawNodes);

                for (const el of freshNodes) {
                    if (el.dataset.bilingualDone || translatingElements.has(el)) continue;

                    if (el.querySelector('.bilingual-trans-node') || (el.nextElementSibling && el.nextElementSibling.classList.contains('bilingual-trans-node'))) {
                        el.dataset.bilingualDone = 'true';
                        continue;
                    }

                    const originalText = el.innerText ? el.innerText.trim() : '';
                    if (originalText.length < 3 || originalText.length > 5000) {
                        el.dataset.bilingualDone = 'true';
                        continue;
                    }

                    translatingElements.add(el);
                    el.dataset.bilingualDone = 'true';
                    el.dataset.bilingualTextLen = String(originalText.length);

                    try {
                        const translated = await fetchBilingualTranslate(originalText, targetLang);
                        if (translated && translated.toLowerCase() !== originalText.toLowerCase()) {
                            const transNode = document.createElement('div');
                            const isHeading = ['H1', 'H2', 'H3', 'H4'].includes(el.tagName);
                            transNode.className = isHeading ? 'bilingual-trans-node bilingual-trans-heading' : 'bilingual-trans-node';
                            transNode.setAttribute('suppresshydrationwarning', 'true');
                            transNode.setAttribute('translate', 'no');
                            transNode.innerText = translated;

                            if (targetLang === 'ar') transNode.setAttribute('dir', 'rtl');
                            else transNode.setAttribute('dir', 'ltr');

                            if (el.tagName === 'TH' || el.tagName === 'TD') {
                                el.appendChild(transNode);
                            } else {
                                el.insertAdjacentElement('afterend', transNode);
                            }
                        }
                    } catch (err) {
                        el.removeAttribute('data-bilingual-done');
                        el.removeAttribute('data-bilingual-text-len');
                    } finally {
                        translatingElements.delete(el);
                    }
                }
            } finally {
                triggerBusy = false;
            }
        }

        function handleScroll() {
            if (!isAutoTranslateOn) return;
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(triggerTranslation, 200);
        }

        toggleBtn.addEventListener('click', () => {
            isAutoTranslateOn = !isAutoTranslateOn;
            if (isAutoTranslateOn) {
                toggleBtn.innerText = '🟢 网页翻译中';
                toggleBtn.classList.add('active');
                triggerTranslation();

                if (!observer) {
                    observer = new MutationObserver(() => {
                        clearTimeout(window.__bilingual_mut_timer);
                        window.__bilingual_mut_timer = setTimeout(triggerTranslation, 300);
                    });
                    observer.observe(document.body, { childList: true, subtree: true });
                }
                window.addEventListener('scroll', handleScroll, { passive: true });
            } else {
                toggleBtn.innerText = '🌐 网页双语';
                toggleBtn.classList.remove('active');
                if (observer) { observer.disconnect(); observer = null; }
                window.removeEventListener('scroll', handleScroll);
                document.querySelectorAll('.bilingual-trans-node').forEach(n => n.remove());
                document.querySelectorAll('[data-bilingual-done]').forEach(n => n.removeAttribute('data-bilingual-done'));
                document.querySelectorAll('[data-bilingual-text-len]').forEach(n => n.removeAttribute('data-bilingual-text-len'));
            }
        });
    }

    // ============================================================
    // 12. 保证加载并即刻挂载启动
    // ============================================================
    function start() {
        if (window.top !== window.self) {
            try {
                if (!document.body || !document.documentElement) return;
            } catch(e) { return; }
        }
        try {
            chrome.storage.local.get(null, (items) => {
                if (items) Object.assign(storageCache, items);
                initUI();
            });
        } catch(e) {
            initUI();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();