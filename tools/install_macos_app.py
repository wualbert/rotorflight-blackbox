#!/usr/bin/env python3
"""Install the verified production build over the local macOS application."""

import hashlib
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile


def manifest(bundle):
    """Include file contents, permissions, directories and symbolic-link targets."""
    entries = {}
    for folder, directories, files in os.walk(bundle, followlinks=False):
        for name in directories + files:
            item = Path(folder) / name
            info = item.lstat()
            mode = stat.S_IMODE(info.st_mode)
            if item.is_symlink():
                value = ("link", mode, os.readlink(item))
            elif item.is_dir():
                value = ("directory", mode)
            else:
                digest = hashlib.sha256()
                with item.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                value = ("file", mode, digest.hexdigest())
            entries[str(item.relative_to(bundle))] = value
    return entries


def main():
    if sys.platform != "darwin":
        raise RuntimeError("This installer requires macOS.")
    root = Path(__file__).resolve().parent.parent
    source = root / "apps/rotorflight-blackbox/osx64/rotorflight-blackbox.app"
    destination = Path("/Applications/Rotorflight Blackbox.app")
    info = plistlib.loads((source / "Contents/Info.plist").read_bytes())
    if not (source / "Contents/MacOS" / info["CFBundleExecutable"]).is_file():
        raise RuntimeError("The production build has no application executable.")
    if not (source / "Contents/Resources/app.nw/package.json").is_file():
        raise RuntimeError("The production build has no application manifest.")

    expected = manifest(source)
    staging = Path(tempfile.mkdtemp(prefix=".rotorflight-blackbox-install-", dir=destination.parent))
    candidate = staging / destination.name
    previous = staging / "previous.app"
    try:
        subprocess.run(["/usr/bin/ditto", str(source), str(candidate)], check=True)
        if manifest(candidate) != expected:
            raise RuntimeError("The staged application differs from the production build.")
        if os.path.lexists(destination):
            destination.rename(previous)
        try:
            candidate.rename(destination)
        except BaseException:
            if os.path.lexists(previous):
                previous.rename(destination)
            raise
    except BaseException:
        # Preserve the old bundle if restoration itself failed.
        if os.path.lexists(previous):
            print(f"Previous application retained at {previous}", file=sys.stderr)
        else:
            shutil.rmtree(staging)
        raise
    else:
        shutil.rmtree(staging)
    print(f"Installed and verified {destination} ({len(expected)} entries).")


if __name__ == "__main__":
    main()
