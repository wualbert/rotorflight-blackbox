# Development workflow

Read `CLAUDE.md` and `docs/DEVELOPMENT.md` before implementation work.

After every implementation change, rebuild the production desktop app with
`make apps` before reporting completion. Use a Node version supported by
`package.json`. Tests and a development-server preview do not replace this build.
On macOS, every completed rebuild must replace
`/Applications/Rotorflight Blackbox.app`. `make apps` performs this installation
automatically. The user has explicitly authorized replacement of this app after
each rebuild. A bundle left only in `apps/` does not complete the task.
Verify that the installed bundle contains the updated files, and launch the
installed copy instead of the copy in the build directory. If an older instance
is running, close it normally before relaunching. Preserve any unsaved work.
If the build or installation fails, fix it before reporting completion.
