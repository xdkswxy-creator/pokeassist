#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键公网分享：在本机跑助手 + 开一条公网隧道，
得到一个别人能打开的网址（不用注册、不用付钱、不用下载东西）。

优先用 Windows 自带的 ssh 连 localhost.run（零下载）。
如果以后再放一个 tools/cloudflared.exe，会自动优先用它，更稳。

用法：双击「启动并分享.bat」，或 python share.py
"""
import os
import re
import sys
import time
import socket
import shutil
import subprocess
import threading
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT / 'tools'
CF = TOOLS / 'cloudflared.exe'
SSH = r'C:\Windows\System32\OpenSSH\ssh.exe'
LINE = '=' * 58
QUIET = os.environ.get('POKEASSIST_NO_OPEN') == '1'

URL_CF = re.compile(r'https://[-a-z0-9]+\.trycloudflare\.com')
URL_LR = re.compile(r'https://[-a-z0-9]+\.lhr\.life')


def say(msg=''):
    print(msg, flush=True)


def free_port(start=8765):
    for p in range(start, start + 30):
        s = socket.socket()
        try:
            s.bind(('127.0.0.1', p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    return start


def wait_port(port, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.5):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def copy_clip(text):
    try:
        p = subprocess.Popen('clip', stdin=subprocess.PIPE, shell=True)
        p.communicate(text.encode('utf-16-le'))
    except Exception:
        pass


def start_tunnel(port):
    """返回 (进程, 公网网址, 说明)；失败时进程为 None。"""
    # 1) 本机已经有 cloudflared 就用它（更稳、不会被限时）
    if CF.exists():
        say('   用 Cloudflare 隧道…')
        p = subprocess.Popen([str(CF), 'tunnel', '--url', 'http://127.0.0.1:%d' % port,
                              '--no-autoupdate'],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             cwd=str(TOOLS), bufsize=1, universal_newlines=True,
                             encoding='utf-8', errors='replace')
        url = _scan(p, URL_CF, 60)
        if url:
            return p, url, 'cloudflare'
        p.kill()
        say('   Cloudflare 没连上，换成备用方式…')

    # 2) 用系统自带的 ssh + localhost.run（不用下载任何东西）
    ssh = SSH if Path(SSH).exists() else shutil.which('ssh')
    if not ssh:
        return None, None, '没有找到 ssh（Windows 10 以后一般都有）'
    say('   用本机 ssh 开隧道…')
    cmd = [ssh,
           '-o', 'StrictHostKeyChecking=no',
           '-o', 'UserKnownHostsFile=NUL',
           '-o', 'BatchMode=yes',
           '-o', 'ExitOnForwardFailure=yes',
           '-o', 'ServerAliveInterval=30',
           '-R', '80:127.0.0.1:%d' % port,
           'nokey@localhost.run']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         bufsize=1, universal_newlines=True,
                         encoding='utf-8', errors='replace')
    url = _scan(p, URL_LR, 60)
    if url:
        return p, url, 'localhost.run'
    p.kill()
    return None, None, '隧道没连上（可能是网络限制了 ssh 出站）'


def _scan(p, rx, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if p.poll() is not None:
            return None
        line = p.stdout.readline()
        if not line:
            continue
        m = rx.search(line)
        if m:
            return m.group(0)
    return None


def main():
    port = free_port()
    env = dict(os.environ, PYTHONIOENCODING='utf-8', POKEASSIST_NO_OPEN='1')
    say(LINE)
    say('   1/2  启动助手（本机服务）…')
    say(LINE)
    srv = subprocess.Popen([sys.executable, '-u', str(ROOT / 'server.py'), str(port)],
                           cwd=str(ROOT), env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    if not wait_port(port):
        say('   本机服务没起来，端口可能被占用。关掉重试一次。')
        srv.kill()
        return 1
    say('   本机也能用：http://127.0.0.1:%d/' % port)
    say()
    say(LINE)
    say('   2/2  申请公网网址（大概 5~20 秒）…')
    say(LINE)

    tun, url, how = start_tunnel(port)
    if not url:
        say()
        say('   ❌ %s' % how)
        say('   先在本机和手机同 WiFi 下用「启动助手.bat」也能玩。')
        say('   想彻底解决，可以用「租服务器」的方式（见 deploy.md）。')
        srv.kill()
        try:
            input('按回车退出…')
        except Exception:
            pass
        return 1

    # 让网页里的「分享」面板也能看到当前公网网址
    try:
        (ROOT / 'data' / 'share.txt').write_text(url, encoding='utf-8')
    except Exception:
        pass
    copy_clip(url)
    say()
    say(LINE)
    say('   ✅  公网网址已生成（已复制到剪贴板）')
    say()
    say('   ' + url)
    say()
    say('   把网址发给朋友，手机、电脑都能打开；')
    say('   大家的数据是同一份（存在这台电脑上）。')
    say()
    say('   ⚠️  这个窗口和电脑别关，关了别人就打不开。')
    say('   ⚠️  网址每次启动都会变，重开就发新的。')
    say(LINE)
    say()
    if not QUIET:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    def drain():
        try:
            for _ in tun.stdout:
                pass
        except Exception:
            pass
    threading.Thread(target=drain, daemon=True).start()

    try:
        while True:
            if tun.poll() is not None:
                say('公网通道断开了（免费通道有时会断），重新打开这个窗口就能恢复。')
                break
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            (ROOT / 'data' / 'share.txt').unlink()
        except Exception:
            pass
        for p in (tun, srv):
            try:
                p.kill()
            except Exception:
                pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
