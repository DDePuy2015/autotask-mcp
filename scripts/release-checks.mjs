import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const REPOSITORY = 'https://github.com/DDePuy2015/autotask-mcp';
export const BASE_DIGEST = 'sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2';
const AMD64_BASE_DIGEST = 'b74031e546d7f4faf561d797ac1b76beccac856a042815ca77db4fd047581605';

export function verifyRuntime(actual, expected) {
  assert.match(expected, /^22\.\d+\.\d+$/, 'runtime pin must be Node 22');
  assert.equal(actual, expected, 'runtime does not match .nvmrc');
}

export function verifyProvenance(document, sourceSha) {
  assert.match(sourceSha, /^[0-9a-f]{40}$/, 'invalid source SHA');
  const predicate = document?.['linux/amd64'] ?? document;
  assert.equal(predicate?.buildType, 'https://mobyproject.org/buildkit@v1', 'missing BuildKit provenance');
  const metadata = predicate.metadata?.['https://mobyproject.org/buildkit@v1#metadata'];
  assert.equal(metadata?.vcs?.revision, sourceSha, 'provenance source revision mismatch');
  assert.ok(metadata?.vcs?.source?.replace(/\.git$/, '') === REPOSITORY, 'provenance repository mismatch');
  assert.ok(predicate.buildConfig?.llbDefinition?.length, 'maximum-mode provenance is required');
  const args = predicate.invocation?.parameters?.args ?? {};
  assert.ok(!Object.keys(args).some(key => /token|password|secret/i.test(key)), 'credential build arguments are forbidden');
  assert.ok(predicate.materials?.some(material =>
    material.uri?.includes('pkg:docker/node@22.23.1-alpine3.24') &&
    [BASE_DIGEST.slice(7), AMD64_BASE_DIGEST].includes(material.digest?.sha256)), 'reviewed Node base material missing');
  return predicate;
}

// Never publish raw secret matches, code excerpts, or package credentials.
export function summarizeScan(report) {
  return (report.Results ?? []).map(result => ({
    target: result.Target,
    type: result.Type,
    vulnerabilities: (result.Vulnerabilities ?? []).map(item => ({
      id: item.VulnerabilityID, severity: item.Severity, fixedVersion: item.FixedVersion,
    })),
    secrets: (result.Secrets ?? []).map(item => ({ rule: item.RuleID, severity: item.Severity })),
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, input, output] = process.argv.slice(2);
  if (command === 'runtime') {
    const expected = readFileSync('.nvmrc', 'utf8').trim();
    verifyRuntime(process.versions.node, expected);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    assert.equal(pkg.engines.node, `>=${expected} <23`);
    assert.equal(lock.packages[''].engines.node, pkg.engines.node);
    console.log(`Validated Node ${expected} and matching manifest/lockfile engines`);
  } else if (command === 'provenance') {
    const predicate = verifyProvenance(JSON.parse(readFileSync(input, 'utf8')), process.env.SOURCE_SHA);
    writeFileSync(output, JSON.stringify(predicate, null, 2) + '\n');
    console.log('Validated immutable source, maximum provenance, and reviewed base material');
  } else if (command === 'scan-summary') {
    writeFileSync(output, JSON.stringify(summarizeScan(JSON.parse(readFileSync(input, 'utf8'))), null, 2) + '\n');
  } else {
    throw new Error('Expected runtime, provenance, or scan-summary');
  }
}
