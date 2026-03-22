"""
Widevine Key Server v5 — two-phase extraction + video download.
Phase 1: /challenge — generates pywidevine challenge
Phase 2: /license  — receives license response, extracts keys
Phase 3: /download — downloads + decrypts video using N_m3u8DL-RE + mp4decrypt

Usage: py -3 key_server.py
"""

import json, base64, os, sys, time, traceback, re, subprocess, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

import requests as http_requests
from pywidevine.cdm import Cdm
from pywidevine.device import Device
from pywidevine.pssh import PSSH

HOST = "127.0.0.1"
PORT = 8231
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WVD_PATH = os.path.join(BASE_DIR, "device.wvd")
KEYS_DIR = os.path.join(BASE_DIR, "keys")
DOWNLOADS_DIR = os.path.join(BASE_DIR, "downloads")
LOG_PATH = os.path.join(BASE_DIR, "server_debug.log")
N_M3U8DL = os.path.join(BASE_DIR, "N_m3u8DL-RE.exe")
MP4DECRYPT = os.path.join(BASE_DIR, "mp4decrypt.exe")

with open(LOG_PATH, "w") as f:
    f.write("")

def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    try:
        print(line, flush=True)
    except:
        pass
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")

device = Device.load(WVD_PATH)
log(f"CDM device loaded - system_id={device.system_id}")

cdm = Cdm.from_device(device)
active_session = None
pending_challenge = False
session_lock = threading.Lock()
all_extracted_keys = {}

# Download tracking
downloads = {}


def phase1_challenge(pssh_b64, service_cert_b64=None):
    global cdm, active_session, pending_challenge
    with session_lock:
        if pending_challenge:
            log("  SKIPPED: Challenge already pending, waiting for license")
            return {"error": "challenge already pending"}
        pssh = PSSH(pssh_b64)
        if active_session:
            try: cdm.close(active_session)
            except: pass
            active_session = None
        try:
            cert_data = base64.b64decode(service_cert_b64) if service_cert_b64 else None
            session_id = cdm.open()
            active_session = session_id
            if cert_data:
                cdm.set_service_certificate(session_id, cert_data)
            challenge = cdm.get_license_challenge(session_id, pssh)
            pending_challenge = True
            log(f"  Challenge: {len(challenge)} bytes")
            return {"challenge": base64.b64encode(challenge).decode()}
        except Exception as e:
            log(f"  ERROR: {e}")
            traceback.print_exc()
            return {"error": str(e)}


def phase2_license(license_b64):
    global cdm, active_session, pending_challenge
    with session_lock:
        if not active_session:
            return {"error": "No active session"}
        try:
            license_data = base64.b64decode(license_b64)
            cdm.parse_license(active_session, license_data)
            keys = []
            for k in cdm.get_keys(active_session):
                keys.append({"type": str(k.type), "kid": k.kid.hex, "key": k.key.hex()})
            log(f"  {len(keys)} keys extracted")
            return {"keys": keys}
        except Exception as e:
            log(f"  ERROR: {e}")
            traceback.print_exc()
            with open(LOG_PATH, "a") as f:
                traceback.print_exc(file=f)
            return {"error": str(e)}
        finally:
            try: cdm.close(active_session)
            except: pass
            active_session = None
            pending_challenge = False


def sanitize_filename(name):
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = name.strip()[:100]
    return name or "video"


def is_already_downloaded(title):
    """Check if video with this title already exists in downloads folder."""
    safe_title = sanitize_filename(title)
    for ext in [".mp4", ".mkv", ".ts"]:
        path = os.path.join(DOWNLOADS_DIR, safe_title + ext)
        if os.path.exists(path):
            size_mb = round(os.path.getsize(path) / (1024 * 1024), 2)
            return True, path, size_mb
    return False, None, 0


