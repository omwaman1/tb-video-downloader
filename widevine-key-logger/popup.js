/**
 * Popup Script v6 – No inline handlers (MV3 CSP compliant)
 */

const KEY_SERVER = 'http://127.0.0.1:8231';
const sessionListEl = document.getElementById('sessionList');
const logAreaEl = document.getElementById('logArea');
const serverStatusEl = document.getElementById('serverStatus');

let activeDownloads = {};

// ── Tab switching ──
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const tabName = tab.dataset.tab;
        document.getElementById('sessions-tab').style.display = tabName === 'sessions' ? 'block' : 'none';
        document.getElementById('log-tab').style.display = tabName === 'log' ? 'block' : 'none';
    });
});

// ── Check server status ──
async function checkServer() {
    try {
        const resp = await fetch(`${KEY_SERVER}/ping`, { signal: AbortSignal.timeout(2000) });
        await resp.json();
        serverStatusEl.textContent = `● Server Online`;
        serverStatusEl.className = 'server-status server-online';
    } catch {
        serverStatusEl.textContent = '● Server Offline';
        serverStatusEl.className = 'server-status server-offline';
    }
}

// ── Download polling ──
function pollDownloadStatus(dlId, sid) {
    const poll = async () => {
        try {
            const resp = await fetch(`${KEY_SERVER}/download-status?id=${dlId}`);
            const data = await resp.json();
            const statusEl = document.getElementById(`dl-status-${sid}`);
            const btn = document.querySelector(`[data-dl-sid="${sid}"]`);
            if (!statusEl) return;

            if (data.status === 'done') {
                statusEl.innerHTML = `<div class="dl-done">✅ Downloaded! ${data.size_mb} MB</div><div class="dl-step" style="color:#aaa">${data.file}</div>`;
                clearInterval(activeDownloads[dlId]);
                if (btn) btn.textContent = '✅ Done';
            } else if (data.status === 'error') {
                statusEl.innerHTML = `<div class="dl-error">❌ ${data.error}</div>`;
                clearInterval(activeDownloads[dlId]);
                if (btn) { btn.textContent = '❌ Failed'; btn.disabled = false; }
            } else {
                statusEl.innerHTML = `<div class="dl-step">⏳ ${data.step || data.status}</div><div class="dl-progress"><div class="bar" style="width:50%"></div></div>`;
            }
        } catch {}
    };
    poll();
    activeDownloads[dlId] = setInterval(poll, 2000);
}



// ── Start download (via background.js trigger-download) ──
async function startDownload(btn) {
    const sid = btn.dataset.dlSid;

    btn.disabled = true;
    btn.textContent = '⏳ Downloading...';
    const statusEl = document.getElementById(`dl-status-${sid}`);
    if (statusEl) { statusEl.style.display = 'block'; statusEl.innerHTML = '<div class="dl-step">⏳ Sending to server...</div>'; }

    chrome.runtime.sendMessage({ type: 'trigger-download', sessionId: sid }, (result) => {
        if (!result) {
            if (statusEl) statusEl.innerHTML = '<div class="dl-error">❌ Extension not connected</div>';
            btn.textContent = '📥 Download Video'; btn.disabled = false;
            return;
        }
        if (result.status === 'started' && result.id) {
            pollDownloadStatus(result.id, sid);
        } else {
            if (statusEl) statusEl.innerHTML = `<div class="dl-error">❌ ${result.error || 'Server error'}</div>`;
            btn.textContent = '📥 Download Video'; btn.disabled = false;
        }
    });
}

// ── Copy key ──
function copyKey(el) {
    const key = el.dataset.key;
    navigator.clipboard.writeText(key).then(() => {
        el.classList.add('copied');
        el.querySelector('.copy-hint').textContent = '✅ Copied!';
        setTimeout(() => {
            el.classList.remove('copied');
            el.querySelector('.copy-hint').textContent = '📋 click to copy';
        }, 2000);
    });
}

// ── Event delegation for dynamic elements ──
sessionListEl.addEventListener('click', (e) => {
    // Key row click → copy
    const keyRow = e.target.closest('.key-row');
    if (keyRow) { copyKey(keyRow); return; }

    // Download button click
    const dlBtn = e.target.closest('.download');
    if (dlBtn) { startDownload(dlBtn); return; }
});

