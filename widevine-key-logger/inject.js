/**
 * Widevine Key Logger - EME API Hooks
 * v5: Two-phase extraction inspired by L3 Decryptor.
 * 1. Intercept license fetch
 * 2. Get pywidevine challenge from local server (via extension)
 * 3. Send challenge to SDMC from page context (same origin!)
 * 4. Send response to local server for key extraction
 */

(function () {
    'use strict';

    const LOG_PREFIX = '[WV-KeyLogger]';
    const log = (...args) => console.log(`%c${LOG_PREFIX}`, 'color: #00ff88; font-weight: bold;', ...args);
    const warn = (...args) => console.warn(`%c${LOG_PREFIX}`, 'color: #ffaa00; font-weight: bold;', ...args);

    log('🔌 Extension v5 loaded (two-phase extraction)');

    const capturedData = { sessions: new Map() };
    let sessionCounter = 0;
    let latestPSSH = null;
    let latestServiceCert = null;
    let latestMPD = null;
    const extractedPSSHs = new Set();  // prevent re-extraction
    let extractionInProgress = false;  // re-entrance guard

    function bufToHex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''); }
    function bufToB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
    function parsePSSH(initData) { return { hex: bufToHex(initData), b64: bufToB64(initData) }; }

    // Store video name captured from Testbook entity API responses
    let latestVideoName = null;

    // Get video title — priority: API-captured name > DOM element > document.title
    function getVideoTitle() {
        if (latestVideoName) return latestVideoName;
        const el = document.querySelector('.lesson__info span.h3')
            || document.querySelector('.lesson__details span.h3');
        const title = el && el.textContent.trim();
        if (title && title.length > 1 && !title.includes('Download PDF')) return title;
        return document.title || 'video';
    }

    function sendToExtension(type, data) {
        try { window.postMessage({ source: 'wv-key-logger', type, data, timestamp: Date.now(), url: window.location.href }, '*'); } catch (e) { }
    }

    // Request-response via postMessage to content script → background → server
    let pendingRequests = {};
    let reqCounter = 0;

    function requestFromServer(endpoint, payload) {
        return new Promise((resolve) => {
            const reqId = `req_${++reqCounter}_${Date.now()}`;
            pendingRequests[reqId] = resolve;
            setTimeout(() => {
                if (pendingRequests[reqId]) {
                    delete pendingRequests[reqId];
                    resolve({ error: 'timeout' });
                }
            }, 15000);
            window.postMessage({
                source: 'wv-key-logger',
                type: 'server-request',
                reqId,
                data: { endpoint, payload }
            }, '*');
        });
    }

    // Listen for responses from content script
    window.addEventListener('message', (e) => {
        if (e.data?.source === 'wv-key-logger-response' && e.data?.type === 'server-response') {
            const { reqId, result } = e.data;
            if (pendingRequests[reqId]) {
                pendingRequests[reqId](result);
                delete pendingRequests[reqId];
            }
        }
    });

    // --- 1. Hook navigator.requestMediaKeySystemAccess ---
    if (navigator.requestMediaKeySystemAccess) {
        const origMKSA = navigator.requestMediaKeySystemAccess;
        navigator.requestMediaKeySystemAccess = function (keySystem, configs) {
            log('📋 requestMediaKeySystemAccess:', keySystem);
            sendToExtension('key-system-request', { keySystem, configs });
            return origMKSA.apply(this, arguments);
        };
    }

    // --- 2. Hook MediaKeySession.prototype ---
    if (window.MediaKeySession) {
        log('🔧 Hooking MediaKeySession.prototype');

        const origGenerateRequest = window.MediaKeySession.prototype.generateRequest;
        window.MediaKeySession.prototype.generateRequest = function (initDataType, initData) {
            log('📤 generateRequest called');
            if (!this._wvloggerId) {
                this._wvloggerId = `session_${++sessionCounter}_${Date.now()}`;
                capturedData.sessions.set(this._wvloggerId, { keys: [], timestamp: Date.now() });

                this.addEventListener('keystatuseschange', function () {
                    const sessionData = capturedData.sessions.get(this._wvloggerId);
                    if (!sessionData) return;
                    const keyStatuses = [];
                    this.keyStatuses.forEach((status, keyId) => {
                        keyStatuses.push({ kid: bufToHex(keyId), status });
                    });
                    sessionData.keys = keyStatuses;
                    sendToExtension('key-status-change', { sessionId: this._wvloggerId, keyStatuses });
                });

                this.addEventListener('message', function (e) {
                    const sessionData = capturedData.sessions.get(this._wvloggerId);
                    if (sessionData) sessionData.challenge = bufToB64(e.message);
                    sendToExtension('license-challenge', { sessionId: this._wvloggerId, challengeB64: bufToB64(e.message), challengeSize: e.message.byteLength });
                });
            }

            const pssh = parsePSSH(initData);
            latestPSSH = pssh.b64;
            const sessionData = capturedData.sessions.get(this._wvloggerId);
            if (sessionData) sessionData.pssh = pssh.b64;
            sendToExtension('generate-request', { sessionId: this._wvloggerId, initDataType, pssh: pssh.b64, psshHex: pssh.hex });
            return origGenerateRequest.apply(this, arguments);
        };

        // Hook update to capture cert
        const origUpdate = window.MediaKeySession.prototype.update;
        window.MediaKeySession.prototype.update = function (response) {
            const responseBytes = new Uint8Array(response);
            const responseB64 = bufToB64(response);
            let msgType = 'unknown';
            if (responseBytes.length > 1 && responseBytes[0] === 0x08) {
                if (responseBytes[1] === 0x05) msgType = 'SERVICE_CERTIFICATE';
                else if (responseBytes[1] === 0x02) msgType = 'LICENSE';
            }
            log(`📥 update: ${msgType} (${response.byteLength} bytes)`);

            if (this._wvloggerId) {
                const sessionData = capturedData.sessions.get(this._wvloggerId);
                if (msgType === 'SERVICE_CERTIFICATE') {
                    log('🏆 SERVICE CERTIFICATE CAPTURED!');
                    latestServiceCert = responseB64;
                    if (sessionData) sessionData.serviceCert = responseB64;
                    sendToExtension('service-certificate', { sessionId: this._wvloggerId, certB64: responseB64, certSize: response.byteLength });
                } else {
                    if (sessionData) sessionData.licenseResponse = responseB64;
                    sendToExtension('license-response', { sessionId: this._wvloggerId, responseB64, responseSize: response.byteLength });
                }
            }
            return origUpdate.apply(this, arguments);
        };
    }

    // --- 3. Hook Fetch — TWO-PHASE EXTRACTION ---
    const origFetch = window.fetch;
    window.fetch = async function (url, options) {
        const urlStr = typeof url === 'string' ? url : url?.url || '';

        // Log ALL mediacdn URLs to find the real manifest
        if (urlStr.includes('mediacdn') || urlStr.includes('testbook.com/api') || urlStr.includes('.mpd') || urlStr.includes('.m3u8')) {
            log('🔍 FETCH URL:', urlStr);
        }
        // Detect license request to SDMC (not the 2-byte cert request)
        if (urlStr.includes('getlicense') && latestPSSH && options?.body) {
            const bodyBytes = options.body instanceof ArrayBuffer
                ? new Uint8Array(options.body)
                : options.body instanceof Uint8Array
                    ? options.body
                    : null;

            if (bodyBytes && bodyBytes.length > 10 && !extractedPSSHs.has(latestPSSH) && !extractionInProgress) {
                extractionInProgress = true;
                log('🚀 INTERCEPTED license fetch! Starting async two-phase extraction...');
                sendToExtension('license-fetch', { url: urlStr, method: options?.method || 'GET' });

                // Run extraction asynchronously so we DON'T block the video player
                const currentPSSH = latestPSSH; // capture for the async closure
                const currentServiceCert = latestServiceCert;
                const requestUrl = urlStr;
                const requestHeaders = options?.headers || { 'Content-Type': 'application/octet-stream' };

                (async () => {
                    try {
                        // PHASE 1: Get pywidevine challenge from server
                        log('📡 Phase 1: Getting pywidevine challenge...');
                        const challengeResult = await requestFromServer('/challenge', {
                            pssh: currentPSSH,
                            serviceCert: currentServiceCert || null,
                        });

                        if (challengeResult.challenge) {
                            log('✅ Phase 1 OK: Got challenge (' + challengeResult.challenge.length + ' chars)');

                            // PHASE 2a: Send pywidevine challenge to SDMC FROM PAGE CONTEXT
                            log('📡 Phase 2a: Sending pywidevine challenge to SDMC from page context...');
                            const challengeBytes = Uint8Array.from(atob(challengeResult.challenge), c => c.charCodeAt(0));

                            // Use origFetch to send from page context (same origin!)
                            const sdmcResp = await origFetch.call(window, requestUrl, {
                                method: 'POST',
                                headers: requestHeaders,
                                body: challengeBytes,
                            });

                            if (sdmcResp.ok) {
                                const sdmcBuf = await sdmcResp.arrayBuffer();
                                const sdmcB64 = bufToB64(sdmcBuf);
                                log('✅ Phase 2a OK: SDMC response (' + sdmcBuf.byteLength + ' bytes)');

                                // PHASE 2b: Send license response to server for key extraction
                                log('📡 Phase 2b: Sending license to server for key extraction...');
                                const keysResult = await requestFromServer('/license', {
                                    license: sdmcB64,
                                    pssh: currentPSSH,
                                    url: window.location.href,
                                });

                                if (keysResult.keys && keysResult.keys.length > 0) {
                                    log('🔑 KEYS EXTRACTED SUCCESSFULLY!', keysResult.keys.length, 'keys');
                                    extractedPSSHs.add(currentPSSH);  // mark as done
                                    for (const k of keysResult.keys) {
                                        log(`  [${k.type}] ${k.kid}:${k.key}`);
                                    }
                                    sendToExtension('keys-extracted-inline', { keys: keysResult.keys });
                                } else {
                                    warn('⚠️ Phase 2b: No keys:', keysResult.error || 'unknown');
                                    extractedPSSHs.add(currentPSSH);  // don't retry failed PSSHs endlessly
                                }
                            } else {
                                warn('⚠️ Phase 2a: SDMC returned', sdmcResp.status);
                            }
                        } else {
                            warn('⚠️ Phase 1 failed:', challengeResult.error || 'no challenge');
                        }
                    } catch (e) {
                        warn('⚠️ Extraction error:', e.message);
                    } finally {
                        extractionInProgress = false;  // always reset
                    }
                })();
            }

            // IMMEDIATELY let the browser's original request through for video playback!
            // If we block here, the video player times out and the site refreshes the page.
            log('📤 Passing browser license request through immediately...');
            return origFetch.apply(this, arguments).then(res => {
                const cloned = res.clone();
                cloned.arrayBuffer().then(buf => {
                    sendToExtension('license-fetch-response', { url: urlStr, status: res.status, responseSize: buf.byteLength, responseB64: bufToB64(buf) });
                });
                return res;
            });
        }

        // Non-license / cert requests pass through
        if (urlStr.includes('sdmc.tv') || urlStr.includes('drm') || urlStr.includes('license') || urlStr.includes('getlicense')) {
            log('🌐 LICENSE FETCH:', urlStr.substring(0, 100));
            sendToExtension('license-fetch', { url: urlStr, method: options?.method || 'GET' });
            return origFetch.apply(this, arguments).then(res => {
                const cloned = res.clone();
                cloned.arrayBuffer().then(buf => {
                    sendToExtension('license-fetch-response', { url: urlStr, status: res.status, responseSize: buf.byteLength, responseB64: bufToB64(buf) });
                });
                return res;
            });
        }

        // Capture MPD/M3U8 manifest URLs — broad matching
        if (urlStr.includes('.mpd') || urlStr.includes('.m3u8') || urlStr.includes('manifest') ||
            urlStr.includes('output.mpd') || urlStr.includes('/dash/') || urlStr.includes('/hls/') ||
            urlStr.includes('cloudfront') || urlStr.includes('/drm/') || urlStr.includes('wvm') ||
            urlStr.includes('bitmovin') || urlStr.includes('.ism') ||
            urlStr.includes('mediacdn.testbook.com/wv/')) {
            if (!latestMPD || latestMPD !== urlStr) {
                latestMPD = urlStr;
                log('📹 MPD/Manifest URL captured:', urlStr.substring(0, 120));
                sendToExtension('mpd-url', { url: urlStr, title: document.title });
            }
        }

        // For API responses, try to find manifestUrl inside JSON
        const origResult = origFetch.apply(this, arguments);
        return origResult.then(res => {
            // Check API responses for embedded manifest URLs AND video names
            if ((urlStr.includes('testbook') || urlStr.includes('api')) && !urlStr.includes('getlicense')) {
                const clone2 = res.clone();
                clone2.text().then(text => {
                    try {
                        // 1) Extract video name from Testbook entity API responses
                        if (urlStr.includes('/entity/') || urlStr.includes('/class/') || urlStr.includes('/products/')) {
                            try {
                                const json = JSON.parse(text);
                                // Look for entityName in the response data
                                const entity = json?.data?.entity || json?.data || json?.entity || json;
                                const eName = entity?.entityName || entity?.name;
                                if (eName && typeof eName === 'string' && eName.length > 2) {
                                    latestVideoName = eName;
                                    log('📝 Video name from entity API:', latestVideoName);
                                    // Also send title update to background
                                    if (latestMPD) {
                                        sendToExtension('mpd-url', { url: latestMPD, title: latestVideoName });
                                    }
                                }
                            } catch { }
                        }

                        // 2) Search for MPD/manifest URLs in any API response
                        const mpdMatch = text.match(/(?:manifestUrl|manifest_url|playback_url|dashUrl|streamUrl|videoUrl|hlsUrl|mpdUrl)['\":\s]+['"]?(https?:\/\/[^'"&\s<>]+\.(?:mpd|m3u8)[^'"&\s<>]*)/i);
                        if (mpdMatch && mpdMatch[1]) {
                            const foundUrl = mpdMatch[1];
                            if (!latestMPD || latestMPD !== foundUrl) {
                                latestMPD = foundUrl;
                                log('📹 MPD from API response:', foundUrl.substring(0, 120));
                                sendToExtension('mpd-url', { url: foundUrl, title: getVideoTitle() });
                            }
                        }
                        if (!latestMPD) {
                            const anyMPD = text.match(/(https?:\/\/[^'"&\s<>]+\.(?:mpd|m3u8)[^'"&\s<>]*)/i);
                            if (anyMPD && anyMPD[1]) {
                                latestMPD = anyMPD[1];
                                log('📹 MPD found in response body:', latestMPD.substring(0, 120));
                                sendToExtension('mpd-url', { url: latestMPD, title: getVideoTitle() });
                            }
                        }
                    } catch { }
                }).catch(() => { });
            }
            return res;
        });
    };

    // XHR hooks — also capture MPD URLs and API responses with manifests
    const origXHROpen = XMLHttpRequest.prototype.open;
    const origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this._wvUrl = url;
        // Check XHR URL for MPD patterns
        if (url && (url.includes('.mpd') || url.includes('.m3u8') || url.includes('manifest') || url.includes('/dash/'))) {
            if (!latestMPD || latestMPD !== url) {
                latestMPD = url;
                log('📹 MPD from XHR:', url.substring(0, 120));
                sendToExtension('mpd-url', { url: url, title: getVideoTitle() });
            }
        }
        return origXHROpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        const xhr = this;
        if (this._wvUrl && (this._wvUrl.includes('sdmc.tv') || this._wvUrl.includes('drm') || this._wvUrl.includes('license'))) {
            log('🌐 LICENSE XHR:', this._wvUrl.substring(0, 100));
            sendToExtension('license-xhr', { url: this._wvUrl });
        }
        // Listen for XHR responses that might contain manifest URLs or entity names
        this.addEventListener('load', function () {
            try {
                if (!xhr.responseText || !xhr._wvUrl) return;
                const xhrUrl = xhr._wvUrl;

                // Extract video name from entity API XHR responses
                if (xhrUrl.includes('/entity/') || xhrUrl.includes('/class/') || xhrUrl.includes('/products/')) {
                    try {
                        const json = JSON.parse(xhr.responseText);
                        const entity = json?.data?.entity || json?.data || json?.entity || json;
                        const eName = entity?.entityName || entity?.name;
                        if (eName && typeof eName === 'string' && eName.length > 2) {
                            latestVideoName = eName;
                            log('📝 Video name from XHR entity API:', latestVideoName);
                            if (latestMPD) {
                                sendToExtension('mpd-url', { url: latestMPD, title: latestVideoName });
                            }
                        }
                    } catch { }
                }

                // Check for MPD URLs in XHR responses
                if (xhrUrl.includes('testbook') || xhrUrl.includes('api')) {
                    const mpdMatch = xhr.responseText.match(/(https?:\/\/[^'"&\s<>]+\.(?:mpd|m3u8)[^'"&\s<>]*)/i);
                    if (mpdMatch && mpdMatch[1] && (!latestMPD || latestMPD !== mpdMatch[1])) {
                        latestMPD = mpdMatch[1];
                        log('📹 MPD from XHR response:', latestMPD.substring(0, 120));
                        sendToExtension('mpd-url', { url: latestMPD, title: getVideoTitle() });
                    }
                }
            } catch { }
        });
        return origXHRSend.apply(this, arguments);
    };

    log('✅ Hooks installed (v5 two-phase extraction).');
})();
