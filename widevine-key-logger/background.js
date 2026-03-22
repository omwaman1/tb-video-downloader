/**
 * Background Service Worker
 * Stores all captured DRM data, serves it to the popup,
 * and AUTO-EXTRACTS keys via local pywidevine server.
 */

const KEY_SERVER = "http://127.0.0.1:8231";

// Storage for captured sessions
let capturedSessions = {};
let eventLog = [];
let extractedKeys = {};   // keys returned by the server
const MAX_LOG = 200;

function addLog(type, data) {
    eventLog.push({ type, data, time: new Date().toISOString() });
    if (eventLog.length > MAX_LOG) eventLog.shift();
}

// ─── Auto-extract keys via local server ─────────────────────
async function autoExtractKeys(sessionId, attempt = 1) {
    const s = capturedSessions[sessionId];
    if (!s || !s.pssh || !s.licenseUrl) return;
    if (s._extracted) return;   // already done

    s._extracting = true;
    console.log(`[WV-BG] 🚀 Auto-extracting keys for ${sessionId} (attempt ${attempt})`);
    addLog('auto-extract-start', { sessionId, attempt });

    try {
        const url = `${KEY_SERVER}/extract`;
        console.log(`[WV-BG] Fetching: ${url}`);

        const body = JSON.stringify({
            pssh: s.pssh,
            licenseUrl: s.licenseUrl,
            serviceCert: s.serviceCert || null,
            url: s.url || '',
        });
        console.log(`[WV-BG] Request body length: ${body.length}`);

        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body,
        });

        console.log(`[WV-BG] Response status: ${resp.status}`);
        const result = await resp.json();
        console.log(`[WV-BG] Response body:`, JSON.stringify(result).substring(0, 200));

        if (result.keys && result.keys.length > 0) {
            s._extracted = true;
            s.extractedKeys = result.keys;
            extractedKeys[sessionId] = result.keys;
            console.log('[WV-BG] 🔑 KEYS EXTRACTED:', result.keys.length);
            for (const k of result.keys) {
                console.log(`  [${k.type}] ${k.kid}:${k.key}`);
            }
            addLog('keys-extracted', { sessionId, keys: result.keys });
            updateBadge();
        } else {
            console.warn('[WV-BG] ⚠️ No keys in response:', result);
            addLog('extract-error', { sessionId, error: result.error || 'no keys', attempt });
        }
    } catch (err) {
        console.error(`[WV-BG] ❌ Key server error (attempt ${attempt}):`, err.name, err.message);
        console.error('[WV-BG] Error stack:', err.stack);
        addLog('extract-error', { sessionId, error: `${err.name}: ${err.message}`, attempt });

        // Retry up to 3 times with delay
        if (attempt < 3) {
            console.log(`[WV-BG] ⏳ Will retry in ${attempt * 2}s...`);
            setTimeout(() => autoExtractKeys(sessionId, attempt + 1), attempt * 2000);
            return; // don't clear _extracting yet
        }
    } finally {
        s._extracting = false;
    }
}

