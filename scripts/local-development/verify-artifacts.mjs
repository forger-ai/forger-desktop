import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const scriptPath = fileURLToPath(import.meta.url);
const defaultCatalogPath = fileURLToPath(new URL('../../docs/local-development/models.json', import.meta.url));
const chunkBytes = 1024 * 1024;
const metadataLimit = 1024 * 1024;
const registry = 'https://registry.ollama.ai';
const signatureNotPerformed = () => ({ status: 'not_performed', reason: 'This tool verifies archive bytes only. It does not execute codesign, verify notarization or attest an extracted executable.' });
const failure = (code, observed) => Object.assign(new Error(code), { code, ...(observed ? { observed } : {}) });
const digestValue = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const validSize = (value) => Number.isSafeInteger(value) && value >= 0;

function absolutePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || path.normalize(value) !== value || value.split(path.sep).some((part) => part === '.' || part === '..')) throw failure('invalid_absolute_path');
  return value;
}

async function inspectPath(file, expectedKind) {
  absolutePath(file);
  const parsed = path.parse(file); let current = parsed.root; let stat;
  const parts = file.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]); stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw failure('symlink_not_allowed');
    if (index < parts.length - 1 && !stat.isDirectory()) throw failure('path_ancestor_not_directory');
  }
  stat ??= await fs.lstat(file);
  if (expectedKind === 'file' && !stat.isFile()) throw failure('artifact_not_regular_file');
  if (expectedKind === 'directory' && !stat.isDirectory()) throw failure('store_or_report_parent_not_directory');
  return stat;
}

/** Bounded memory: only small catalog/manifest documents are retained. */
async function readStableFile(file, { expectedSize, captureLimit = 0 } = {}) {
  const beforeOpen = await inspectPath(file, 'file');
  if (expectedSize !== undefined && beforeOpen.size !== expectedSize) throw failure('size_mismatch', { sizeBytes: beforeOpen.size, sha256: null });
  if (captureLimit && beforeOpen.size > captureLimit) throw failure('metadata_too_large');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== beforeOpen.ino || before.dev !== beforeOpen.dev) throw failure('file_changed_during_open');
    const hash = createHash('sha256'); let sizeBytes = 0; const chunks = [];
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: chunkBytes })) {
      sizeBytes += chunk.length;
      if (sizeBytes > before.size || (captureLimit && sizeBytes > captureLimit)) throw failure('file_changed_during_verification');
      hash.update(chunk);
      if (captureLimit) chunks.push(chunk);
    }
    const after = await handle.stat();
    if (sizeBytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw failure('file_changed_during_verification');
    return { sizeBytes, sha256: hash.digest('hex'), ...(captureLimit ? { content: Buffer.concat(chunks) } : {}) };
  } finally { await handle.close(); }
}

async function verifyFile(file, expected, metadata) {
  const record = { ...metadata, path: file, status: 'failed', expected, observed: { sizeBytes: null, sha256: null }, hashing: 'sha256_stream' };
  try {
    const observed = await readStableFile(file, { expectedSize: expected.sizeBytes, captureLimit: metadata.kind === 'manifest' ? metadataLimit : 0 });
    record.observed = { sizeBytes: observed.sizeBytes, sha256: observed.sha256 };
    if (observed.sha256 !== expected.sha256) { record.failure = 'sha256_mismatch'; return { record }; }
    record.status = 'verified';
    return { record, content: observed.content };
  } catch (error) {
    record.failure = error.code ?? 'file_read_failed';
    if (error.observed) record.observed = error.observed;
    return { record };
  }
}

function pinnedModel(catalog, model) {
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.models)) throw failure('invalid_catalog');
  const matches = catalog.models.filter((entry) => entry.runtime === 'ollama' && entry.runtimeModel === model);
  if (matches.length !== 1) throw failure('model_not_pinned');
  const match = /^([a-z0-9][a-z0-9._-]*):([a-z0-9][a-z0-9._-]*)$/.exec(model ?? '');
  if (!match) throw failure('invalid_runtime_model');
  const [, repository, tag] = match;
  const entry = matches[0]; const artifact = entry.artifact;
  if (artifact?.manifestUrl !== `${registry}/v2/library/${repository}/manifests/${tag}`) throw failure('invalid_registry_manifest_url');
  if (![artifact.manifestDigest, artifact.configDigest, artifact.weightDigest].every(digestValue)
      || ![artifact.manifestSizeBytes, artifact.weightSizeBytes, artifact.downloadBytesExcludingManifestAndTransport].every(validSize)
      || artifact.manifestSizeBytes > metadataLimit) throw failure('invalid_catalog_artifact_pin');
  if (artifact.configUrl !== `${registry}/v2/library/${repository}/blobs/${artifact.configDigest}`) throw failure('invalid_registry_config_url');
  return { entry, repository, tag };
}

