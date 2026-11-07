#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
对战助手 —— 本地服务器
把 web/ 目录（界面）和 data/ 目录（精灵数据）一起用 HTTP 提供出来，
手机连同一个 WiFi 就能打开，不需要装任何东西。
"""
import base64
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, 'web')
# 数据目录：云平台上可以用 POKEASSIST_DATA 指到挂载盘上，数据才不会随重启丢失
DATA = os.environ.get('POKEASSIST_DATA') or os.path.join(ROOT, 'data')
TOOLS = os.path.join(ROOT, 'tools')
def _lan_ips():
    out = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip.startswith('127.') or ip.startswith('169.254.'):
                continue
            if ip not in out:
                out.append(ip)
    except Exception:
        pass
    if not out:
        try:
            s2 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s2.connect(('8.8.8.8', 80))
            ip = s2.getsockname()[0]
            s2.close()
            if ip and not ip.startswith('127.'):
                out.append(ip)
        except Exception:
            pass
    return out


def _public_url():
    try:
        f = os.path.join(DATA, 'share.txt')
        if os.path.exists(f):
            with open(f, encoding='utf-8') as fh:
                return fh.read().strip() or None
    except Exception:
        pass
    return None


def _netinfo():
    port = SERVER_PORT
    return {
        'port': port,
        'lan': ['http://%s:%d/' % (ip, port) for ip in _lan_ips()],
        'local': 'http://127.0.0.1:%d/' % port,
        'public': _public_url(),
        'platform': 'windows' if os.name == 'nt' else 'linux',
        'ocr': os.name == 'nt',
    }


def _build_id():
    """前端代码的版本号：web 目录里文件的最后修改时间。"""
    try:
        files = ['index.html', os.path.join('js', 'app.js'), os.path.join('css', 'style.css')]
        ts = [os.path.getmtime(os.path.join(WEB, f)) for f in files]
        return str(int(max(ts)))
    except OSError:
        return '0'


LIB_FILE = os.path.join(DATA, 'shared.json')
BACKUP_DIR = os.path.join(DATA, 'backups')
DEFAULT_PORT = 8765
LIB_LOCK = threading.Lock()


def _state_load():
    """返回 (lib, gone)。gone 是被删除过的精灵（防止别的设备又推回来）。"""
    try:
        with open(LIB_FILE, 'r', encoding='utf-8') as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return {}, {}
        lib = d.get('lib') if isinstance(d.get('lib'), dict) else d
        gone = d.get('gone') if isinstance(d.get('gone'), dict) else {}
        # 删除标记只保留 2 小时：够同步到其他设备，之后又允许重新录入
        cutoff = time.time() - 7200
        gone = {k: v for k, v in gone.items() if isinstance(v, (int, float)) and v >= cutoff}
        return {k: v for k, v in lib.items() if isinstance(v, dict)}, gone
    except Exception:
        return {}, {}


def _lib_load():
    """所有人共用的精灵配招库（服务端一份，朋友之间自动共享）。"""
    return _state_load()[0]


def _daily_snapshot():
    # 每天留一份数据快照（最多 30 份），防止误删或平台重置
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        day = time.strftime('%Y-%m-%d')
        dst = os.path.join(BACKUP_DIR, 'shared-%s.json' % day)
        if not os.path.exists(dst) and os.path.exists(LIB_FILE):
            shutil.copyfile(LIB_FILE, dst)
            names = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith('shared-') and f.endswith('.json'))
            for old_name in names[:-30]:
                try:
                    os.unlink(os.path.join(BACKUP_DIR, old_name))
                except Exception:
                    pass
    except Exception:
        pass


def _lib_save(lib, gone=None):
    try:
        os.makedirs(os.path.dirname(LIB_FILE), exist_ok=True)
        tmp = LIB_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'lib': lib, 'gone': gone or {}}, f, ensure_ascii=False)
        os.replace(tmp, LIB_FILE)
        _daily_snapshot()
    except Exception as e:
        print('保存共享数据失败:', e, flush=True)


def _lib_merge(incoming, overwrite=()):
    """按「招式更全的那份胜出」合并；overwrite 里的 id 直接以客户端为准。"""
    overwrite = set(overwrite or ())
    added = 0
    with LIB_LOCK:
        lib, gone = _state_load()
        for sid, s in (incoming or {}).items():
            if not isinstance(s, dict) or not isinstance(sid, str):
                continue
            if sid in gone:
                continue
            moves = [m for m in (s.get('moves') or []) if isinstance(m, str)][:6]
            if sid in overwrite:
                lib[sid] = {
                    'speciesId': sid,
                    'moves': moves,
                    'item': s.get('item'),
                    'ability': s.get('ability'),
                    'nature': s.get('nature') or 'hardy',
                }
                gone.pop(sid, None)
                added += 1
                continue
            cur = lib.get(sid) or {}
            cur_moves = cur.get('moves') or []
            better = (not cur) or len(moves) > len(cur_moves) or (
                len(moves) == len(cur_moves) and not cur.get('item') and s.get('item'))
            if better:
                lib[sid] = {
                    'speciesId': sid,
                    'moves': moves,
                    'item': s.get('item'),
                    'ability': s.get('ability'),
                    'nature': s.get('nature') or 'hardy',
                }
                added += 1
        if added:
            _lib_save(lib, gone)
    return added


def _lib_forget(species_id):
    """删掉一只精灵的配招，并记下墓碑，避免别的设备下次同步又把它推回来。"""
    with LIB_LOCK:
        lib, gone = _state_load()
        existed = lib.pop(species_id, None) is not None
        gone[species_id] = int(time.time())
        _lib_save(lib, gone)
        return existed, len(lib)



class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB, **kwargs)

    def translate_path(self, path):
        raw = path.split('?', 1)[0].split('#', 1)[0]
        raw = urllib.parse.unquote(raw)
        if raw.startswith('/data/'):
            rel = raw[len('/data/'):]
            parts = [p for p in rel.split('/') if p not in ('', '.', '..')]
            return os.path.join(DATA, *parts)
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def _json_reply(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?', 1)[0].rstrip('/')
        if path == '/api/version':
            self._json_reply({'v': _build_id()})
            return
        if path == '/api/netinfo':
            self._json_reply(_netinfo())
            return
        if path == '/api/state':
            lib, gone = _state_load()
            self._json_reply({'lib': lib, 'gone': gone})
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split('?', 1)[0].rstrip('/')
        if path == '/api/state':
            try:
                n = int(self.headers.get('Content-Length') or 0)
            except Exception:
                n = 0
            raw = self.rfile.read(n) if n > 0 else b'{}'
            try:
                payload = json.loads(raw.decode('utf-8') or '{}')
            except Exception:
                payload = {}
            added = _lib_merge(payload.get('lib') or {}, payload.get('overwrite') or [])
            self._json_reply({'ok': True, 'added': added, 'count': len(_lib_load())})
            return
        if path == '/api/forget':
            try:
                n = int(self.headers.get('Content-Length') or 0)
            except Exception:
                n = 0
            raw = self.rfile.read(n) if n > 0 else b'{}'
            try:
                payload = json.loads(raw.decode('utf-8') or '{}')
            except Exception:
                payload = {}
            sid = str(payload.get('speciesId') or '').strip()
            if not sid:
                self._json_reply({'ok': False, 'error': '缺少 speciesId'}, 400)
                return
            existed, count = _lib_forget(sid)
            self._json_reply({'ok': True, 'removed': existed, 'count': count})
            return
        if path == '/api/ocr':
            self._handle_ocr()
            return
        self.send_error(404, 'Not Found')

    def _handle_ocr(self):
        if os.name != 'nt':
            self._json_reply({'ok': False, 'error': '这个服务器上没有 Windows 文字识别，识图只能在自己电脑上用。'}, 400)
            return
        """接收一张截图（base64），用 Windows 自带的 OCR 读出文字。"""
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except Exception:
            n = 0
        raw = self.rfile.read(n) if n > 0 else b''
        try:
            payload = json.loads(raw.decode('utf-8') or '{}')
        except Exception:
            self._json_reply({'ok': False, 'error': '请求格式不对'}, 400)
            return

        data = payload.get('image') or ''
        if ',' in data[:64] and data.lstrip().startswith('data:'):
            data = data.split(',', 1)[1]
        try:
            blob = base64.b64decode(data)
        except Exception:
            self._json_reply({'ok': False, 'error': '图片数据坏了'}, 400)
            return

        tmp_in = os.path.join(tempfile.gettempdir(), 'pa_upload_%d.png' % int(time.time() * 1000))
        with open(tmp_in, 'wb') as f:
            f.write(blob)

        started = time.time()
        try:
            code = (
                'import sys, json\n'
                'sys.path.insert(0, r"%s")\n'
                'import ocr\n'
                'print(json.dumps(ocr.recognize(r"%s"), ensure_ascii=False))\n'
            ) % (str(TOOLS), tmp_in)
            env = dict(os.environ)
            env['PYTHONIOENCODING'] = 'utf-8'      # 不设的话子进程会用 GBK 输出，中文就乱码了
            env['PYTHONUTF8'] = '1'
            proc = subprocess.run([sys.executable, '-c', code],
                                  capture_output=True, timeout=180, env=env)
            out = proc.stdout.decode('utf-8', 'replace').strip()
            if not out and proc.stderr:
                raise RuntimeError(proc.stderr.decode('utf-8', 'replace').strip()[-300:])
            lines = json.loads(out) if out else []
            self._json_reply({'ok': True, 'lines': lines,
                              'ms': int((time.time() - started) * 1000)})
        except Exception as e:
            self._json_reply({'ok': False, 'error': '识别失败：%s' % e}, 500)
        finally:
            try:
                os.remove(tmp_in)
            except OSError:
                pass

    def send_head(self):
        # 页面里的任何路径（比如手打错一个字母）都回落到主页面，避免 404
        path = self.translate_path(self.path)
        if not os.path.exists(path) and not os.path.isdir(path):
            base = self.path.split('?', 1)[0]
            ext = os.path.splitext(base)[1].lower()
            if ext not in ('.js', '.css', '.json', '.png', '.jpg', '.svg', '.ico', '.webmanifest'):
                self.path = '/index.html'
        return super().send_head()

    def log_message(self, *args):
        pass


SERVER_PORT = 8765


class Server(http.server.ThreadingHTTPServer):
    # Windows 上 allow_reuse_address 会让两个进程抢同一个端口，这里关掉
    allow_reuse_address = False
    daemon_threads = True


def lan_ip():
    """本机在局域网里的地址（手机要访问的就是这个）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    if ip.startswith('127.'):
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except Exception:
            pass
    return ip


