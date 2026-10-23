# Releasing

`.github/workflows/release.yml` publishes on a tag. No tokens are stored: npm and PyPI trust this
repository's workflow directly (trusted publishing).

## Every release

1. Bump the version everywhere it is declared:
   - TypeScript, both packages together: `typescript/packages/sdk/package.json`,
     `typescript/packages/cli/package.json`, `typescript/packages/sdk/src/version.ts` and
     `VERSION` in `typescript/packages/cli/src/main.ts`.
   - Python: `python/pyproject.toml` and `python/src/twigg/_version.py`.
2. Commit, then tag and push:

   ```bash
   git tag ts-v0.3.0 && git push origin ts-v0.3.0   # @twigg/sdk and @twigg/cli
   git tag py-v0.3.0 && git push origin py-v0.3.0   # twigg on PyPI
   ```

The workflow runs every check, refuses a tag that does not match the declared versions, and skips
anything already published, so re-running a failed release is safe.

## Once, before the first release

- **The repository must be public.** npm only records provenance for public repositories.
- **npm:** for each of `@twigg/sdk` and `@twigg/cli`, add a trusted publisher on npmjs.com
  (package settings, "Trusted publisher"): GitHub Actions, organisation `Twigg-AI-Ltd`,
  repository `sdk`, workflow `release.yml`. If npm only offers this for a package that already
  exists, publish 0.1.0 once by hand from a `pnpm pack` tarball (`npm publish <tarball> --access
  public`), then add the publisher.
- **PyPI:** under the Twigg organisation, add a pending publisher for project `twigg`: owner
  `Twigg-AI-Ltd`, repository `sdk`, workflow `release.yml`, environment `pypi`. Create a `pypi`
  environment in the repository settings (optionally with required reviewers, to gate releases).