function manifestDescriptors(manifest, artifact) {
  const valid = (descriptor) => descriptor && digestValue(descriptor.digest) && validSize(descriptor.size) && typeof descriptor.mediaType === 'string';
  if (manifest.schemaVersion !== 2 || !valid(manifest.config) || !Array.isArray(manifest.layers) || !manifest.layers.length || manifest.layers.length > 100 || !manifest.layers.every(valid)) throw failure('invalid_blob_descriptor');
  if (manifest.config.digest !== artifact.configDigest) throw failure('config_digest_not_pinned');
  const weights = manifest.layers.filter((layer) => layer.mediaType === 'application/vnd.ollama.image.model');
  if (weights.length !== 1 || weights[0].digest !== artifact.weightDigest || weights[0].size !== artifact.weightSizeBytes) throw failure('weight_descriptor_not_pinned');
  const descriptors = [{ ...manifest.config, kind: 'config' }, ...manifest.layers.map((layer, index) => ({ ...layer, kind: 'layer', index }))];
  const total = descriptors.reduce((sum, descriptor) => sum + descriptor.size, 0);
  if (!validSize(total) || total !== artifact.downloadBytesExcludingManifestAndTransport) throw failure('total_download_size_not_pinned');
  const seen = new Map();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.digest) && seen.get(descriptor.digest) !== descriptor.size) throw failure('conflicting_blob_sizes');
    seen.set(descriptor.digest, descriptor.size);
  }
  return descriptors;
}

