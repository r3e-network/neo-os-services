"""Explicit pinned native-cross inputs and optional native LinuxKit adapter."""
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath
import stat

ARM_LINUXKIT_SHA256 = '426cb1685ccd35e89b49abd3eb6357494436663606254c37315a8399105ddf16'
ARM_LINUXKIT_BYTES = 43949232
X86_BLOBS = {
    'bzImage': ('210eda749c1308eb60671a579d24db5e8a3477cb7a247cf313c286b09fe2d857', 5083088),
    'bzImage.config': ('9378dea490ed6c698c3d23b346ed08e49dae52d74a59cee2673b8a7b1951fc5b', 79576),
    'cmdline': ('10d7d9dd205d4596d45997d17434f26207525f129d171a51f9859b1af9f4a07a', 120),
    'init': ('755e650b732777b798cb9ec243ee402bef4826f789cf01a1e453bb724207c005', 742968),
    'nsm.ko': ('48904e520db2541ca4378da29d85791749408febc81987ade56cc5c556bd90df', 20504),
}


def verified_file(path, digest, size):
    """Walk without following any symlink; bind hash to bytes actually read."""
    path = Path(path).absolute()
    if '..' in path.parts:
        raise ValueError('input traversal refused')
    parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent); parent = child
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size != size:
                raise ValueError('pinned input size/type mismatch')
            data = stream.read(size + 1)
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('pinned input digest mismatch')
        return data
    finally:
        os.close(parent)


def read_object(cache, entry):
    digest = entry['sha256']
    if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ValueError('invalid pinned digest')
    return verified_file(Path(cache) / 'objects/sha256' / digest, digest, entry['size'])


def cross_inputs(files, cache):
    if cache is None:
        raise ValueError('native-cross requires explicit verified object cache')
    pins = json.loads(files['deploy/nitro/cross-inputs.lock.json'])
    output = {}; sums = []
    for entry in pins['objects']:
        name = entry['path']; parts = PurePosixPath(name).parts
        if (name in output or name.startswith('/') or '..' in parts or
                not re.fullmatch(r'[A-Za-z0-9_+./%:=-]+', name) or str(PurePosixPath(name)) != name or
                len(parts) < 3 or parts[0] != 'cross-inputs' or parts[1] not in ('debs', 'rustlib')):
            raise ValueError('invalid or duplicate cross input path')
        output[name] = read_object(cache, entry)
        sums.append(entry['sha256'] + '  ' + '/'.join(parts[1:]))
    if not output:
        raise ValueError('empty cross inputs')
    output['cross-inputs/SHA256SUMS'] = ('\n'.join(sums)+'\n').encode()
    return output


def adapter_script():
    # The stock CLI only invokes LinuxKit build. Refuse alternative/duplicate
    # architecture arguments so target selection cannot be overridden later.
    return b'''#!/bin/sh
set -eu
[ "${1-}" = build ] || exit 64
shift
for arg do
  case "$arg" in --arch|--arch=*) exit 64;; esac
done
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$here/linuxkit.native" build --arch amd64 "$@"
'''


def native_linuxkit_bundle(native, blobs, output):
    """Build an owned tool bundle; never rewrite an existing blobs directory."""
    data = verified_file(native, ARM_LINUXKIT_SHA256, ARM_LINUXKIT_BYTES)
    inputs = {name: verified_file(Path(blobs)/name, digest, size)
              for name, (digest, size) in X86_BLOBS.items()}
    output = Path(output)
    output.mkdir(mode=0o700)  # must not already exist
    for name, content in {**inputs, 'linuxkit.native': data, 'linuxkit': adapter_script()}.items():
        path = output/name
        with path.open('xb') as stream:
            stream.write(content)
        path.chmod(0o500 if name in ('init', 'linuxkit', 'linuxkit.native') else 0o400)
    return output
