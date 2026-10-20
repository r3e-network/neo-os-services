"""Offline EIF/newc fixtures; never execute payload bytes or external build tools."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[2]

def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


def newc(entries):
    result = bytearray()
    for index, entry in enumerate([*entries, {'name': b'TRAILER!!!', 'data': b'', 'mode': 0}]):
        name = entry['name']; data = entry.get('data', b'')
        fields = [721+index, entry.get('mode', 0o100644), entry.get('uid', 0), entry.get('gid', 0),
                  1, entry.get('mtime', 1492533000), len(data), 3, 1, 0, 0, len(name)+1, 0]
        result += b'070701'+''.join('%08x'%x for x in fields).encode()+name+b'\0'
        result += b'\0'*(-len(result)%4); result += data; result += b'\0'*(-len(result)%4)
    result += b'\0'*(-len(result)%512)
    return bytes(result)


def eif_fixture(entries, bootstrap=b'bootstrap', metadata=b'{}'):
    customer = newc(entries)
    parts = [(1,b'kernel'),(2,b'cmdline'),(5,metadata),(3,bootstrap),(3,customer)]
    offsets=[];sizes=[];body=b''
    for kind,data in parts:
        offsets.append(548+len(body));sizes.append(len(data));body+=struct.pack('>HHQ',kind,0,len(data))+data
    header=struct.pack('>4sHHQQHH32Q32QII',b'.eif',4,0,1024**3,2,0,5,
                       *(offsets+[0]*27),*(sizes+[0]*27),0,0)
    crc=zlib.crc32(body,zlib.crc32(header[:-4]));raw=header[:-4]+struct.pack('>I',crc)+body
    def pcr(data):return hashlib.sha384(bytes(48)+hashlib.sha384(data).digest()).hexdigest()
    return raw,{'PCR0':pcr(b'kernelcmdline'+bootstrap+customer),'PCR1':pcr(b'kernelcmdline'+bootstrap),'PCR2':pcr(customer)}


class Integration(unittest.TestCase):
    def test_actual_two_build_measurement_refusal_has_payload_comparison(self):
        fixture=module(ROOT/'deploy/nitro/dual_image_test.py','payload_stock_fixture')
        f=fixture.Packaging();f.setUp();self.addCleanup(f.doCleanups)
        base=[{'name':b'rootfs/app/bin/enclave_host','data':b'binary-one'},
              {'name':b'PRIVATE_PATH_CANARY','data':b'PRIVATE_CONTENT_CANARY','mtime':1}]
        changed=[{**base[0],'data':b'binary-two'},{**base[1],'mtime':2}]
        def measurements(_):
            attempt=2 if (f.root/'build-2.eif').exists() else 1
            if attempt==2:
                # The retained observation must already be detached from overwritten files.
                (f.root/'build-1.eif').write_bytes(b'overwritten after first capture')
            raw,pcrs=eif_fixture(base if attempt==1 else changed)
            (f.root/f'build-{attempt}.eif').write_bytes(raw)
            return pcrs
        output=io.StringIO()
        with patch.object(fixture.dual,'measurements',side_effect=measurements),contextlib.redirect_stderr(output):
            with self.assertRaisesRegex(ValueError,'not reproducible'):f.simulate()
        lines=[x for x in output.getvalue().splitlines() if x.startswith('BUILD-PAYLOAD-DIAGNOSTIC ')]
        self.assertEqual(len(lines),1,'measurement refusal loses actual EIF payload comparison')
        value=json.loads(lines[0].split(' ',1)[1])
        self.assertEqual(value['status'],'complete')
        self.assertEqual(value['comparison']['counts']['content'],1)
        self.assertEqual(value['comparison']['counts']['mtime'],1)
        self.assertFalse((f.root/'result').exists())
        self.assertNotIn('PRIVATE_PATH_CANARY',json.dumps(value));self.assertNotIn('PRIVATE_CONTENT_CANARY',json.dumps(value))
        self.assertEqual(fixture.dual.DIAGNOSTIC['primary']['stage'],'measurements')
        self.assertEqual(len([a for a in f.calls if 'build-enclave' in a]),2)


    def test_equal_measured_payload_keeps_existing_success_despite_identity_changes(self):
        fixture=module(ROOT/'deploy/nitro/dual_image_test.py','payload_success_fixture')
        f=fixture.Packaging();f.setUp();self.addCleanup(f.doCleanups)
        def measurements(_):
            attempt=2 if (f.root/'build-2.eif').exists() else 1
            raw,pcrs=eif_fixture([{'name':b'cmd','data':b'PRIVATE_CMD_CANARY'}],metadata=str(attempt).encode())
            (f.root/f'build-{attempt}.eif').write_bytes(raw)
            return pcrs
        output=io.StringIO()
        with patch.object(fixture.dual,'measurements',side_effect=measurements),contextlib.redirect_stderr(output):
            result,_=f.simulate()
        self.assertTrue(result['reproducible_verified'])
        self.assertTrue((f.root/'result').exists())
        value=json.loads(next(x for x in output.getvalue().splitlines() if x.startswith('BUILD-PAYLOAD-DIAGNOSTIC ')).split(' ',1)[1])
        self.assertEqual(value['status'],'complete')
        self.assertFalse(any(value['comparison']['counts'].values()))
        self.assertNotEqual(*[x['eif_sha256'] for x in value['attempts']])
        self.assertNotIn('PRIVATE_CMD_CANARY',json.dumps(value))

    def test_unavailable_or_missing_helper_never_changes_original_outcome(self):
        for missing in (False,True):
            for refusal in (False,True):
                with self.subTest(missing=missing,refusal=refusal):
                    fixture=module(ROOT/'deploy/nitro/dual_image_test.py','payload_unavailable_fixture')
                    f=fixture.Packaging();f.setUp();self.addCleanup(f.doCleanups)
                    output=io.StringIO()
                    with contextlib.ExitStack() as stack:
                        stack.enter_context(contextlib.redirect_stderr(output))
                        if missing:stack.enter_context(patch.object(fixture.dual,'payload_diagnostics',side_effect=OSError('PRIVATE_CANARY')))
                        if refusal:
                            with self.assertRaisesRegex(ValueError,'not reproducible'):f.simulate('repro')
                            self.assertEqual(fixture.dual.DIAGNOSTIC['primary']['stage'],'measurements')
                            self.assertFalse((f.root/'result').exists())
                        else:
                            result,_=f.simulate();self.assertTrue(result['reproducible_verified'])
                    lines=[x for x in output.getvalue().splitlines() if x.startswith('BUILD-PAYLOAD-DIAGNOSTIC ')]
                    self.assertEqual(len(lines),0 if missing else 1)
                    if lines:self.assertEqual(json.loads(lines[0].split(' ',1)[1])['status'],'unavailable')
                    self.assertNotIn('PRIVATE_CANARY',output.getvalue())


class Payload(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.d=module(ROOT/'scripts/lib/dual_build_payload_diagnostics.py','payload_reader')
        self.entries=[{'name':b'rootfs/app/bin/enclave_host','data':b'binary'},
                      {'name':b'UNKNOWN_NAME_CANARY','data':b'SECRET_VALUE_CANARY','mtime':10}]

    def capture(self, entries=None, raw=None, pcrs=None, **kwargs):
        generated, measured=eif_fixture(self.entries if entries is None else entries,**kwargs)
        raw=generated if raw is None else raw
        path=self.root/'sample.eif';path.write_bytes(raw)
        return self.d.capture(path, measured if pcrs is None else pcrs,hashlib.sha256(raw).hexdigest())

    def test_eif_bound_public_sections_and_identity_exclusion(self):
        a=self.capture();b=self.capture(metadata=b'{"Created":"DIFFERENT_CANARY"}')
        self.assertIsNotNone(a);self.assertIsNotNone(b)
        self.assertEqual(a['public']['sections'],b['public']['sections'])
        self.assertNotEqual(a['public']['eif_sha256'],b['public']['eif_sha256'])
        self.assertEqual(a['public']['cpio'],b['public']['cpio'])
        text=self.d.frame([a,b]);self.assertNotIn('CANARY',text)
        value=json.loads(text.split(' ',1)[1]);self.assertEqual(value['comparison']['counts'],dict.fromkeys(self.d.CATEGORIES,0))
        self.assertFalse(value['comparison']['unclassified_customer_bytes'])

    def test_pcr_crc_sha_and_stable_file_are_independent_bindings(self):
        raw,pcr=eif_fixture(self.entries);path=self.root/'sample.eif';path.write_bytes(raw)
        for key in pcr:
            self.assertIsNone(self.d.capture(path,{**pcr,key:'0'*96},hashlib.sha256(raw).hexdigest()))
        self.assertIsNone(self.d.capture(path,pcr,'0'*64))
        bad=bytearray(raw);bad[544]^=1
        self.assertIsNone(self.capture(raw=bytes(bad)))
        # Restore valid bytes so only the post-read identity check rejects this case.
        path.write_bytes(raw)
        real_stat=self.d.os.fstat
        def swapped(fd):
            result=real_stat(fd)
            if getattr(swapped,'called',False):
                other=self.root/'other';other.write_bytes(raw)
                return other.stat()
            swapped.called=True;return result
        with patch.object(self.d.os,'fstat',side_effect=swapped):
            self.assertIsNone(self.d.capture(path,pcr,hashlib.sha256(raw).hexdigest()))

    def test_eif_framing_rejections_with_repaired_crc(self):
        raw,pcr=eif_fixture(self.entries)
        def crc(value):return value[:544]+struct.pack('>I',zlib.crc32(value[548:],zlib.crc32(value[:544])))+value[548:]
        bad=[]
        for offset,fmt,value in [(0,'4s',b'NOPE'),(4,'H',3),(6,'H',1),(24,'H',1),(26,'H',6),
                                  (28,'Q',549),(28+5*8,'Q',1),(284,'Q',999999),(284+5*8,'Q',1),
                                  (540,'I',1),(548,'H',3),(550,'H',1),(552,'Q',2**63)]:
            b=bytearray(raw);struct.pack_into('>'+fmt,b,offset,value);bad.append(crc(bytes(b)))
        bad += [raw[:-1],raw+b'\0',raw[:100]]
        for index,value in enumerate(bad):
            with self.subTest(index=index):self.assertIsNone(self.capture(raw=value,pcrs=pcr))

    def test_cpio_content_mtime_metadata_order_add_remove_duplicate(self):
        a=self.capture()
        cases={
            'content':[{**self.entries[0],'data':b'changed'},self.entries[1]],
            'mtime':[self.entries[0],{**self.entries[1],'mtime':11}],
            'metadata':[{**self.entries[0],'mode':0o100600},self.entries[1]],
            'order':list(reversed(self.entries)),
            'added':self.entries+[{'name':b'extra','data':b'x'}],
            'removed':self.entries[:1],
        }
        for kind,entries in cases.items():
            with self.subTest(kind=kind):
                b=self.capture(entries);self.assertIsNotNone(b)
                value=self.d.compare(a,b);self.assertGreater(value['comparison']['counts'][kind],0)
                self.assertNotIn('CANARY',json.dumps(value))
                self.d.validate(value,[a['public'],b['public']])
        duplicate=self.entries+[dict(self.entries[0])]
        a=self.capture(duplicate);changed=[*duplicate[:2],{**duplicate[2],'data':b'last'}];b=self.capture(changed)
        value=self.d.compare(a,b)
        self.assertEqual(value['comparison']['counts']['content'],1)
        self.assertEqual(value['comparison']['samples'][0]['occurrence'],1)
        self.assertEqual(value['comparison']['samples'][0]['label'],'enclave_host')

    def test_cpio_symlink_body_and_special_files_not_extracted(self):
        entries=[{'name':b'link','mode':0o120777,'data':b'PRIVATE_LINK_CANARY'},
                 {'name':b'dir','mode':0o040755},{'name':b'dev','mode':0o020600}]
        a=self.capture(entries);self.assertIsNotNone(a)
        b=self.capture([{**entries[0],'data':b'other'},*entries[1:]])
        self.assertEqual(self.d.compare(a,b)['comparison']['counts']['content'],1)
        self.assertEqual(set(x.name for x in self.root.iterdir()),{'sample.eif'})
        self.assertNotIn('PRIVATE_LINK_CANARY',self.d.frame([a,b]))

    def test_cpio_malformed_names_types_trailer_padding_refuse(self):
        for entry in [{'name':b'/absolute'}, {'name':b'../escape'}, {'name':b'embedded\0name'},
                      {'name':b''},{'name':b'a'*4096},{'name':b'unknown','mode':0o140000},
                      {'name':b'directory','mode':0o040755,'data':b'not-empty'}]:
            with self.subTest(entry=entry):self.assertIsNone(self.capture([entry]))
        raw,pcr=eif_fixture(self.entries)
        start=raw.index(b'070701')
        for offset,value in [(start,ord('1')),(start+6,ord('g')),(start+102,ord('1')),
                             (len(raw)-1,1)]:
            bad=bytearray(raw);bad[offset]=value
            # Invalid CPIO must fail even when outer file SHA/CRC are made consistent.
            bad[544:548]=struct.pack('>I',zlib.crc32(bad[548:],zlib.crc32(bad[:544])))
            self.assertIsNone(self.capture(raw=bytes(bad),pcrs=pcr))

    def test_file_kind_size_count_time_and_output_bounds(self):
        raw,pcr=eif_fixture(self.entries);path=self.root/'regular';path.write_bytes(raw)
        symlink=self.root/'link';symlink.symlink_to(path)
        fifo=self.root/'fifo';os.mkfifo(fifo)
        for target in (symlink,fifo,self.root,self.root/'missing'):
            self.assertIsNone(self.d.capture(target,pcr,hashlib.sha256(raw).hexdigest()))
        with patch.object(self.d,'MAX_EIF',len(raw)-1):self.assertIsNone(self.d.capture(path,pcr,hashlib.sha256(raw).hexdigest()))
        with patch.object(self.d,'MAX_ENTRIES',1):self.assertIsNone(self.capture())
        with patch.object(self.d,'MAX_SECONDS',-1):self.assertIsNone(self.capture())
        with patch.object(self.d.os,'open',side_effect=PermissionError('PRIVATE_CANARY')):
            self.assertIsNone(self.d.capture(path,pcr,hashlib.sha256(raw).hexdigest()))
        with patch.object(self.d.os,'open',side_effect=InterruptedError('cancel')):
            with self.assertRaises(InterruptedError):self.d.capture(path,pcr,hashlib.sha256(raw).hexdigest())
        a=self.capture();b=self.capture([{'name':b'changed','data':b'x'}])
        with patch.object(self.d,'MAX_FRAME',10):
            self.assertEqual(json.loads(self.d.frame([a,b]).split(' ',1)[1])['status'],'unavailable')
        with patch.object(self.d,'MAX_SECONDS',-1):
            self.assertEqual(json.loads(self.d.frame([a,b]).split(' ',1)[1])['status'],'unavailable')

    def test_sample_cap_hash_only_unknown_names_and_nonmutating_manifest(self):
        left=[{'name':('PRIVATE_CANARY_'+str(i)).encode(),'data':b'old'} for i in range(20)]
        right=[{**x,'data':b'new'} for x in left]
        a=self.capture(left);b=self.capture(right);value=self.d.compare(a,b)
        self.assertEqual(value['comparison']['counts']['content'],20)
        self.assertEqual(len(value['comparison']['samples']),8)
        self.assertTrue(all(x['label']=='other' for x in value['comparison']['samples']))
        self.assertNotIn('PRIVATE_CANARY',json.dumps(value))
        self.assertLess(len(self.d.frame([a,b])),8192)
        self.d.validate(value,[a['public'],b['public']])
        self.assertEqual(len(a['records']),20)

    def test_malformed_observation_is_optional_not_success(self):
        a=self.capture();self.assertEqual(self.d.compare(a,None),{'schema':self.d.SCHEMA,'status':'unavailable'})
        self.assertEqual(json.loads(self.d.frame([{},a]).split(' ',1)[1])['status'],'unavailable')

    def test_raw_serialization_diff_without_entry_semantic_diff_is_visible(self):
        raw,pcr=eif_fixture(self.entries)
        # A different trailer inode changes measured bytes without changing file entries.
        pos=raw.index(b'TRAILER!!!')-110+6
        changed=bytearray(raw);changed[pos:pos+8]=b'00009999'
        changed[544:548]=struct.pack('>I',zlib.crc32(changed[548:],zlib.crc32(changed[:544])))
        h=self.d.HEADER.unpack(changed[:548]);customer=bytes(changed[h[11]+12:])
        def pcr_extend(data):return hashlib.sha384(bytes(48)+hashlib.sha384(data).digest()).hexdigest()
        measured={**pcr,'PCR2':pcr_extend(customer),'PCR0':pcr_extend(b'kernelcmdlinebootstrap'+customer)}
        a=self.capture();b=self.capture(raw=bytes(changed),pcrs=measured);self.assertIsNotNone(b)
        value=self.d.compare(a,b);self.assertTrue(value['comparison']['unclassified_customer_bytes'])
        self.assertFalse(any(value['comparison']['counts'].values()))


if __name__=='__main__':unittest.main()
