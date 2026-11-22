#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
licenses="$root/resources/licenses/ffmpeg"
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target=darwin-arm64; vpx_target=arm64-darwin22-gcc ;;
  Darwin:x86_64) target=darwin-x64; vpx_target=x86_64-darwin22-gcc ;;
  MINGW*:x86_64|MSYS*:x86_64|UCRT*:x86_64)
    target=win32-x64; vpx_target=x86_64-win64-gcc ;;
  *) echo 'Bundled FFmpeg must be built natively on macOS or on Windows with MSYS2 UCRT64.' >&2; exit 1 ;;
esac
out="$root/resources/bin/ffmpeg/$target"
binary=ffmpeg
if [[ $target == win32-x64 ]]; then binary=ffmpeg.exe; fi
source_archive="ffmpeg-source-$target.tar.gz"

hash() {
  if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
recipe_hash="$(cat "$0" "$licenses/sources.txt" | hash | cut -d' ' -f1)"
if [[ -s "$out/$binary" && -s "$out/$source_archive" && -s "$out/build.txt" && -f "$out/recipe" ]] &&
   [[ $(cat "$out/recipe") == "$recipe_hash" ]]; then
  echo "FFmpeg is up to date: $target"
  exit 0
fi

if [[ $target == win32-x64 ]]; then
  [[ ${MSYSTEM:-} == UCRT64 ]] || { echo 'Use the MSYS2 UCRT64 shell to build FFmpeg for Windows.' >&2; exit 1; }
  export CC=gcc
  jobs=$(nproc)
else
  export CC=clang MACOSX_DEPLOYMENT_TARGET=13.0
  jobs=$(sysctl -n hw.logicalcpu)
fi
for tool in pkg-config meson ninja; do
  command -v "$tool" >/dev/null || { echo "FFmpeg build requires $tool." >&2; exit 1; }
done
if [[ $target != darwin-arm64 ]]; then
  command -v nasm >/dev/null || { echo 'FFmpeg build requires NASM on x64.' >&2; exit 1; }
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/kadr-ffmpeg.XXXXXXXX")"
trap 'rm -rf -- "$work"' EXIT
cd "$work"
work="$(pwd -P)"
prefix="$work/prefix"
mkdir -p corresponding/sources "$prefix/include" "$prefix/lib"
archives="$work/corresponding/sources"

while read -r component archive sha url; do
  [[ -n $component && $component != \#* ]] || continue
  if [[ -f "$root/sources/$archive" ]]; then
    cp "$root/sources/$archive" "$archives/"
  else
    echo "Downloading $archive"
    curl --fail --location --silent --show-error --retry 3 --output "$archives/$archive" "$url"
  fi
  if [[ $(hash < "$archives/$archive" | cut -d' ' -f1) != "$sha" ]]; then
    echo "SHA-256 mismatch: $archive" >&2
    exit 1
  fi
  mkdir "$component"
  tar -xf "$archives/$archive" -C "$component" --strip-components=1
done < "$licenses/sources.txt"

export PKG_CONFIG_PATH=
unset PKG_CONFIG_SYSROOT_DIR
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
autotools_flags=(--disable-shared)
x264_flags=(--enable-static)
lame_cflags="-O2 -fcommon"
if [[ $target == win32-x64 ]]; then
  export PKG_CONFIG_LIBDIR="$(cygpath -m "$PKG_CONFIG_LIBDIR")"
  autotools_flags+=(--host=x86_64-w64-mingw32 --build=x86_64-w64-mingw32)
  x264_flags+=(--host=x86_64-w64-mingw32)
  lame_cflags+=" -std=gnu11"
  platform_flags=(--cc=gcc --target-os=mingw32 --disable-pthreads --extra-ldflags='-L../prefix/lib -static')
else
  platform_flags=(--extra-ldflags=-L../prefix/lib)
fi

(
  cd zlib
  if [[ $target == win32-x64 ]]; then
    make -j"$jobs" -f win32/Makefile.gcc libz.a
    cp zlib.h zconf.h "$prefix/include/"
    cp libz.a "$prefix/lib/"
  else
    ./configure --prefix="$prefix" --static
    make -j"$jobs" install
  fi
)
(
  cd x264
  ./configure --prefix="$prefix" "${x264_flags[@]}" --disable-cli --disable-opencl
  make -j"$jobs" install
)
(
  cd vpx
  ./configure --prefix="$prefix" --target="$vpx_target" --enable-vp9-highbitdepth \
    --disable-examples --disable-tools --disable-docs --disable-unit-tests --disable-shared
  make -j"$jobs" install
)
(
  cd opus
  ./configure --prefix="$prefix" "${autotools_flags[@]}" --disable-doc --disable-extra-programs
  make -j"$jobs" install
)
(
  cd lame
  # LAME's older C sources still use tentative definitions in multiple files.
  CFLAGS="$lame_cflags" ./configure --prefix="$prefix" "${autotools_flags[@]}" --disable-frontend --disable-decoder
  make -j"$jobs" install
)
(
  cd webp
  ./configure --prefix="$prefix" "${autotools_flags[@]}" --disable-gl --disable-sdl \
    --disable-png --disable-jpeg --disable-tiff --disable-gif --disable-wic
  make -j"$jobs" install
)
(
  cd dav1d
  meson setup build --prefix="$prefix" --libdir=lib --default-library=static --buildtype=release \
    -Denable_tools=false -Denable_tests=false
  ninja -C build -j"$jobs" install
)
(
  cd ffmpeg
  ./configure --disable-autodetect --disable-shared --enable-static --enable-gpl \
    --enable-libx264 --enable-libvpx --enable-libopus --enable-libmp3lame --enable-libwebp \
    --enable-libdav1d --enable-zlib --disable-doc --disable-debug --disable-ffplay --disable-ffprobe \
    --disable-indevs --enable-indev=lavfi --disable-outdevs --pkg-config-flags=--static \
    --extra-cflags=-I../prefix/include "${platform_flags[@]}" || {
      tail -n 160 ffbuild/config.log >&2
      exit 1
    }
  make -j"$jobs" "$binary"
  if [[ $target == win32-x64 ]]; then
    # The executable must work on a machine without MSYS2 or GCC installed.
    imports=$(objdump -p "$binary")
    if grep -Eqi 'DLL Name: (msys-|libgcc|libwinpthread|libstdc\+\+)' <<< "$imports"; then
      echo 'FFmpeg unexpectedly depends on MSYS2 or MinGW runtime DLLs.' >&2
      exit 1
    fi
  fi
  "./$binary" -version > ../build.txt
  "./$binary" -buildconf >> ../build.txt 2>&1
  if grep -q -- '--enable-nonfree' ../build.txt; then
    echo 'Cannot distribute a nonfree FFmpeg build.' >&2
    exit 1
  fi
  decoders=$("./$binary" -hide_banner -decoders)
  grep -Eq "[[:space:]]libdav1d[[:space:]]" <<< "$decoders"
  devices=$("./$binary" -hide_banner -devices)
  grep -Eq "[[:space:]]lavfi[[:space:]]" <<< "$devices"
  encoders=$("./$binary" -hide_banner -encoders)
  for encoder in libx264 aac libvpx-vp9 libopus libmp3lame libwebp gif png; do
    grep -Eq "[[:space:]]$encoder[[:space:]]" <<< "$encoders"
  done
)

mkdir -p corresponding/scripts corresponding/resources/licenses
cp "$root/scripts/build-ffmpeg.sh" corresponding/scripts/
cp -R "$licenses" corresponding/resources/licenses/ffmpeg
cp build.txt corresponding/resources/licenses/ffmpeg/
tar -czf "$source_archive" -C corresponding .
mkdir -p "$out"
rm -f "$out/recipe"
install -m 755 "ffmpeg/$binary" "$out/$binary"
cp build.txt "$source_archive" "$out/"
printf '%s\n' "$recipe_hash" > "$out/recipe"
echo "Built FFmpeg and corresponding source archive: $target"