// ── Refresh data ──
function refresh() {
    checkServer();
    chrome.runtime.sendMessage({ type: 'get-all-data' }, (response) => {
        if (!response) {
            sessionListEl.innerHTML = '<div class="empty">Extension not connected. Reload the page.</div>';
            return;
        }
        renderSessions(response.sessions || {}, response.extractedKeys || {});
        renderLog(response.log || []);
    });
}

function renderSessions(sessions) {
    const entries = Object.entries(sessions);
    if (entries.length === 0) {
        sessionListEl.innerHTML = '<div class="empty">No DRM sessions captured yet.<br>Play a DRM video to start capturing.</div>';
        return;
    }

    let html = '';
    for (const [sid, data] of entries) {
        const keyCount = data.keyStatuses?.length || 0;
        const hasExtracted = data.extractedKeys && data.extractedKeys.length > 0;
        const hasMPD = !!data.mpdUrl;
        const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : '?';

        html += `<div class="session ${hasExtracted ? 'has-keys' : ''}">`;
        html += `<div class="session-header">${hasExtracted ? '🔑' : '🎬'} ${data.pageTitle || sid} (${time})</div>`;

        if (data.pssh) {
            html += `<div class="field"><span class="label">PSSH:</span> <span class="value">${data.pssh.substring(0, 60)}...</span></div>`;
        }
        if (hasMPD) {
            html += `<div class="field"><span class="label">MPD:</span> <span class="value">${data.mpdUrl.substring(0, 80)}...</span></div>`;
        }

        if (hasExtracted) {
            const contentKeys = data.extractedKeys.filter(k => k.type === 'CONTENT');
            html += `<div class="keys-section">`;
            html += `<div class="keys-title">🔓 Decryption Keys (${contentKeys.length} CONTENT)</div>`;
            for (const k of contentKeys) {
                const pair = `${k.kid}:${k.key}`;
                html += `<div class="key-row" data-key="${pair}">`;
                html += `<span class="key-type">[${k.type}]</span> ${pair}`;
                html += `<span class="copy-hint">📋 click to copy</span>`;
                html += `</div>`;
            }
            html += `</div>`;

            // Download button — just passes session ID, background.js handles the rest
            html += `<div style="margin-top:8px">`;
            html += `<button class="download" data-dl-sid="${sid}">📥 Download Video</button>`;
            html += `<div id="dl-status-${sid}" class="dl-status" style="display:none"></div>`;
            html += `</div>`;
        } else if (data._extracting) {
            html += `<div class="field"><span class="value" style="color:#ffaa00">⏳ Extracting keys...</span></div>`;
        }

        html += `</div>`;
    }

    sessionListEl.innerHTML = html;


}

function renderLog(log) {
    if (log.length === 0) { logAreaEl.innerHTML = '<div class="log-entry">No events yet</div>'; return; }
    let html = '';
    for (const entry of log.slice(-50)) {
        const time = entry.time ? entry.time.split('T')[1]?.split('.')[0] : '';
        const dataStr = typeof entry.data === 'object' ? JSON.stringify(entry.data).substring(0, 150) : String(entry.data);
        html += `<div class="log-entry">${time} <span class="type">[${entry.type}]</span> ${dataStr}</div>`;
    }
    logAreaEl.innerHTML = html;
    logAreaEl.scrollTop = logAreaEl.scrollHeight;
}

// ── Export JSON ──
document.getElementById('exportBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'get-all-data' }, (response) => {
        const blob = new Blob([JSON.stringify(response, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({ url, filename: `wv_keys_${Date.now()}.json`, saveAs: true });
    });
});

// ── Export TXT ──
document.getElementById('exportTxtBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'get-all-data' }, (response) => {
        let txt = '# Widevine Decryption Keys\n';
        for (const [sid, data] of Object.entries(response.sessions || {})) {
            if (data.extractedKeys && data.extractedKeys.length > 0) {
                txt += `# ${sid}\n`;
                for (const k of data.extractedKeys) { txt += `${k.kid}:${k.key}\n`; }
                txt += '\n';
            }
        }
        const blob = new Blob([txt], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({ url, filename: `wv_keys_${Date.now()}.txt`, saveAs: true });
    });
});

// ── Clear ──
document.getElementById('clearBtn').addEventListener('click', () => {
    if (confirm('Clear all captured data?')) {
        chrome.runtime.sendMessage({ type: 'clear-data' }, () => refresh());
    }
});

document.getElementById('refreshBtn').addEventListener('click', refresh);
refresh();
setInterval(refresh, 3000);
