import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(run) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'forger-artifact-test-')));
  const modelStore = path.join(root, 'models');
  const manifestPath = path.join(modelStore, 'manifests/registry.ollama.ai/library/qwen3/1.7b');
  const blobs = [
    { mediaType: 'application/vnd.docker.container.image.v1+json', data: Buffer.from('{"model_format":"gguf"}') },
    { mediaType: 'application/vnd.ollama.image.model', data: Buffer.alloc(2 * 1024 * 1024 + 13, 42) },
    { mediaType: 'application/vnd.ollama.image.template', data: Buffer.from('synthetic template') },
  ];
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.mkdir(path.join(modelStore, 'blobs'));
  for (const blob of blobs) { blob.digest = `sha256:${sha(blob.data)}`; blob.path = path.join(modelStore, 'blobs', blob.digest.replace(':', '-')); await fs.writeFile(blob.path, blob.data); }
  const descriptor = ({ mediaType, digest, data }) => ({ mediaType, digest, size: data.length });
  const manifest = { schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', config: descriptor(blobs[0]), layers: blobs.slice(1).map(descriptor) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await fs.writeFile(manifestPath, manifestBytes);
  const runtimeArchive = path.join(root, 'ollama-darwin.tgz');
  const archive = Buffer.from('synthetic archive; never extracted');
  await fs.writeFile(runtimeArchive, archive);
  const catalog = {
    schemaVersion: 1, catalogVersion: 'test-fixture-v1',
    proposedRuntime: { id: 'ollama', version: '1.2.3', macosArchive: { url: 'https://github.com/ollama/ollama/releases/download/v1.2.3/ollama-darwin.tgz', sizeBytes: archive.length, sha256: sha(archive), signatureVerified: true } },
    models: [{ id: 'synthetic-qwen3-artifact', runtime: 'ollama', runtimeModel: 'qwen3:1.7b', artifact: { manifestUrl: 'https://registry.ollama.ai/v2/library/qwen3/manifests/1.7b', manifestDigest: `sha256:${sha(manifestBytes)}`, manifestSizeBytes: manifestBytes.length, configDigest: blobs[0].digest, configUrl: `https://registry.ollama.ai/v2/library/qwen3/blobs/${blobs[0].digest}`, weightDigest: blobs[1].digest, weightSizeBytes: blobs[1].data.length, downloadBytesExcludingManifestAndTransport: blobs.reduce((sum, blob) => sum + blob.data.length, 0) } }],
  };
  const catalogPath = path.join(root, 'models.json');
  const saveCatalog = async () => fs.writeFile(catalogPath, JSON.stringify(catalog));
  await saveCatalog();
  try { await run({ root, modelStore, manifestPath, manifest, catalog, catalogPath, saveCatalog, blobs, runtimeArchive }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('artifact verifier hashes the pinned manifest, config, every layer and optional archive without claiming signature verification', async () => {
  const { verifyArtifacts } = await import('../../scripts/local-development/verify-artifacts.mjs');
  await fixture(async (data) => {
    const result = await verifyArtifacts({ model: 'qwen3:1.7b', modelStore: data.modelStore, runtimeArchive: data.runtimeArchive }, { catalogPath: data.catalogPath });
    assert.equal(result.status, 'verified');
    assert.equal(result.model.status, 'verified');
    assert.equal(result.model.files.length, 4);
    assert.ok(result.model.files.every((file) => file.status === 'verified' && file.expected.sha256 === file.observed.sha256 && file.expected.sizeBytes === file.observed.sizeBytes));
    assert.equal(result.model.files.find((file) => file.kind === 'layer' && file.mediaType.endsWith('.model')).observed.sizeBytes, data.blobs[1].data.length);
    assert.equal(result.runtimeArchive.status, 'verified');
    assert.equal(result.runtimeArchive.signatureVerification.status, 'not_performed');
    assert.equal(result.provenance.catalogSha256, sha(await fs.readFile(data.catalogPath)));
    assert.match(result.provenance.verifierSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.networkUsed, false);
    assert.equal((await fs.readFile(data.runtimeArchive)).toString(), 'synthetic archive; never extracted');
  });
});

test('artifact verifier rejects altered manifest before trusting its blob descriptors', async () => {
  const { verifyArtifacts } = await import('../../scripts/local-development/verify-artifacts.mjs');
  await fixture(async (data) => {
    const contents = await fs.readFile(data.manifestPath);
    contents[0] = 32;
    await fs.writeFile(data.manifestPath, contents);
    const result = await verifyArtifacts({ model: 'qwen3:1.7b', modelStore: data.modelStore }, { catalogPath: data.catalogPath });
    assert.equal(result.status, 'failed');
    assert.equal(result.model.files.length, 1);
    assert.equal(result.model.files[0].failure, 'sha256_mismatch');
  });
});

test('artifact verifier rejects same-size blob corruption and wrong file sizes', async () => {
  const { verifyArtifacts } = await import('../../scripts/local-development/verify-artifacts.mjs');
  for (const fault of ['hash', 'size', 'archive']) await fixture(async (data) => {
    const target = fault === 'archive' ? data.runtimeArchive : data.blobs[1].path;
    const bytes = await fs.readFile(target);
    if (fault === 'hash') { bytes[0] ^= 1; await fs.writeFile(target, bytes); }
    else await fs.appendFile(target, 'x');
    const result = await verifyArtifacts({ model: 'qwen3:1.7b', modelStore: data.modelStore, ...(fault === 'archive' ? { runtimeArchive: data.runtimeArchive } : {}) }, { catalogPath: data.catalogPath });
    assert.equal(result.status, 'failed');
    const failed = fault === 'archive' ? result.runtimeArchive : result.model.files.find((file) => file.status === 'failed');
    assert.equal(failed.failure, fault === 'hash' ? 'sha256_mismatch' : 'size_mismatch');
  });
});

test('artifact verifier rejects leaf and ancestor symlinks in model store and archive paths', async () => {
  const { verifyArtifacts } = await import('../../scripts/local-development/verify-artifacts.mjs');
  for (const kind of ['manifest', 'blob', 'directory', 'archive']) await fixture(async (data) => {
    const original = kind === 'manifest' ? data.manifestPath : kind === 'blob' ? data.blobs[1].path : kind === 'archive' ? data.runtimeArchive : path.join(data.modelStore, 'blobs');
    const moved = path.join(data.root, `moved-${kind}`);
    await fs.rename(original, moved);
    await fs.symlink(moved, original, kind === 'directory' ? 'dir' : 'file');
    const result = await verifyArtifacts({ model: 'qwen3:1.7b', modelStore: data.modelStore, ...(kind === 'archive' ? { runtimeArchive: data.runtimeArchive } : {}) }, { catalogPath: data.catalogPath });
    assert.equal(result.status, 'failed', kind);
    assert.match(JSON.stringify(result), /symlink_not_allowed/);
  });
});

test('artifact verifier rejects unpinned models, invalid store paths, remote registry URLs and traversal descriptors', async () => {
  const { verifyArtifacts } = await import('../../scripts/local-development/verify-artifacts.mjs');
  await fixture(async (data) => {
    for (const modelStore of ['relative/models', `${data.modelStore}/../models`]) {
      const result = await verifyArtifacts({ model: 'qwen3:1.7b', modelStore }, { catalogPath: data.catalogPath });
      assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'invalid_absolute_path');
    }
    assert.equal((await verifyArtifacts({ model: 'unlisted:latest', modelStore: data.modelStore }, { catalogPath: data.catalogPath })).error.code, 'model_not_pinned');
    for (const url of ['https://evil.example/v2/library/qwen3/manifests/1.7b', 'https://registry.ollama.ai/v2/library/qwen3/manifests/%2e%2e/secret']) {
      data.catalog.models[0].artifact.manifestUrl = url; await data.saveCatalog();
      assert.equal((await verifyArtifacts({ model: 'qwen3:1.7b', modelStore: data.modelStore }, { catalogPath: data.catalogPath })).error.code, 'invalid_registry_manifest_url');
    }
    data.catalog.models[0].artifact.manifestUrl = 'https://registry.ollama.ai/v2/library/qwen3/manifests/1.7b';
    data.manifest.layers[1].digest = 'sha256:../../outside';
    const modified = Buffer.from(JSON.stringify(data.manifest));
    await fs.writeFile(data.manifestPath, modified);
    Object.assign(data.catalog.models[0].artifact, { manifestDigest: `sha256:${sha(modified)}`, manifestSizeBytes: modified.length }); await data.saveCatalog();
    assert.equal((await verifyArtifacts({ model: 'qwen3:1.7b', modelStore: data.modelStore }, { catalogPath: data.catalogPath })).error.code, 'invalid_blob_descriptor');
  });
});

test('artifact CLI accepts only explicit read-only inputs and never overwrites an existing report', async () => {
  const { parseArtifactArguments, runArtifactVerification } = await import('../../scripts/local-development/verify-artifacts.mjs');
  assert.deepEqual(parseArtifactArguments(['--model', 'qwen3:4b', '--model-store', '/models', '--output', 'new.json']), { model: 'qwen3:4b', modelStore: '/models', output: 'new.json' });
  for (const args of [['--download'], ['--model', 'a', '--model', 'b'], ['--model'], []]) assert.throws(() => parseArtifactArguments(args));
  await fixture(async (data) => {
    const output = path.join(data.root, 'result.json');
    await fs.writeFile(output, 'existing evidence');
    await assert.rejects(runArtifactVerification({ model: 'qwen3:1.7b', modelStore: data.modelStore, output }, { catalogPath: data.catalogPath }), /EEXIST|report_already_exists/);
    assert.equal(await fs.readFile(output, 'utf8'), 'existing evidence');
    const fresh = path.join(data.root, 'fresh.json');
    const report = await runArtifactVerification({ model: 'qwen3:1.7b', modelStore: data.modelStore, output: fresh }, { catalogPath: data.catalogPath });
    assert.equal(report.status, 'verified');
    assert.deepEqual(JSON.parse(await fs.readFile(fresh, 'utf8')), report);
    assert.equal(report.runtimeArchive.status, 'not_requested');
  });
});
