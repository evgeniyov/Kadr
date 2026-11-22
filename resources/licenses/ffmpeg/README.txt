Kadr invokes FFmpeg as a separate executable. FFmpeg is built with
--enable-gpl for the x264 software encoder and is licensed under the GNU
General Public License, version 2 or later. See FFmpeg-COPYING.GPLv2.
The corresponding notices for the libraries used by FFmpeg are alongside it.

build.txt records the FFmpeg version and exact configuration of this binary.
sources.txt lists the exact upstream archives and SHA-256 hashes.
The matching ffmpeg-source-<platform>-<arch>.tar.gz accompanies Kadr's
installers in the same GitHub Release or build artifact. It contains all
pinned source archives and the script used to compile them. Keep that archive
available alongside the installers when redistributing a Kadr build.

Build prerequisites: curl, tar (gzip and xz), make, Perl or sha256sum,
pkg-config, Meson, and Ninja. On macOS, install Xcode Command Line Tools and pkgconf;
Intel builds also require NASM. On Windows, use MSYS2 UCRT64 with GCC,
NASM, pkgconf, make, diffutils, and the MSYS curl and tar utilities.
To rebuild from the Kadr checkout or the extracted source archive, run bash scripts/build-ffmpeg.sh.
