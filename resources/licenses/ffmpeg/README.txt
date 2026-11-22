Kadr runs FFmpeg as a separate executable. The FFmpeg build uses
--enable-gpl for the x264 software encoder and uses the GNU General Public
License, version 2 or later. See FFmpeg-COPYING.GPLv2. This directory also
contains the notices for the libraries in the FFmpeg build.

build.txt records the FFmpeg version and the exact build configuration.
sources.txt lists the exact upstream archives and their SHA-256 hashes.
The same GitHub Release or build artifact includes the installers and the
matching ffmpeg-source-<platform>-<arch>.tar.gz. This file contains all
pinned source archives and the script that builds them. Keep it available
with the installers when you redistribute a Kadr build.

To build FFmpeg, install curl, tar with gzip and xz support, make, Perl or
sha256sum, pkg-config, Meson, and Ninja. On macOS, install Xcode Command
Line Tools and pkgconf. Intel builds also require NASM. On Windows, use
MSYS2 UCRT64 with GCC, NASM, pkgconf, make, diffutils, and the MSYS curl
and tar utilities.

To rebuild from the Kadr checkout or the extracted source archive, run
bash scripts/build-ffmpeg.sh.