// Try to extract whenever we have enough data
function tryAutoExtract(sessionId) {
    const s = capturedSessions[sessionId];
    if (s && s.pssh && s.licenseUrl && !s._extracted && !s._extracting) {
        // Wait 2s for service cert to arrive before sending
        setTimeout(() => autoExtractKeys(sessionId), 2000);
    }
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    addLog(msg.type, msg.data);

    const sid = msg.data?.sessionId;

    switch (msg.type) {
        case 'key-system-request':
            console.log('[WV-BG] Key system request:', msg.data.keySystem);
            break;

        case 'generate-request':
            console.log('[WV-BG] PSSH captured:', msg.data.pssh?.substring(0, 60));
            if (sid) {
                // PSSH dedup: skip if we already have a session with this PSSH that has keys
                const newPssh = msg.data.pssh;
                const existingSession = Object.entries(capturedSessions).find(
                    ([_, s]) => s.pssh === newPssh && s._extracted
                );
                if (existingSession) {
                    console.log('[WV-BG] ⏭️ PSSH already extracted, skipping duplicate session');
                    break;
                }
                if (!capturedSessions[sid]) capturedSessions[sid] = {};
                capturedSessions[sid].pssh = msg.data.pssh;
                capturedSessions[sid].url = msg.url;
                capturedSessions[sid].timestamp = msg.timestamp;
            }
            updateBadge();
            if (sid) tryAutoExtract(sid);
            break;

        case 'license-challenge':
            console.log('[WV-BG] License challenge:', msg.data.challengeSize, 'bytes');
            if (sid && capturedSessions[sid]) {
                capturedSessions[sid].challenge = msg.data.challengeB64;
                capturedSessions[sid].challengeSize = msg.data.challengeSize;
            }
            break;

        case 'license-response':
            console.log('[WV-BG] License response:', msg.data.responseSize, 'bytes');
            if (sid && capturedSessions[sid]) {
                capturedSessions[sid].licenseResponse = msg.data.responseB64;
                capturedSessions[sid].responseSize = msg.data.responseSize;
            }
            break;

        case 'license-fetch':
            console.log('[WV-BG] License fetch URL:', msg.data.url?.substring(0, 100));
            // Associate with most recent session that needs a license URL
            for (const s of Object.keys(capturedSessions).reverse()) {
                if (!capturedSessions[s].licenseUrl) {
                    capturedSessions[s].licenseUrl = msg.data.url;
                    // NOTE: Don't auto-extract here anymore — inject.js v3 handles it inline
                    break;
                }
            }
            break;

        case 'license-fetch-response':
            console.log('[WV-BG] License fetch response:', msg.data.status, msg.data.responseSize, 'bytes');
            for (const s of Object.keys(capturedSessions).reverse()) {
                if (capturedSessions[s].licenseUrl === msg.data.url) {
                    capturedSessions[s].serverResponse = msg.data.responseB64;
                    capturedSessions[s].serverResponseSize = msg.data.responseSize;
                    break;
                }
            }
            break;

        case 'keys-extracted-inline':
            // Keys extracted by inject.js via the fetch intercept
            console.log('[WV-BG] 🔑 INLINE KEYS EXTRACTED:', msg.data.keys?.length);
            if (msg.data.keys && msg.data.keys.length > 0) {
                // Check if keys for this PSSH are already stored (dedup)
                const contentKids = msg.data.keys.filter(k => k.type === 'CONTENT').map(k => k.kid).sort().join(',');
                const alreadyHave = Object.values(capturedSessions).some(s => {
                    if (!s._extracted || !s.extractedKeys) return false;
                    const existingKids = s.extractedKeys.filter(k => k.type === 'CONTENT').map(k => k.kid).sort().join(',');
                    return existingKids === contentKids;
                });
                if (alreadyHave) {
                    console.log('[WV-BG] ⏭️ Keys already captured for these KIDs, skipping');
                    break;
                }
                // Find the most recent session to attach keys to
                for (const s of Object.keys(capturedSessions).reverse()) {
                    if (!capturedSessions[s]._extracted) {
                        capturedSessions[s]._extracted = true;
                        capturedSessions[s].extractedKeys = msg.data.keys;
                        extractedKeys[s] = msg.data.keys;
                        console.log('[WV-BG] Keys attached to session:', s);
                        break;
                    }
                }
                addLog('keys-extracted', { keys: msg.data.keys });
                updateBadge();
            }
            break;

        case 'service-certificate':
            console.log('[WV-BG] 🏆 SERVICE CERTIFICATE CAPTURED!', msg.data.certSize, 'bytes');
            if (sid && capturedSessions[sid]) {
                capturedSessions[sid].serviceCert = msg.data.certB64;
                // NOTE: Don't auto-extract here anymore
            }
            chrome.storage.local.set({ chromeCert: msg.data.certB64 });
            break;

        case 'key-status-change':
            console.log('[WV-BG] Key statuses:', msg.data.keyStatuses);
            if (sid && capturedSessions[sid]) {
                capturedSessions[sid].keyStatuses = msg.data.keyStatuses;
            }
            updateBadge();
            saveToDisk();
            break;

        case 'mpd-url':
            console.log('[WV-BG] 📹 MPD URL:', msg.data.url?.substring(0, 80));
            // Store on the most recent session, or update title if already set
            for (const s of Object.keys(capturedSessions).reverse()) {
                if (capturedSessions[s].mpdUrl === msg.data.url) {
                    // Same MPD — update title if the new one is better
                    if (msg.data.title && !msg.data.title.includes('Testbook.com')) {
                        capturedSessions[s].pageTitle = msg.data.title;
                        console.log('[WV-BG] 📝 Updated title:', msg.data.title);
                    }
                    break;
                }
                if (!capturedSessions[s].mpdUrl) {
                    capturedSessions[s].mpdUrl = msg.data.url;
                    capturedSessions[s].pageTitle = msg.data.title;
                    break;
                }
            }
            break;

        case 'get-all-data':
            sendResponse({
                sessions: capturedSessions,
                log: eventLog,
                extractedKeys: extractedKeys,
            });
            return true;

        case 'clear-data':
            capturedSessions = {};
            eventLog = [];
            extractedKeys = {};
            updateBadge();
            sendResponse({ ok: true });
            return true;

        case 'get-downloads':
            // Return active download info for popup to display progress
            {
                const dlInfo = {};
                for (const [sid, s] of Object.entries(capturedSessions)) {
                    if (s._downloadId) {
                        dlInfo[sid] = { downloadId: s._downloadId, title: s.pageTitle };
                    }
                }
                sendResponse(dlInfo);
            }
            return true;

        case 'server-request':
            // Generic server request proxy (for two-phase extraction)
            console.log('[WV-BG] 📡 Server request:', msg.data.endpoint);
            (async () => {
                try {
                    const resp = await fetch(`${KEY_SERVER}${msg.data.endpoint}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(msg.data.payload),
                    });
                    const result = await resp.json();
                    console.log('[WV-BG] 📡 Server response:', msg.data.endpoint, result.keys ? `${result.keys.length} keys` : (result.challenge ? 'challenge OK' : result.error || 'ok'));

                    // If keys came back, store them
                    if (result.keys && result.keys.length > 0) {
                        for (const s of Object.keys(capturedSessions).reverse()) {
                            if (!capturedSessions[s]._extracted) {
                                capturedSessions[s]._extracted = true;
                                capturedSessions[s].extractedKeys = result.keys;
                                extractedKeys[s] = result.keys;
                                console.log('[WV-BG] 🔑 Keys stored for session:', s);
                                for (const k of result.keys) {
                                    console.log(`  [${k.type}] ${k.kid}:${k.key}`);
                                }
                                break;
                            }
                        }
                        addLog('keys-extracted', { keys: result.keys });
                        updateBadge();
                    }

                    sendResponse(result);
                } catch (e) {
                    console.error('[WV-BG] 📡 Server error:', e.message);
                    sendResponse({ error: e.message });
                }
            })();
            return true;

        case 'trigger-download':
            // Download triggered by popup button — uses the same flow as auto-download
            (async () => {
                const dlSessionId = msg.sessionId;
                const s = capturedSessions[dlSessionId];
                if (!s) { sendResponse({ status: 'error', error: 'Session not found' }); return; }

                const keys = s.extractedKeys;
                const mpdUrl = s.mpdUrl;
                if (!keys || keys.length === 0) { sendResponse({ status: 'error', error: 'No keys extracted yet' }); return; }
                if (!mpdUrl) { sendResponse({ status: 'error', error: 'No MPD URL captured yet' }); return; }

                const contentKeys = keys.filter(k => k.type === 'CONTENT');
                if (contentKeys.length === 0) { sendResponse({ status: 'error', error: 'No CONTENT keys' }); return; }

                // Fix MPD URL (same logic that was working in auto-download)
                let finalMpdUrl = mpdUrl;
                if (!finalMpdUrl.endsWith('.mpd')) {
                    let cleanUrl = finalMpdUrl.replace(/\/[^\/]+\.(mp4|m4s|m4a|webm)$/i, '');
                    cleanUrl = cleanUrl.replace(/\/$/, '');
                    const lastSeg = cleanUrl.split('/').pop();
                    finalMpdUrl = `${cleanUrl}/${lastSeg}.mpd`;
                }

                // Get the actual video title from the DOM via content script
                let title = s.pageTitle || 'video';
                try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab?.id) {
                        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'get-page-title' });
                        if (resp?.title && !resp.title.includes('Testbook.com')) {
                            title = resp.title;
                            s.pageTitle = title; // Update stored title
                            console.log('[WV-BG] 📝 Got title from DOM:', title);
                        }
                    }
                } catch (e) {
                    console.log('[WV-BG] Could not get DOM title:', e.message);
                }

                console.log(`[WV-BG] 📥 DOWNLOAD: ${title}`);
                console.log(`[WV-BG]   MPD: ${finalMpdUrl}`);
                console.log(`[WV-BG]   Keys: ${contentKeys.length} CONTENT keys`);
                addLog('download-start', { sessionId: dlSessionId, mpdUrl: finalMpdUrl, title });

                try {
                    const resp = await fetch(`${KEY_SERVER}/download`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            mpdUrl: finalMpdUrl,
                            keys: contentKeys,
                            title,
                        }),
                    });
                    const result = await resp.json();
                    console.log(`[WV-BG] ✅ Download started:`, result);
                    s._downloadId = result.id;
                    addLog('download-started', { sessionId: dlSessionId, dlId: result.id });
                    sendResponse({ status: 'started', id: result.id });

                    // Also download PDFs from the page
                    try {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        console.log('[WV-BG] 📄 PDF check - tab:', tab?.id, tab?.url?.substring(0, 60));
                        if (tab?.id) {
                            const pdfResp = await chrome.tabs.sendMessage(tab.id, { type: 'get-pdf-urls' });
                            console.log('[WV-BG] 📄 PDF response:', JSON.stringify(pdfResp));
                            if (pdfResp?.pdfs && pdfResp.pdfs.length > 0) {
                                const safeTitle = title.replace(/[<>:"/\\|?*]/g, '').trim().substring(0, 80);
                                for (const pdf of pdfResp.pdfs) {
                                    const pdfFilename = `downloads/${safeTitle}_${pdf.name}`;
                                    console.log(`[WV-BG] 📄 Downloading PDF: ${pdfFilename} from ${pdf.url.substring(0, 80)}`);
                                    chrome.downloads.download({
                                        url: pdf.url,
                                        filename: pdfFilename,
                                        conflictAction: 'uniquify',
                                    }, (dlId) => {
                                        console.log('[WV-BG] 📄 PDF download started, id:', dlId, chrome.runtime.lastError?.message || 'OK');
                                    });
                                }
                            } else {
                                console.log('[WV-BG] 📄 No PDFs found on page');
                            }
                        }
                    } catch (e) {
                        console.log('[WV-BG] 📄 PDF download error:', e.message);
                    }

                } catch (e) {
                    console.error(`[WV-BG] ❌ Download failed:`, e.message);
                    addLog('download-error', { sessionId: dlSessionId, error: e.message });
                    sendResponse({ status: 'error', error: e.message });
                }
            })();
            return true;
    }

    return true;
});

function updateBadge() {
    const keyCount = Object.keys(extractedKeys).length;
    const sessionCount = Object.keys(capturedSessions).length;
    const text = keyCount > 0 ? `🔑${keyCount}` : (sessionCount > 0 ? String(sessionCount) : '');
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: keyCount > 0 ? '#00ff88' : '#00cc66' });
}

async function saveToDisk() {
    try {
        const exportData = {};
        for (const [sid, data] of Object.entries(capturedSessions)) {
            if (data.keyStatuses && data.keyStatuses.length > 0) {
                exportData[sid] = {
                    pssh: data.pssh,
                    licenseUrl: data.licenseUrl,
                    keyStatuses: data.keyStatuses,
                    extractedKeys: data.extractedKeys || null,
                    challenge: data.challenge,
                    licenseResponse: data.licenseResponse || data.serverResponse,
                    url: data.url,
                    timestamp: data.timestamp
                };
            }
        }
        if (Object.keys(exportData).length > 0) {
            await chrome.storage.local.set({ capturedKeys: exportData });
        }
    } catch (e) {
        console.error('[WV-BG] Save error:', e);
    }
}



console.log('[WV-BG] Background service worker started (with auto-extract + auto-download)');

// Enable opening the side panel when the extension action icon is clicked
if (chrome.sidePanel) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
        .catch(console.error);
}
