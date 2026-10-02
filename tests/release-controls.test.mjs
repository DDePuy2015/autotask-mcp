import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BASE_DIGEST, REPOSITORY, summarizeScan, verifyProvenance, verifyRuntime } from '../scripts/release-checks.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sha = '1'.repeat(40);
const fixture = () => ({
  buildType: 'https://mobyproject.org/buildkit@v1',
  metadata: { 'https://mobyproject.org/buildkit@v1#metadata': { vcs: { revision: sha, source: `${REPOSITORY}.git` } } },
  buildConfig: { llbDefinition: [{}] },
  invocation: { parameters: { args: { 'build-arg:COMMIT_SHA': sha } } },
  materials: [{ uri: 'pkg:docker/node@22.23.1-alpine3.24?platform=linux%2Famd64', digest: { sha256: BASE_DIGEST.slice(7) } }],
});

test('runtime pin is accepted; different patches and unsupported majors fail', () => {
  verifyRuntime('22.23.1', '22.23.1');
  for (const actual of ['20.20.0', '22.22.0', '23.0.0', '26.0.0']) {
    assert.throws(() => verifyRuntime(actual, '22.23.1'));
  }
});

test('both Docker stages match the reviewed runtime and base digest', () => {
  const expected = read('.nvmrc').trim();
  const stages = read('Dockerfile').match(/^FROM .*$/gm);
  assert.equal(stages.length, 2);
  for (const stage of stages) assert.ok(stage.includes(`node:${expected}-alpine3.24@${BASE_DIGEST}`));
  assert.equal(JSON.parse(read('package.json')).engines.node, `>=${expected} <23`);
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].engines.node, `>=${expected} <23`);
  assert.match(read('.npmrc'), /^engine-strict=true/m);
});

test('credentials are secret mounts, not build arguments or context npmrc', () => {
  const docker = read('Dockerfile');
  assert.doesNotMatch(docker, /^ARG .*TOKEN/m);
  assert.match(docker, /--mount=type=secret,id=github_token,env=NODE_AUTH_TOKEN,required=true/);
  assert.match(docker, /npm prune --omit=dev --ignore-scripts/);
  assert.match(read('.dockerignore'), /^\.npmrc$/m);
  for (const file of ['test.yml', 'fork-container-validation.yml', 'fork-image-publish.yml']) {
    const workflow = read(`.github/workflows/${file}`);
    assert.doesNotMatch(workflow, /--build-arg GITHUB_TOKEN|GITHUB_TOKEN=\$\{\{/);
    assert.match(workflow, /github_token[=:,]/);
    assert.doesNotMatch(workflow, /node-version: ['"]?(20|26)/);
  }
});

test('publisher stays manually confirmed, main-only, dependency-gated and Azure-free', () => {
  const workflow = read('.github/workflows/fork-image-publish.yml');
  assert.doesNotMatch(workflow, /^  (push|pull_request):/m);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /inputs\.confirm_publish == 'PUBLISH_DDEPUY2015_AUTOTASK_MCP'/);
  assert.match(workflow, /needs: controls/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.match(workflow, /cosign verify-attestation/);
  assert.match(workflow, /--certificate-identity/);
  assert.doesNotMatch(workflow, /azure\/login|az containerapp|AZURE_CLIENT_ID|environment:/);
  const controls = read('.github/workflows/fork-container-validation.yml');
  assert.match(controls, /needs: source-controls/);
  assert.match(controls, /npm audit --omit=dev --audit-level=high/);
  assert.match(controls, /gitleaks\/gitleaks-action@/);
  assert.match(controls, /scanners: vuln,secret/);
  assert.doesNotMatch(controls, /id-token: write|packages: write/);
});

test('local build callers use the same secret mount', () => {
  const compose = read('docker-compose.yml');
  assert.equal((compose.match(/- github_token/g) ?? []).length, 2);
  assert.match(compose, /github_token:\s+environment: NODE_AUTH_TOKEN/);
  assert.match(read('scripts/prepare-release.sh'), /--secret id=github_token,env=NODE_AUTH_TOKEN/);
  assert.doesNotMatch(read('scripts/prepare-release.sh'), /docker push/);
  assert.match(read('DOCKER_USAGE.md'), /separate activation approval/);
});

test('inherited MCP assertions use the pinned app runtime, not their default', () => {
  const expected = read('.nvmrc').trim();
  assert.ok(read('.github/workflows/mcp-assert.yml').includes(`node-version: '${expected}'`));
  assert.match(read('.gitignore'), /^tag-check-error\.txt$/m);
});

test('valid single-platform and mapped BuildKit predicates are accepted', () => {
  assert.equal(verifyProvenance(fixture(), sha).buildType, fixture().buildType);
  assert.equal(verifyProvenance({ 'linux/amd64': fixture() }, sha).buildType, fixture().buildType);
});

for (const [name, mutate] of [
  ['wrong source SHA', p => { p.metadata['https://mobyproject.org/buildkit@v1#metadata'].vcs.revision = '2'.repeat(40); }],
  ['dirty source', p => { p.metadata['https://mobyproject.org/buildkit@v1#metadata'].vcs.revision += '-dirty'; }],
  ['wrong repository', p => { p.metadata['https://mobyproject.org/buildkit@v1#metadata'].vcs.source = 'https://github.com/example/other'; }],
  ['minimum provenance', p => { delete p.buildConfig; }],
  ['credential argument', p => { p.invocation.parameters.args['build-arg:GITHUB_TOKEN'] = 'synthetic'; }],
  ['wrong base', p => { p.materials[0].digest.sha256 = '0'.repeat(64); }],
  ['missing provenance', p => { delete p.buildType; }],
]) {
  test(`provenance rejects ${name}`, () => {
    const predicate = fixture();
    mutate(predicate);
    assert.throws(() => verifyProvenance(predicate, sha));
  });
}

test('scan summaries cannot retain secret matches or source snippets', () => {
  const summary = summarizeScan({ Results: [{
    Target: 'image', Type: 'alpine',
    Secrets: [{ RuleID: 'generic', Severity: 'HIGH', Match: 'synthetic-private-value', Code: { Lines: [{ Content: 'synthetic-private-value' }] } }],
    Vulnerabilities: [{ VulnerabilityID: 'CVE-test', Severity: 'HIGH', FixedVersion: '1.2.3', Description: 'discarded' }],
  }] });
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-private-value|Content|Match|discarded/);
  assert.equal(summary[0].secrets[0].rule, 'generic');
});
