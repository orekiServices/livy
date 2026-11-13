#!/usr/bin/env bash
#
# Build metrofx for every Linux architecture Livy is likely to meet,
# from one machine, with no Docker and no root.
#
# Cross-linking C-free Rust still needs a linker that knows the target's libc.
# Zig ships one for every target in a single tarball, and `cargo-zigbuild`
# teaches cargo to use it — which is how this produces glibc *and* musl,
# x86_64 *and* arm, from an ordinary x86_64 box.
#
#   ./scripts/build-linux-universal.sh            # everything below
#   ./scripts/build-linux-universal.sh aarch64-unknown-linux-musl
#
# glibc builds are pinned to an old floor (2.17, CentOS 7 era) so one binary
# runs on every distro still in service — a binary built against the host's
# glibc would refuse to load on anything older than the build machine.
#
# Output: metrofx.linux-<arch>-<abi>.node next to index.js, which is exactly
# where the loader looks.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
TOOLS="${METROFX_TOOLS:-$HOME/.toolchain}"
ZIG_VERSION="0.13.0"

TARGETS=(
  x86_64-unknown-linux-gnu
  aarch64-unknown-linux-gnu
  x86_64-unknown-linux-musl
  aarch64-unknown-linux-musl
  armv7-unknown-linux-gnueabihf
)
[ $# -gt 0 ] && TARGETS=("$@")

# The oldest glibc the binaries must run on. zig links against exactly this,
# so the result works on anything newer — which is everything.
GLIBC="${METROFX_GLIBC:-2.17}"

# node's own naming, which the loader in index.js expects
node_name() {
  case "$1" in
    x86_64-unknown-linux-gnu)      echo "metrofx.linux-x64-gnu.node" ;;
    x86_64-unknown-linux-musl)     echo "metrofx.linux-x64-musl.node" ;;
    aarch64-unknown-linux-gnu)     echo "metrofx.linux-arm64-gnu.node" ;;
    aarch64-unknown-linux-musl)    echo "metrofx.linux-arm64-musl.node" ;;
    armv7-unknown-linux-gnueabihf) echo "metrofx.linux-arm-gnueabihf.node" ;;
    *) echo "metrofx.$1.node" ;;
  esac
}

export PATH="$HOME/.cargo/bin:$TOOLS/zig:$PATH"

if ! command -v cargo >/dev/null; then
  echo "cargo not found — install Rust first: https://rustup.rs"
  exit 1
fi

# ---- zig, for the cross linkers -------------------------------------------
if ! command -v zig >/dev/null; then
  echo "· fetching zig $ZIG_VERSION"
  mkdir -p "$TOOLS/zig"
  curl -sSL "https://ziglang.org/download/$ZIG_VERSION/zig-linux-$(uname -m)-$ZIG_VERSION.tar.xz" -o "$TOOLS/zig.tar.xz"
  tar -xJf "$TOOLS/zig.tar.xz" -C "$TOOLS/zig" --strip-components=1
  rm "$TOOLS/zig.tar.xz"
fi

command -v cargo-zigbuild >/dev/null || { echo "· installing cargo-zigbuild"; cargo install cargo-zigbuild --locked; }

# ---- build -----------------------------------------------------------------
built=()
for target in "${TARGETS[@]}"; do
  echo "· $target"
  rustup target add "$target" >/dev/null 2>&1 || true

  # musl links statically by default, and a static crt cannot produce the
  # shared object a Node addon *is* — so ask for a dynamic one.
  flags="${RUSTFLAGS:-}"
  case "$target" in
    *-musl) flags="$flags -C target-feature=-crt-static" ;;
  esac

  # Pin glibc builds to the floor; musl has no such problem.
  case "$target" in
    *-musl) zigtarget="$target" ;;
    *)      zigtarget="$target.$GLIBC" ;;
  esac

  RUSTFLAGS="$flags" cargo zigbuild --release --target "$zigtarget"

  out="$ROOT/$(node_name "$target")"
  cp "target/$target/release/libmetrofx.so" "$out"
  built+=("$(basename "$out") $(du -h "$out" | cut -f1)")
done

echo
echo "built:"
printf '  %s\n' "${built[@]}"
echo
echo "The loader picks the right one at require() time; extra binaries are"
echo "simply ignored on machines they do not fit."