export async function verifyArtifacts({ model, modelStore, runtimeArchive }, { catalogPath = defaultCatalogPath } = {}) {
  const started = performance.now();
  const report = {
    schemaVersion: 1, protocol: 'forger-local-artifact-verification-v1', status: 'failed', startedAt: new Date().toISOString(),
    networkUsed: false, model: { runtimeModel: model, store: modelStore, status: 'not_verified', files: [] },
    runtimeArchive: { status: runtimeArchive ? 'not_verified' : 'not_requested', signatureVerification: signatureNotPerformed() },
    provenance: {}, bufferingPolicy: { maxStreamingChunkBytes: chunkBytes, maxRetainedMetadataBytes: metadataLimit },
    limits: ['Hash matches establish byte identity against the local catalog pins; the catalog is not independently authenticated by this tool.', 'Model compatibility, licenses, publisher conversion provenance and task capability require separate review.', 'Filesystem checks reject observed symlinks and file changes; they do not attest a compromised operating system or eliminate every concurrent directory-replacement race.'],
  };
  try {
    absolutePath(modelStore);
    if (runtimeArchive) absolutePath(runtimeArchive);
    const catalogBytes = await readStableFile(catalogPath, { captureLimit: metadataLimit });
    const catalog = JSON.parse(catalogBytes.content.toString('utf8'));
    report.provenance = { catalogPath, catalogSha256: catalogBytes.sha256, catalogVersion: catalog.catalogVersion ?? null, verifierSha256: (await readStableFile(scriptPath)).sha256, nodeVersion: process.version };
    const { entry, repository, tag } = pinnedModel(catalog, model);
    await inspectPath(modelStore, 'directory');
    Object.assign(report.model, { catalogId: entry.id, manifestUrl: entry.artifact.manifestUrl, status: 'failed' });
    const manifestPath = path.join(modelStore, 'manifests', 'registry.ollama.ai', 'library', repository, tag);
    const checkedManifest = await verifyFile(manifestPath, { sha256: entry.artifact.manifestDigest.slice(7), sizeBytes: entry.artifact.manifestSizeBytes }, { kind: 'manifest', sourceUrl: entry.artifact.manifestUrl });
    report.model.files.push(checkedManifest.record);
    if (checkedManifest.record.status === 'verified') {
      let manifest;
      try { manifest = JSON.parse(checkedManifest.content.toString('utf8')); } catch { throw failure('invalid_manifest_json'); }
      const descriptors = manifestDescriptors(manifest, entry.artifact);
      for (const descriptor of descriptors) {
        const blobPath = path.join(modelStore, 'blobs', descriptor.digest.replace(':', '-'));
        const checked = await verifyFile(blobPath, { sha256: descriptor.digest.slice(7), sizeBytes: descriptor.size }, { kind: descriptor.kind, ...(descriptor.index === undefined ? {} : { layerIndex: descriptor.index }), mediaType: descriptor.mediaType, sourceUrl: `${registry}/v2/library/${repository}/blobs/${descriptor.digest}` });
        report.model.files.push(checked.record);
      }
      report.model.status = report.model.files.every((file) => file.status === 'verified') ? 'verified' : 'failed';
    }
    if (runtimeArchive) {
      const runtime = catalog.proposedRuntime; const archive = runtime?.macosArchive;
      if (runtime?.id !== 'ollama' || !/^\d+\.\d+\.\d+$/.test(runtime.version ?? '') || archive?.url !== `https://github.com/ollama/ollama/releases/download/v${runtime.version}/ollama-darwin.tgz` || !validSize(archive.sizeBytes) || !/^[a-f0-9]{64}$/.test(archive.sha256 ?? '')) throw failure('invalid_runtime_archive_pin');
      report.runtimeArchive = { ...(await verifyFile(runtimeArchive, { sha256: archive.sha256, sizeBytes: archive.sizeBytes }, { kind: 'runtime_archive', sourceUrl: archive.url, runtimeVersion: runtime.version })).record, signatureVerification: signatureNotPerformed() };
    }
    report.status = report.model.status === 'verified' && ['verified', 'not_requested'].includes(report.runtimeArchive.status) ? 'verified' : 'failed';
  } catch (error) {
    report.status = 'failed'; report.error = { code: error.code ?? 'verification_failed', message: error.message };
    if (report.model.status !== 'verified') report.model.status = 'failed';
  }
  report.finishedAt = new Date().toISOString(); report.verificationElapsedMs = performance.now() - started;
  return report;
}

export function parseArtifactArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--model': 'model', '--model-store': 'modelStore', '--runtime-archive': 'runtimeArchive', '--output': 'output' };
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]]; const value = args[index + 1];
    if (!key || key in parsed || !value || value.startsWith('--')) throw failure('invalid_or_duplicate_argument');
    parsed[key] = value;
  }
  if (!parsed.model || !parsed.modelStore || !parsed.output) throw failure('model_store_and_new_report_required');
  return parsed;
}

async function writeJson(handle, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await handle.truncate(0);
  let written = 0;
  while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, written)).bytesWritten;
  await handle.sync();
}

export async function runArtifactVerification(options, dependencies) {
  if (!options.output) throw failure('new_report_required');
  const output = path.resolve(options.output);
  await inspectPath(path.dirname(output), 'directory');
  // Exclusive creation reserves the report before any large file is hashed.
  // Its already-open descriptor prevents a later path replacement from redirecting writes.
  const handle = await fs.open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await writeJson(handle, { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), model: options.model, networkUsed: false });
    const report = await verifyArtifacts(options, dependencies);
    await writeJson(handle, report);
    return report;
  } finally { await handle.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseArtifactArguments(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/local-development/verify-artifacts.mjs --model qwen3:1.7b --model-store /ABSOLUTE/OLLAMA/MODELS --output NEW.json [--runtime-archive /ABSOLUTE/ollama-darwin.tgz]');
    else {
      const result = await runArtifactVerification(options);
      console.log(JSON.stringify({ status: result.status, model: result.model.runtimeModel, filesVerified: result.model.files.filter((file) => file.status === 'verified').length, runtimeArchive: result.runtimeArchive.status, output: options.output, ...(result.error ? { error: result.error } : {}) }, null, 2));
      process.exitCode = result.status === 'verified' ? 0 : 2;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
