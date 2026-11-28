#!/usr/bin/env python3
"""Receive one verified Windows offline installer over an SSH forced command."""
import hashlib
import os
import re
import stat
import sys
import tempfile

NUM = r'(?:0|[1-9][0-9]*)'
IDENT = r'(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
SEMVER = rf'v{NUM}\.{NUM}\.{NUM}(?:-{IDENT}(?:\.{IDENT})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?'
COMMAND = re.compile(rf'publish ({SEMVER}) ([0-9a-f]{{64}}) ([1-9][0-9]*)\Z', re.ASCII)
NAME = 'Jiangjie-Setup-Offline-x64.exe'


def digest_file(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('existing target is not a regular file')
        digest = hashlib.sha256()
        size = 0
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            size += len(chunk)
            digest.update(chunk)
        return size, digest.hexdigest()


def receive(public_root, staging_root, command, source):
    match = COMMAND.fullmatch(command)
    if not match:
        raise ValueError('invalid SSH_ORIGINAL_COMMAND')
    tag, expected_hash, size_text = match.groups()
    expected_size = int(size_text)
    fd, temporary = tempfile.mkstemp(prefix='.win-offline-', dir=staging_root)
    try:
        digest = hashlib.sha256()
        remaining = expected_size
        with os.fdopen(fd, 'wb') as output:
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError('input shorter than declared size')
                output.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
            if source.read(1):
                raise ValueError('input longer than declared size')
            if digest.hexdigest() != expected_hash:
                raise ValueError('SHA-256 mismatch')
            output.flush()
            os.fchmod(output.fileno(), 0o644)
        version_dir = os.path.join(public_root, tag)
        try:
            os.mkdir(version_dir, 0o755)
        except FileExistsError:
            if not os.path.isdir(version_dir) or os.path.islink(version_dir):
                raise ValueError('version path is not a directory')
        else:
            os.chmod(version_dir, 0o755)
        target = os.path.join(version_dir, NAME)
        try:
            os.link(temporary, target)
        except FileExistsError:
            if digest_file(target) != (expected_size, expected_hash):
                raise ValueError('version already exists with different content')
            return 'already published'
        return 'published'
    finally:
        os.unlink(temporary)


def main():
    if len(sys.argv) != 3:
        print('usage: receive-win-offline.py PUBLIC_ROOT STAGING_ROOT', file=sys.stderr)
        return 2
    try:
        result = receive(sys.argv[1], sys.argv[2], os.environ.get('SSH_ORIGINAL_COMMAND', ''), sys.stdin.buffer)
    except (OSError, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1
    print(result)
    return 0


if __name__ == '__main__':
    sys.exit(main())
