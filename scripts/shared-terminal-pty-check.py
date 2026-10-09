"""Test-only PTY driver; executes only supplied local regression fixtures."""
import errno
import json
import os
import pty
import select
import signal
import sys
import time

cases = json.load(sys.stdin)
pid, fd = pty.fork()
if pid == 0:
    os.environ['PS1'] = 'CLOUDSSH_TEST_READY> '
    os.environ['CLOUDSSH_PARENT_TEST'] = 'kept'
    os.execv('/bin/bash', ['bash', '--noprofile', '--norc', '-i'])


def exchange(payload, marker, timeout=12):
    offset = 0
    output = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        readers, writers, _ = select.select([fd], [fd] if offset < len(payload) else [], [], 0.1)
        if fd in writers:
            offset += os.write(fd, payload[offset:offset + 2048])
        if fd in readers:
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    raise RuntimeError('parent PTY closed before completion') from error
                raise
            if not chunk:
                raise RuntimeError('parent PTY closed before completion')
            output.extend(chunk)
            if len(output) > 4 * 1024 * 1024:
                raise RuntimeError('regression fixture exceeded output bound')
        if marker in output and b'CLOUDSSH_TEST_READY> ' in output.split(marker, 1)[1]:
            return bytes(output)
    raise RuntimeError('timed out waiting for command frame and parent prompt')


try:
    exchange(b'', b'')
    results = []
    for case in cases:
        marker = ('\x1b]777;cloudssh-agent-end=' + case['token'] + ';status=').encode()
        output = exchange(case['wrapper'].encode(), marker)
        status = int(output.split(marker, 1)[1].split(b'\x07', 1)[0])
        # The colon/value is not present in the echoed printf command.
        probe = exchange(b"printf 'PARENT_OK:%s\\n' \"$CLOUDSSH_PARENT_TEST\"\r", b'PARENT_OK:kept')
        if b'PARENT_OK:kept' not in probe:
            raise RuntimeError('parent environment changed')
        if status != case['status']:
            raise RuntimeError(f"unexpected status {status}, expected {case['status']}")
        results.append({'status': status, 'parentAlive': True})
    print(json.dumps(results))
finally:
    os.close(fd)
    try:
        os.kill(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
