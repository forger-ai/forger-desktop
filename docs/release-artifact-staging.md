# Desktop release artifact staging

Desktop release jobs upload installers directly to the pre-created GitHub Release. They do not use GitHub Actions artifact storage for installer transfer. Validation, platform tests, signing and macOS notarization remain prerequisites.

The release starts as a draft or prerelease, with `--latest=false` and real changelog notes. Each successful platform job verifies its installer checksums and uploads the installers, checksum sidecars and available blockmaps. Partial builds remain outside the stable release catalog. Staging refuses an already-stable release.

After every build succeeds, the publication job downloads all four installers and their checksum sidecars from GitHub Release storage. It validates file names, nonempty content and SHA-256 digests before clearing draft/prerelease status, marking the release latest and requesting the Pages metadata refresh. A missing asset, failed download or checksum mismatch prevents promotion.

Retries retain byte-identical uploaded assets, verified against GitHub's asset size and digest. Existing files with different or unavailable digests cause a failure; the workflow never deletes or replaces release assets. A partial release with conflicting rebuilt files requires a new version or an explicitly authorized operator recovery. The previous stable release remains available.