def show_qr(url):
    """尽量弹出一张二维码图片，失败了也不影响使用。"""
    try:
        api = ('https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=8&data='
               + urllib.parse.quote(url, safe=''))
        png = urllib.request.urlopen(api, timeout=8).read()
        path = os.path.join(tempfile.gettempdir(), 'pokeassist_qr.png')
        with open(path, 'wb') as f:
            f.write(png)
        os.startfile(path)  # noqa: 只在 Windows 上有
        return True
    except Exception:
        return False


def _env_port():
    for k in ('PORT', 'POKEASSIST_PORT'):
        v = os.environ.get(k)
        if v:
            try:
                n = int(v)
                if 1 <= n <= 65535:
                    return n
            except ValueError:
                pass
    return None


def main():
    port = _env_port() or DEFAULT_PORT
    for arg in sys.argv[1:]:
        if arg.isdigit():
            port = int(arg)

    _daily_snapshot()
    os.chdir(WEB)
    server = None
    for p in range(port, port + 20):
        try:
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            probe.bind(('0.0.0.0', p))
            probe.close()
        except OSError:
            continue  # 这个端口已经被别的程序占用了
        try:
            global SERVER_PORT
            SERVER_PORT = p
            server = Server(('0.0.0.0', p), Handler)
            port = p
            break
        except OSError:
            continue
    if server is None:
        print('端口都被占用了，请关掉别的程序再试。')
        try:
            if os.name == 'nt':
                input('按回车退出…')
        except Exception:
            pass
        return

    is_win = os.name == 'nt'
    quiet = os.environ.get('POKEASSIST_NO_OPEN') == '1' or '--no-open' in sys.argv
    ip = lan_ip()
    local = f'http://127.0.0.1:{port}/'
    net = f'http://{ip}:{port}/'

    print()
    print('=' * 52)
    print('        ⚔️  对战助手 已启动')
    print('=' * 52)
    print()
    print(f'  电脑上打开：  {local}')
    print(f'  手机上打开：  {net}')
    print()
    if is_win:
        print('  手机和电脑要连同一个 WiFi，然后在手机浏览器')
        print('  里输入上面那个“手机上打开”的网址。')
        print()
        print('  这个黑窗口不要关，关了手机就连不上了。')
        print('  用完直接关掉窗口即可。')
    else:
        print('  这是服务器模式：把上面的地址换成服务器的公网 IP，')
        print('  发给朋友，大家打开同一个网址就能用。')
        print(f'  数据存在 {LIB_FILE}')
    print()
    print(f'  已记住的精灵配招：{len(_lib_load())} 只（所有访问者共用）')
    print()

    print('=' * 52, flush=True)

    if is_win and not quiet:
        # 开浏览器和下载二维码都放到后台线程，免得拖慢启动
        def _after_start():
            time.sleep(0.5)
            try:
                webbrowser.open(local)
            except Exception:
                pass
            if show_qr(net):
                print('  已弹出二维码图片，用手机扫一下也能打开。', flush=True)

        threading.Thread(target=_after_start, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
