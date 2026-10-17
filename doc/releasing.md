# Release completion

A local implementation or passing test run is not a completed GitHub delivery.
For an authorized release, finish the pull request, merge, and tag lifecycle:

1. Keep unrelated changes, local memory, voice assets, and credentials out of the
   release index. Synchronize package.json and openclaw.plugin.json versions,
   update CHANGELOG.md, and preserve the tracked pnpm lockfile.
2. Export the intended Git tree to an independent directory. Install with
   `pnpm install --frozen-lockfile`, then run `pnpm run check`,
   `pnpm run build`, `pnpm test`, and `pnpm run test:irodori`.
   Verify that regenerated dist files match the release tree.
3. Build the actual package, inspect its contents, and install that exact archive
   in an isolated published OpenClaw host. Verify all provider registrations and
   real host-to-provider calls against deterministic loopback fixtures, including
   rejection before backend submission for over-limit input. Keep production
   Gateway state and actual voice services outside this test.
4. Review the final diff, push a release branch, and open a pull request targeting
   main. Include verification evidence and closing references only for resolved
   issues. Confirm any configured CI and independent review before merging.
   When the repository has no CI, record the independent source and package
   checks explicitly; do not report absent checks as passed CI. Do not label an
   unreproduced incident as root-cause fixed merely because retries completed.
5. Fetch and verify the merged main commit. Create the version tag on that commit,
   never on an unmerged branch tip; do not replace an existing published tag.
6. Publish the package and SHA256SUMS as GitHub release assets. Retrieve the public
   assets without credentials and verify checksums and equality with local files.
   Confirm the resolved issue is closed and the tag points to the merged commit.

Use the packageManager version declared by package.json. This release does not
add or change GitHub Actions workflows; live speech tests remain opt-in. npm and ClawHub
publication, production Gateway activation, and changes to TTS preferences are
separate scopes and are not implied by a GitHub release. Optional host patches
must be identified as such in release notes; package publication does not install
them into a running Gateway.
