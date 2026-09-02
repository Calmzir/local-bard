# Releasing

To cut a new release:

```bash
npm version 0.1.0   # bumps package.json + creates a git tag, e.g. v0.1.0
git push --follow-tags
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds the
Windows installer and Linux AppImage/`.deb` packages, then automatically
publishes them to the [Releases page](https://github.com/Calmzir/local-bard/releases)
as `Local Bard <tag>`. No manual upload needed.
