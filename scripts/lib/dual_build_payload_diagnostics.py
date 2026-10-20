"""Optional diagnostics of stock unsigned AMD64 EIF v4 bytes; never extracts files.

Supported framing follows pinned aws-nitro-enclaves-image-format 0.8.1. This is
not an EIF admission/boot verifier. Failures only make diagnostics unavailable.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import time
import zlib

SCHEMA = 'neoos/dual-build-payload-diagnostic/v1'
PREFIX = 'BUILD-PAYLOAD-DIAGNOSTIC '
MAX_EIF = 4 * 1024**3
MAX_ENTRIES = 65536
MAX_NAME = 4096
MAX_SECONDS = 60
MAX_FRAME = 8192
MAX_SAMPLES = 8
CHUNK = 1024**2
HEADER = struct.Struct('>4sHHQQHH32Q32QII')
SECTION = struct.Struct('>HHQ')
LABELS = {
    b'rootfs/app/bin/enclave_host': 'enclave_host',
    b'rootfs/app/bin/nitro_init': 'nitro_init',
    b'rootfs/app/config/network-profiles.json': 'network_profiles',
    b'rootfs/app/config/custody/mainnet.json': 'mainnet_profile',
    b'rootfs/app/config/custody/testnet.json': 'testnet_profile',
    b'rootfs/app/config/custody-build-validation.json': 'build_validation',
    b'cmd': 'cmd', b'env': 'env',
}
CATEGORIES = ('added', 'removed', 'content', 'mtime', 'metadata', 'order')


def require(value):
    if not value:
        raise ValueError('unsupported diagnostic input')


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def extend(hasher):
    return hashlib.sha384(bytes(48) + hasher.digest()).hexdigest()


class Reader:
    def __init__(self, stream, size, deadline):
        self.stream, self.size, self.deadline = stream, size, deadline
        self.pos = 0
        self.sha = hashlib.sha256()
        self.crc = 0
        self.section_hashers = []

    def read(self, size, header=False):
        require(type(size) is int and 0 <= size <= CHUNK and self.pos + size <= self.size)
        require(time.monotonic() <= self.deadline)
        data = self.stream.read(size)
        require(len(data) == size)
        self.pos += size
        self.sha.update(data)
        self.crc = zlib.crc32(data[:-4] if header else data, self.crc)
        for hasher in self.section_hashers:
            hasher.update(data)
        return data

    def consume(self, size, zero=False, payload=None):
        while size:
            data = self.read(min(size, CHUNK))
            if zero: require(not any(data))
            if payload is not None: payload.update(data)
            size -= len(data)


def cpio(reader, size):
    start, end = reader.pos, reader.pos + size
    records, occurrences = {}, {}
    order = hashlib.sha256()
    ordinal = 0
    while True:
        require(reader.pos + 110 <= end and ordinal <= MAX_ENTRIES)
        raw = reader.read(110)
        require(raw[:6] == b'070701' and re.fullmatch(b'[0-9a-fA-F]{104}', raw[6:]))
        values = tuple(int(raw[i:i+8], 16) for i in range(6, 110, 8))
        inode, mode, uid, gid, nlink, mtime, length, devmajor, devminor, rdevmajor, rdevminor, namesize, check = values
        require(1 <= namesize <= MAX_NAME and check == 0 and reader.pos + namesize <= end)
        name = reader.read(namesize)
        require(name.endswith(b'\0') and b'\0' not in name[:-1])
        name = name[:-1]
        padding = -(reader.pos-start) % 4
        require(reader.pos + padding <= end); reader.consume(padding, zero=True)
        if name == b'TRAILER!!!':
            require(length == 0)
            # The pinned writer pads the raw newc stream to512, never concatenates.
            require(size % 512 == 0 and end-reader.pos < 512)
            reader.consume(end-reader.pos, zero=True)
            break
        require(ordinal < MAX_ENTRIES and name and not name.startswith(b'/') and b'..' not in name.split(b'/'))
        require((mode & 0o170000) in (0o100000, 0o120000, 0o040000, 0o020000, 0o060000, 0o010000))
        require(nlink > 0 and reader.pos + length <= end)
        if (mode & 0o170000) not in (0o100000, 0o120000): require(length == 0)
        payload = hashlib.sha256(); reader.consume(length, payload=payload)
        padding = -(reader.pos-start) % 4
        require(reader.pos + padding <= end); reader.consume(padding, zero=True)
        name_hash = hashlib.sha256(name).hexdigest()
        occurrence = occurrences.get(name_hash, 0); occurrences[name_hash] = occurrence + 1
        key = (name_hash, occurrence)
        # Inode is assigned by serialization order; keep it separate from other metadata.
        metadata = (mode, uid, gid, nlink, devmajor, devminor, rdevmajor, rdevminor)
        records[key] = (payload.hexdigest(), length, mtime, metadata, ordinal, inode, LABELS.get(name, 'other'))
        order.update(encoded([name_hash, occurrence, inode]))
        ordinal += 1
    payloads, metadata_hash = hashlib.sha256(), hashlib.sha256()
    for key, record in sorted(records.items()):
        require(time.monotonic() <= reader.deadline)
        payloads.update(encoded([*key, record[0], record[1]]))
        metadata_hash.update(encoded([*key, record[2], record[3]]))
    return records, {'entries': ordinal, 'order_sha256': order.hexdigest(),
                     'payload_sha256': payloads.hexdigest(), 'metadata_sha256': metadata_hash.hexdigest()}


def inspect_eif(path, pcrs, eif_sha256):
    """Stream exact file once; bind section payloads to CRC, EIF SHA and all3PCRs."""
    deadline = time.monotonic() + MAX_SECONDS
    path = Path(path)
    require(path.absolute() == path.resolve(strict=True))
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and HEADER.size <= before.st_size <= MAX_EIF)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        initial = os.fstat(stream.fileno())
        require(stat.S_ISREG(initial.st_mode) and (initial.st_dev, initial.st_ino, initial.st_size) == (before.st_dev, before.st_ino, before.st_size))
        reader = Reader(stream, initial.st_size, deadline)
        header = HEADER.unpack(reader.read(HEADER.size, header=True))
        magic, version, flags, _, _, reserved, count = header[:7]
        offsets, sizes, unused, crc = header[7:39], header[39:71], header[71], header[72]
        require(magic == b'.eif' and version == 4 and flags == 0 and reserved == unused == 0 and count == 5)
        require(not any(offsets[5:]) and not any(sizes[5:]))
        measurements = [hashlib.sha384() for _ in range(3)]
        sections = {}; records = {}; summary = None
        for index, (kind, label) in enumerate(((1,'kernel'),(2,'cmdline'),(5,'identity'),(3,'bootstrap'),(3,'customer'))):
            require(offsets[index] == reader.pos)
            actual, section_flags, size = SECTION.unpack(reader.read(SECTION.size))
            require(actual == kind and section_flags == 0 and size == sizes[index] and size <= reader.size-reader.pos)
            section_hash = hashlib.sha256()
            hashers = [section_hash]
            if label != 'identity':
                hashers += [measurements[0], measurements[2] if label == 'customer' else measurements[1]]
            reader.section_hashers = hashers
            if label == 'customer': records, summary = cpio(reader, size)
            else: reader.consume(size)
            reader.section_hashers = []
            if label != 'identity': sections[label] = {'bytes':size,'sha256':section_hash.hexdigest()}
        require(reader.pos == reader.size and reader.crc == crc and reader.sha.hexdigest() == eif_sha256)
        require({key:extend(value) for key,value in zip(('PCR0','PCR1','PCR2'),measurements)} == pcrs)
        end, current = os.fstat(stream.fileno()), path.lstat()
        fingerprint = lambda value: (value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
        require(fingerprint(initial) == fingerprint(end) == fingerprint(current) and stat.S_ISREG(current.st_mode))
        require(time.monotonic() <= deadline)
    return {'public': {'eif_sha256':eif_sha256,'sections':sections,'cpio':summary}, 'records':records}


def capture(path, pcrs, eif_sha256):
    try:
        return inspect_eif(path, pcrs, eif_sha256)
    except InterruptedError:
        raise
    except Exception:
        # Optional observation must not replace the original build/measurement outcome.
        # Signals/KeyboardInterrupt remain cancellation, not diagnostic unavailability.
        return None


def compare(first, second):
    if first is None or second is None:
        return {'schema':SCHEMA,'status':'unavailable'}
    deadline = time.monotonic() + MAX_SECONDS
    left, right = first['records'], second['records']
    counts = dict.fromkeys(CATEGORIES, 0); samples = []
    for key in sorted(left.keys() | right.keys()):
        require(time.monotonic() <= deadline)
        a, b = left.get(key), right.get(key)
        changed = []
        if a is None: changed.append('added')
        elif b is None: changed.append('removed')
        else:
            if a[:2] != b[:2]: changed.append('content')
            if a[2] != b[2]: changed.append('mtime')
            if a[3] != b[3]: changed.append('metadata')
            if a[4:6] != b[4:6]: changed.append('order')
        for kind in changed: counts[kind] += 1
        if changed and len(samples) < MAX_SAMPLES:
            samples.append({'path_sha256':key[0], 'occurrence':key[1], 'label':(a or b)[6], 'changes':changed})
    result = {'schema':SCHEMA,'status':'complete','attempts':[first['public'],second['public']],
              'comparison':{'counts':counts,'samples':samples,
                            'unclassified_customer_bytes': not any(counts.values()) and first['public']['sections']['customer'] != second['public']['sections']['customer']}}
    require(len(encoded(result)) <= MAX_FRAME)
    return result


def frame(captures):
    try:
        value = compare(*captures)
        return PREFIX + encoded(value).decode()
    except InterruptedError:
        raise
    except Exception:
        return PREFIX + encoded({'schema':SCHEMA,'status':'unavailable'}).decode()


def validate(value, builds):
    """Validate only bounded public shape/bindings, never import private entries."""
    require(type(value) is dict and value.get('schema') == SCHEMA)
    if value.get('status') == 'unavailable':
        require(set(value) == {'schema','status'})
        return None
    require(set(value) == {'schema','status','attempts','comparison'} and value['status'] == 'complete')
    attempts = value['attempts']
    require(type(attempts) is list and len(attempts) == 2)
    def digest(item): require(type(item) is str and re.fullmatch('[0-9a-f]{64}',item))
    def integer(item, maximum): require(type(item) is int and 0 <= item <= maximum)
    for index, item in enumerate(attempts):
        require(type(item) is dict and set(item) == {'eif_sha256','sections','cpio'})
        digest(item['eif_sha256']); require(item['eif_sha256'] == builds[index]['eif_sha256'])
        sections = item['sections']
        require(type(sections) is dict and set(sections) == {'kernel','cmdline','bootstrap','customer'})
        for name, section in sections.items():
            require(type(section) is dict and set(section) == {'bytes','sha256'})
            integer(section['bytes'],MAX_EIF);digest(section['sha256'])
            require(name == 'cmdline' or section['bytes'] > 0)
        c = item['cpio']
        require(type(c) is dict and set(c) == {'entries','order_sha256','payload_sha256','metadata_sha256'})
        integer(c['entries'],MAX_ENTRIES)
        for key in ('order_sha256','payload_sha256','metadata_sha256'): digest(c[key])
    comparison = value['comparison']
    require(type(comparison) is dict and set(comparison) == {'counts','samples','unclassified_customer_bytes'})
    counts, samples = comparison['counts'], comparison['samples']
    require(type(counts) is dict and set(counts) == set(CATEGORIES))
    for key,count in counts.items():
        maximum = attempts[1]['cpio']['entries'] if key == 'added' else attempts[0]['cpio']['entries'] if key == 'removed' else min(x['cpio']['entries'] for x in attempts)
        integer(count,maximum)
    require(attempts[0]['cpio']['entries']-counts['removed']+counts['added'] == attempts[1]['cpio']['entries'])
    require(type(samples) is list and len(samples) <= MAX_SAMPLES)
    keys=[];seen_counts=dict.fromkeys(CATEGORIES,0)
    labels={v:hashlib.sha256(k).hexdigest() for k,v in LABELS.items()}
    for sample in samples:
        require(type(sample) is dict and set(sample) == {'path_sha256','occurrence','label','changes'})
        digest(sample['path_sha256']);integer(sample['occurrence'],MAX_ENTRIES-1)
        label = sample['label'];require(type(label) is str and label in {*labels,'other'})
        require(sample['path_sha256'] == labels[label] if label != 'other' else sample['path_sha256'] not in labels.values())
        changes=sample['changes']
        require(type(changes) is list and changes and changes == [x for x in CATEGORIES if x in changes])
        require(not ('added' in changes or 'removed' in changes) or changes in (['added'],['removed']))
        for change in changes:seen_counts[change]+=1
        keys.append((sample['path_sha256'],sample['occurrence']))
    require(keys == sorted(set(keys)))
    require(all(seen_counts[k] <= counts[k] for k in CATEGORIES))
    require(bool(samples) == bool(any(counts.values())))
    unexplained = comparison['unclassified_customer_bytes']
    require(type(unexplained) is bool and unexplained == (not any(counts.values()) and attempts[0]['sections']['customer'] != attempts[1]['sections']['customer']))
    return value
