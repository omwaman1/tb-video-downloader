/**
 * Content Script Bridge v6
 * Relays messages between inject.js (MAIN world) and background service worker.
 * Handles server-request round-trips for two-phase extraction.
 * Includes robust error handling to prevent page disruption.
 */

let swAlive = true;

function safeSendMessage(msg, callback) {
    try {
        if (!chrome.runtime?.id) {
            console.warn('[WV-Bridge] Extension context invalidated, skipping message');
            if (callback) callback({ error: 'extension context invalidated' });
            return;
        }
        chrome.runtime.sendMessage(msg, (response) => {
            if (chrome.runtime.lastError) {
                if (swAlive) {
                    console.warn('[WV-Bridge] Failed to send:', chrome.runtime.lastError.message);
                    swAlive = false;
                }
                if (callback) callback({ error: chrome.runtime.lastError.message });
                return;
            }
            swAlive = true;
            if (callback) callback(response);
        });
    } catch (e) {
        console.warn('[WV-Bridge] Send error:', e.message);
        if (callback) callback({ error: e.message });
    }
}

window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'wv-key-logger') return;

    const msg = event.data;
    // Don't log every message to reduce noise
    if (msg.type === 'server-request') {
        console.log('[WV-Bridge]', msg.type, msg.data?.endpoint || '');
    }

    // Server request round-trip (inject.js → background → server → back)
    if (msg.type === 'server-request') {
        safeSendMessage({
            type: 'server-request',
            data: msg.data,
            reqId: msg.reqId,
        }, (response) => {
            window.postMessage({
                source: 'wv-key-logger-response',
                type: 'server-response',
                reqId: msg.reqId,
                result: response || { error: 'no response from background' },
            }, '*');
        });
        return;
    }

    // Forward other messages to background (fire-and-forget)
    safeSendMessage({
        type: msg.type,
        data: msg.data,
        timestamp: msg.timestamp,
        url: msg.url
    });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'get-page-data') {
        window.postMessage({ source: 'wv-key-logger-request', type: 'get-data' }, '*');
    }
    if (msg.type === 'export-keys') {
        window.postMessage({ source: 'wv-key-logger-request', type: 'export' }, '*');
    }
    if (msg.type === 'get-page-title') {
        // Read the video title directly from the Testbook DOM
        const el = document.querySelector('.lesson__info span.h3')
               || document.querySelector('.lesson__details span.h3')
               || document.querySelector('.lesson__next-class div:not(.next_arrow):not(.lesson__hamburger)');
        const title = el && el.textContent.trim();
        if (title && title.length > 1 && !title.includes('Download PDF')) {
            console.log('[WV-Bridge] Found page title from DOM:', title);
            sendResponse({ title });
            return true;
        }
        // If not found in this frame, DON'T respond — let other frames respond
        return false;
    }
    if (msg.type === 'get-pdf-urls') {
        console.log('[WV-Bridge] 📄 get-pdf-urls called in frame:', window.location.href.substring(0, 80));
        // Try multiple selectors for PDF links
        let pdfLinks = document.querySelectorAll('a.pdf-bg');
        console.log('[WV-Bridge] 📄 a.pdf-bg count:', pdfLinks.length);
        if (pdfLinks.length === 0) {
            pdfLinks = document.querySelectorAll('a[href*="pdf-viewer"]');
            console.log('[WV-Bridge] 📄 a[href*=pdf-viewer] count:', pdfLinks.length);
        }
        if (pdfLinks.length === 0) {
            pdfLinks = document.querySelectorAll('a[href*=".pdf"]');
            console.log('[WV-Bridge] 📄 a[href*=.pdf] count:', pdfLinks.length);
        }
        if (pdfLinks.length === 0) {
            console.log('[WV-Bridge] 📄 No PDF links found in this frame, returning false');
            return false;
        }
        const pdfs = [];
        pdfLinks.forEach(a => {
            const href = a.getAttribute('href') || '';
            console.log('[WV-Bridge] 📄 Raw href:', href.substring(0, 120));
            // URL is encoded in the ?u= parameter
            const uMatch = href.match(/[?&]u=([^&]+)/);
            if (uMatch) {
                const pdfUrl = decodeURIComponent(uMatch[1]);
                const name = a.textContent.trim() || 'notes.pdf';
                pdfs.push({ url: pdfUrl, name });
                console.log('[WV-Bridge] ✅ Found PDF:', name, pdfUrl.substring(0, 80));
            } else if (href.includes('.pdf')) {
                // Direct PDF link
                const name = a.textContent.trim() || 'notes.pdf';
                const fullUrl = href.startsWith('http') ? href : `https://testbook.com${href}`;
                pdfs.push({ url: fullUrl, name });
                console.log('[WV-Bridge] ✅ Found direct PDF:', name, fullUrl.substring(0, 80));
            }
        });
        console.log('[WV-Bridge] 📄 Total PDFs found:', pdfs.length);
        sendResponse({ pdfs });
        return true;
    }
});
