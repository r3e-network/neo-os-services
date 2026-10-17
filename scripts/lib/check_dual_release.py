"""Supplemental source prerequisite; never an admission/publication authorization."""
import argparse
import json
from pathlib import Path
import re
import sys
import subprocess

from dual_release_validation import (APPS, NETWORKS, SOURCE_FILES, RECIPE_FILES, affected,
                                     encoded, inventory, parse, require, sha, validate_bundle)
from dual_release_provenance import Capture


def audit(capture):
    files = capture.files
    errors = []
    checks = []
    def error(code, message):
        errors.append({'code': code, 'message': message})
    touched = [c for c in capture.changes if affected(c['path'])]
    manifest_paths = [n for n in files if n.startswith('deploy/nitro/measurements/') and n.endswith('.json')
                      and n.rsplit('/', 1)[-1] not in ('manifest.schema.json', 'example.json')]
    dual = []
    malformed = []
    for name in manifest_paths:
        try:
            raw = parse(files[name][1])
            if 'schema' in raw or 'app_ids' in raw or 'networks' in raw:
                dual.append((name, raw))
        except (ValueError, AttributeError):
            malformed.append(name)
            error('MANIFEST_JSON_INVALID', name)
    fresh = [item for item in dual if any(c['path'] == item[0] and c['status'] == 'A' for c in capture.changes)]
    # A present malformed/stale dual record cannot be relabelled as absent.
    malformed_added = any(c['path'] in malformed and c['status'] == 'A' for c in capture.changes)
    if touched and not fresh and not malformed_added:
        error('DUAL_SELECTED_INPUT_MEASUREMENT_ABSENT', 'Selected dual inputs changed without newly added dual evidence.')
    checks.append({'check': 'selected-input-coverage', 'complete': True, 'changed_inputs': touched})
    for name in (*SOURCE_FILES, *RECIPE_FILES):
        if name not in files:
            error('DUAL_BUILD_INPUT_MISSING', name)
    checks.append({'check': 'selected-input-closure', 'complete': True})
    valid = []
    for name, raw in dual:
        try:
            require(name == 'deploy/nitro/measurements/' + raw['release'] + '.json', 'manifest filename')
            source = capture.snapshot(raw['git_commit'])
            # Source must be an ancestor of exact HEAD and its selected closure must be unchanged.
            capture.git('merge-base', '--is-ancestor', raw['git_commit'], capture.head)
            if any(item[0] == name for item in fresh):
                require(inventory(source) == inventory(files), 'selected C/E input drift')
            require(capture.git('rev-parse', raw['git_commit'] + '^{tree}').decode().strip() == raw['source_tree'], 'source tree')
            require(raw['base_main_commit'] == capture.base, 'base identity')
            require(sha(capture.git('archive', '--format=tar', raw['git_commit'])) == raw['source_archive_sha256'], 'source archive')
            valid.append(validate_bundle(files[name][1], files, source))
        except (ValueError, KeyError, TypeError, UnicodeError):
            error('DUAL_RELEASE_INVALID', name)
    checks.append({'check': 'dual-manifest-bundle-source-bindings', 'complete': True})
    try:
        source = files['apps/web/lib/nitro-dual-release-registry.ts'][1].decode()
        # Strict literal JSON projection list only; no imports/evaluation/directory discovery.
        source = re.sub(r'/\*.*?\*/', '', source, flags=re.S).strip()
        match = re.fullmatch(r'export const COMMITTED_DUAL_NITRO_MEASUREMENTS: readonly unknown\[\] = Object\.freeze\((\[.*\])\);', source, re.S)
        require(match is not None, 'literal registry required')
        records = parse(match[1].encode())
        expected = []
        for m in valid:
            expected.append({'schema': 'neoos/dual-nitro-measurement/v1', 'release': m['release'],
                'network': None, 'networks': NETWORKS, 'app_ids': APPS, 'git_commit': m['git_commit'],
                'built_at': m['built_at'], 'manifest_sha256': sha(files['deploy/nitro/measurements/' + m['release'] + '.json'][1]),
                'eif_sha256': m['eif_sha256'], 'contexts': {n: {'profile_sha256': m['contexts'][n]['profile_sha256']} for n in NETWORKS},
                'supersedes': m['supersedes'], **{p: m[p] for p in ('pcr0', 'pcr1', 'pcr2')}})
        require(records == expected, 'registry and complete dual manifests differ')
    except (ValueError, KeyError, TypeError, UnicodeError):
        error('DUAL_REGISTRY_INVALID', 'Literal static registry must exactly match validated dual history.')
    checks.append({'check': 'literal-registry-parity', 'complete': True})
    # Source-byte checks cannot stand in for authoritative profile validation,
    # publication observation, retained EIF/describe-eif or the independent old gate.
    for name in ('authoritative-public-inputs', 'publication-receipt', 'retained-artifact'):
        checks.append({'check': name, 'complete': False, 'status':
                       'NOT_EVALUABLE_MISSING_MEASUREMENT' if not dual else 'REQUIRED_INTEGRATION_NOT_IMPLEMENTED'})
    if dual:
        error('DUAL_ADMISSION_INTEGRATION_REQUIRED', 'Full public-input, publication and artifact validation are not implemented in this prerequisite.')
    return errors, checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--base', required=True)
    args = parser.parse_args()
    result = {'schema': 'neoos/dual-source-prerequisite/v1', 'scope': 'supplemental-source-prerequisite',
              'full_admission': False, 'complete': False, 'passed': False}
    try:
        require('dual_release_execution' in sys.modules and sys.flags.isolated and sys.flags.no_site,
                'verified isolated launcher required')
        capture = Capture(args.root, args.base)
        errors, checks = audit(capture)
        capture.recheck()
        result.update(complete=False, source_checks_complete=True, passed=False, diagnostics=errors, checks=checks,
                      provenance=capture.receipt())
        code = 1  # Required integration checks remain held; never emit admission success.
    except (ValueError, OSError, KeyError, TypeError, UnicodeError, subprocess.SubprocessError) as exc:
        # No file contents/child stderr/config values in diagnostics.
        result['diagnostics'] = [{'code': 'DUAL_PROVENANCE_FAILED', 'message': str(exc) if isinstance(exc, ValueError) else 'Cannot capture committed gate inputs.'}]
        code = 2
    print(json.dumps(result, sort_keys=True))
    return code


if __name__ == '__main__':
    sys.exit(main())