def do_download(dl_id, mpd_url, keys, title, cookies=""):
    """Background thread: download, decrypt, and mux video using N_m3u8DL-RE."""
    try:
        content_keys = [k for k in keys if k["type"] == "CONTENT"]
        if not content_keys:
            downloads[dl_id]["status"] = "error"
            downloads[dl_id]["error"] = "No CONTENT keys"
            return

        downloads[dl_id]["status"] = "downloading"
        downloads[dl_id]["step"] = "Starting N_m3u8DL-RE..."
        downloads[dl_id]["progress"] = 0
        safe_title = sanitize_filename(title)
        os.makedirs(DOWNLOADS_DIR, exist_ok=True)

        cmd = [
            N_M3U8DL, mpd_url,
            "--save-dir", DOWNLOADS_DIR,
            "--save-name", safe_title,
            "-sv", 'res="480":for=best',
            "-sa", "best",
            "-M", "format=mp4",
            "-mt",
            "--thread-count", "32",
            "--header", "Origin: https://testbook.com",
            "--header", "Referer: https://testbook.com/",
            "--header", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ]
        for k in content_keys:
            cmd.extend(["--key", f"{k['kid']}:{k['key']}"])

        log(f"  [DL {dl_id}] Running: N_m3u8DL-RE {safe_title}")
        log(f"  [DL {dl_id}] Keys: {len(content_keys)}")

        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, cwd=BASE_DIR, encoding='utf-8', errors='replace'
        )

        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            log(f"  [DL {dl_id}] {line}")
            if "%" in line:
                pct = re.search(r'(\d+\.?\d*)%', line)
                if pct:
                    downloads[dl_id]["progress"] = float(pct.group(1))
                    downloads[dl_id]["step"] = f"Downloading: {pct.group(1)}%"
            elif "Done" in line:
                downloads[dl_id]["step"] = "Finalizing..."

        proc.wait(timeout=3600)

        # Check for output file
        expected = os.path.join(DOWNLOADS_DIR, f"{safe_title}.mp4")
        # Also check .mkv
        if not os.path.exists(expected):
            expected = os.path.join(DOWNLOADS_DIR, f"{safe_title}.mkv")

        if os.path.exists(expected):
            size_mb = round(os.path.getsize(expected) / (1024 * 1024), 2)
            downloads[dl_id]["status"] = "done"
            downloads[dl_id]["file"] = expected
            downloads[dl_id]["size_mb"] = size_mb
            downloads[dl_id]["progress"] = 100
            downloads[dl_id]["step"] = f"Done! {size_mb} MB"
            log(f"  [DL {dl_id}] ✅ DONE: {expected} ({size_mb} MB)")
        else:
            downloads[dl_id]["status"] = "error"
            downloads[dl_id]["error"] = f"Output file not found (exit code {proc.returncode})"
            log(f"  [DL {dl_id}] ❌ Output not found")

    except Exception as e:
        downloads[dl_id]["status"] = "error"
        downloads[dl_id]["error"] = str(e)
        log(f"  [DL {dl_id}] ERROR: {e}")
        traceback.print_exc()


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        body = json.dumps(obj, indent=2).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/ping":
            self._json(200, {"status": "ok", "keys_count": len(all_extracted_keys)})
        elif self.path.startswith("/download-status"):
            # Parse ?id=xxx
            dl_id = self.path.split("id=")[-1] if "id=" in self.path else ""
            if dl_id in downloads:
                self._json(200, downloads[dl_id])
            else:
                self._json(404, {"error": "unknown download id"})
        elif self.path == "/downloads":
            self._json(200, downloads)
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))

        if self.path == "/challenge":
            pssh = body.get("pssh")
            service_cert = body.get("serviceCert")
            if not pssh:
                self._json(400, {"error": "pssh required"})
                return
            log(f"\n{'='*60}")
            log(f"PHASE 1: Generate challenge")
            log(f"  PSSH: {pssh[:60]}...")
            result = phase1_challenge(pssh, service_cert)
            self._json(200, result)

        elif self.path == "/license":
            license_b64 = body.get("license")
            page_url = body.get("url", "unknown")
            pssh = body.get("pssh", "")
            if not license_b64:
                self._json(400, {"error": "license required"})
                return
            log(f"\n{'='*60}")
            log(f"PHASE 2: Parse license")
            result = phase2_license(license_b64)
            if "error" not in result:
                keys = result["keys"]
                content_keys = [k for k in keys if k["type"] == "CONTENT"]
                log(f"  ✅ {len(keys)} keys ({len(content_keys)} CONTENT)")
                for k in keys:
                    log(f"    [{k['type']}] {k['kid']}:{k['key']}")
                ts = str(int(time.time()))
                all_extracted_keys[ts] = {"page_url": page_url, "pssh": pssh, "keys": keys}
                os.makedirs(KEYS_DIR, exist_ok=True)
                with open(os.path.join(KEYS_DIR, "all_keys.txt"), "a") as f:
                    f.write(f"\n# {page_url}\n# {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                    for k in content_keys:
                        f.write(f"{k['kid']}:{k['key']}\n")
                self._json(200, {"keys": keys})
            else:
                self._json(502, result)

        elif self.path == "/download":
            mpd_url = body.get("mpdUrl")
            keys = body.get("keys", [])
            title = body.get("title", "video")
            cookies = body.get("cookies", "")
            if not mpd_url:
                self._json(400, {"error": "mpdUrl required"})
                return
            if not keys:
                self._json(400, {"error": "keys required"})
                return

            # Skip if already downloaded
            exists, path, size_mb = is_already_downloaded(title)
            if exists:
                dl_id = f"dl_{int(time.time())}"
                downloads[dl_id] = {
                    "id": dl_id,
                    "status": "skipped",
                    "step": f"Already exists ({size_mb} MB)",
                    "title": title,
                    "file": path,
                    "size_mb": size_mb,
                    "progress": 100,
                    "started": time.strftime('%H:%M:%S'),
                }
                log(f"\n{'='*60}")
                log(f"⏭️  SKIP: {title} (already downloaded, {size_mb} MB)")
                self._json(200, {"id": dl_id, "status": "skipped", "size_mb": size_mb})
                return

            dl_id = f"dl_{int(time.time())}"
            downloads[dl_id] = {
                "id": dl_id,
                "status": "starting",
                "step": "Initializing...",
                "mpd": mpd_url[:80],
                "title": title,
                "progress": 0,
                "started": time.strftime('%H:%M:%S'),
            }
            log(f"\n{'='*60}")
            log(f"📥 DOWNLOAD: {title}")
            log(f"  MPD: {mpd_url[:80]}...")
            log(f"  Keys: {len(keys)}")
            log(f"  Cookies: {len(cookies)} chars")
            log(f"  ID: {dl_id}")

            # Start download in background thread
            t = threading.Thread(target=do_download, args=(dl_id, mpd_url, keys, title, cookies), daemon=True)
            t.start()

            self._json(200, {"id": dl_id, "status": "starting"})

        else:
            self._json(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    log(f"Widevine Key Server v5 on http://{HOST}:{PORT}")
    log(f"  Tools: N_m3u8DL-RE = {'OK' if os.path.exists(N_M3U8DL) else 'MISSING'}")
    log(f"  Tools: mp4decrypt  = {'OK' if os.path.exists(MP4DECRYPT) else 'MISSING'}")
    log(f"  POST /challenge       — generate pywidevine challenge")
    log(f"  POST /license         — parse license, extract keys")
    log(f"  POST /download        — download + decrypt video")
    log(f"  GET  /download-status — check download progress")
    log(f"Waiting for requests...")

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Server stopped.")
