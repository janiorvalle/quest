#!/bin/sh
set -eu

repo="${QUEST_INSTALL_REPO:-janiorvalle/quest}"
install_dir="${QUEST_INSTALL_DIR:-$HOME/.local/bin}"
base_url="${QUEST_INSTALL_BASE_URL:-}"
api_base_url="${QUEST_INSTALL_API_BASE_URL:-https://api.github.com}"
version="${QUEST_INSTALL_VERSION:-}"
release_tag="${QUEST_INSTALL_TAG:-}"
local_artifact="${QUEST_INSTALL_ARTIFACT:-}"
local_checksums="${QUEST_INSTALL_CHECKSUMS:-}"
github_token="${QUEST_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"

fail() {
  printf 'quest installer: %s\n' "$*" >&2
  exit 1
}

github_api_get() {
  if [ -n "$github_token" ]; then
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer $github_token" \
      -H "User-Agent: quest-installer" \
      "$1"
  else
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: quest-installer" \
      "$1"
  fi
}

github_asset_download() {
  if [ -n "$github_token" ]; then
    curl -fsSL \
      -H "Accept: application/octet-stream" \
      -H "Authorization: Bearer $github_token" \
      -H "User-Agent: quest-installer" \
      "$1" -o "$2"
  else
    curl -fsSL "$1" -o "$2"
  fi
}

release_asset_url() {
  target_name=$1
  printf '%s\n' "$release_json" | tr '{},' '\n' | awk -v target="$target_name" '
    /"url"[[:space:]]*:/ {
      value = $0
      sub(/^.*"url"[[:space:]]*:[[:space:]]*"/, "", value)
      sub(/".*$/, "", value)
      current_url = value
    }
    /"name"[[:space:]]*:/ {
      value = $0
      sub(/^.*"name"[[:space:]]*:[[:space:]]*"/, "", value)
      sub(/".*$/, "", value)
      if (value == target) {
        print current_url
        exit
      }
    }
  '
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported operating system; Windows users should run install.ps1" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

if [ -z "$version" ]; then
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  api_base_url=${api_base_url%/}
  release_json=$(github_api_get "$api_base_url/repos/$repo/releases/latest") ||
    fail "no published release found for $repo; set QUEST_GITHUB_TOKEN for a private repository"
  release_tag=$(printf '%s\n' "$release_json" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1)
  [ -n "$release_tag" ] || fail "latest release did not include a tag_name"
  version=${release_tag#v}
fi
version=${version#v}
[ -n "$release_tag" ] || release_tag="v$version"
api_base_url=${api_base_url%/}
if [ -n "$github_token" ] && [ -z "${release_json:-}" ] &&
  [ -z "$local_artifact" ] && [ -z "$local_checksums" ]; then
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  release_json=$(github_api_get "$api_base_url/repos/$repo/releases/tags/$release_tag") ||
    fail "could not read release metadata for $repo; check the token and release tag"
fi
artifact_name="quest-${version}-${os}-${arch}"

tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t quest-install)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
artifact="$tmp_dir/$artifact_name"
checksums="$tmp_dir/checksums.txt"
smoke_home="$tmp_dir/smoke-home"
smoke_config="$smoke_home/config"
smoke_state="$smoke_home/state"
mkdir -p "$smoke_config" "$smoke_state"

quest_version() {
  HOME="$smoke_home" \
    USERPROFILE="$smoke_home" \
    XDG_CONFIG_HOME="$smoke_config" \
    XDG_STATE_HOME="$smoke_state" \
    APPDATA="$smoke_config" \
    LOCALAPPDATA="$smoke_state" \
    "$1" --version
}

if [ -n "$local_artifact" ] || [ -n "$local_checksums" ]; then
  [ -n "$local_artifact" ] && [ -n "$local_checksums" ] ||
    fail "QUEST_INSTALL_ARTIFACT and QUEST_INSTALL_CHECKSUMS must be set together"
  cp "$local_artifact" "$artifact"
  cp "$local_checksums" "$checksums"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  if [ -n "$github_token" ]; then
    artifact_url=$(release_asset_url "$artifact_name")
    checksum_url=$(release_asset_url "checksums.txt")
    [ -n "$artifact_url" ] || fail "release metadata has no asset named $artifact_name"
    [ -n "$checksum_url" ] || fail "release metadata has no asset named checksums.txt"
    github_asset_download "$artifact_url" "$artifact" ||
      fail "could not download $artifact_name from the GitHub release API"
    github_asset_download "$checksum_url" "$checksums" ||
      fail "could not download checksums.txt from the GitHub release API"
  else
    if [ -z "$base_url" ]; then
      base_url="https://github.com/$repo/releases/download/$release_tag"
    fi
    base_url=${base_url%/}
    curl -fsSL "$base_url/$artifact_name" -o "$artifact" ||
      fail "could not download $artifact_name"
    curl -fsSL "$base_url/checksums.txt" -o "$checksums" ||
      fail "could not download checksums.txt"
  fi
fi

expected=$(awk -v file="$artifact_name" '$2 == file || $2 == "*" file { print $1; exit }' "$checksums")
[ -n "$expected" ] || fail "checksums.txt has no entry for $artifact_name"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$artifact" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$artifact" | awk '{print $1}')
else
  fail "sha256sum or shasum is required to verify the download"
fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $artifact_name"

chmod 0755 "$artifact"
reported_version=$(quest_version "$artifact") || fail "downloaded quest failed its version smoke test"
[ "$reported_version" = "quest $version" ] ||
  fail "downloaded quest reported $reported_version instead of quest $version"

mkdir -p "$install_dir"
stage="$install_dir/.quest.new.$$"
previous="$install_dir/.quest.previous.$$"

finish_install() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ ! -e "$install_dir/quest" ] && [ -e "$previous" ]; then
    mv -f "$previous" "$install_dir/quest" ||
      printf 'quest installer: could not restore the previous binary at %s/quest\n' "$install_dir" >&2
  fi
  rm -f "$stage" "$previous"
  exit "$status"
}
trap finish_install EXIT HUP INT TERM

cp "$artifact" "$stage"
chmod 0755 "$stage"
if [ -e "$install_dir/quest" ]; then
  cp "$install_dir/quest" "$previous"
fi
# Unlink before rename: replacing a running signed binary in place can invalidate macOS's signature cache.
rm -f "$install_dir/quest"
mv -f "$stage" "$install_dir/quest"
quest_version "$install_dir/quest" >/dev/null ||
  fail "installed quest failed its version smoke test"

printf 'Installed quest %s to %s/quest\n' "$version" "$install_dir"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf 'Add %s to PATH to run quest from any directory.\n' "$install_dir" ;;
esac

trap - EXIT HUP INT TERM
rm -f "$previous"
