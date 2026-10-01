import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const dockerfile = fs.readFileSync(
  path.join(root, 'deploy/nitro/Dockerfile.signer-legacy'),
  'utf8'
);
const goMod = fs.readFileSync(path.join(root, 'deploy/nitro/nsm-attest/go.mod'), 'utf8');

test('legacy NSM builder uses the supported, pinned Go toolchain', () => {
  assert.match(
    dockerfile,
    /^FROM golang:1\.24\.13-bookworm@sha256:98d673f18a1aac43da744209873cb79323e11706f909251bcfb131828b95559d AS nsmbuild$/m
  );
  assert.doesNotMatch(dockerfile, /golang:1\.22/);
  assert.match(
    dockerfile,
    /COPY deploy\/nitro\/nsm-attest\/go\.mod deploy\/nitro\/nsm-attest\/go\.sum \.\//
  );
  assert.match(dockerfile, /RUN go mod download/);
  assert.match(dockerfile, /go build -trimpath -mod=readonly/);
  assert.doesNotMatch(dockerfile, /go mod init/);
  assert.doesNotMatch(dockerfile, /go get [^\n]*@latest/);
  assert.match(goMod, /^go 1\.24$/m);
});
