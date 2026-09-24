#!/usr/bin/env bash
# Static guard over .github/dependabot.yml.
#
# Background: this repo (and the eight sibling platform repos) shipped a
# dependabot.yml whose every entry carried `open-pull-requests-limit: 0`. That
# is the documented switch for "version updates off", so the config was inert -
# yet its presence reads to any reviewer as "dependency maintenance is handled".
# Nothing in CI noticed, because nothing in CI looked.
#
# What this catches:
#   1. `open-pull-requests-limit: 0` returning - the exact original defect.
#   2. An entry with no explicit limit, quietly relying on the default while the
#      file looks deliberately configured.
#   3. An entry with no `groups:` block. Re-enabling without grouping trades one
#      failure (no PRs ever) for another (a PR per dependency per week), and the
#      second one gets "fixed" by setting the limit back to 0.
#   4. A `directory`/`directories` target that holds no manifest for its own
#      ecosystem. Such an entry produces nothing whether or not it is enabled -
#      neo-os-web pointed its docker entry at "/", which has no Dockerfile.
#      Checking only that the path exists would not catch that, since "/" always
#      exists; the check is per-ecosystem for that reason.
#      Limit of this check: it proves a manifest is present, not that Dependabot
#      will anchor on it. neo-os-contracts pointed nuget at "/contracts", which
#      holds Directory.Build.props but no .csproj/.sln; that one still passes
#      here and was fixed by inspection instead.
#
# Parsing: dependabot.yml has a fixed, shallow shape, so this reads it line by
# line rather than pulling in a YAML library the runner may not have. Anything
# it cannot account for is a FAIL, never a silent pass.
#
# Replicating to another repo: copy this file to <repo>/scripts/ and add it to
# that repo's CI as a shell suite. It reads only ROOT_DIR/.github/dependabot.yml
# and is otherwise repo-agnostic.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT_DIR/.github/dependabot.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# True when directory $2 holds at least one manifest the ecosystem $1 can act
# on. Non-recursive on purpose: Dependabot resolves `directory` at that exact
# path, which is precisely the assumption that made the dead entries dead.
has_manifest() {
  local eco="$1" dir="$2"
  case "$eco" in
    npm)    compgen -G "$dir/package.json" >/dev/null ;;
    gomod)  compgen -G "$dir/go.mod" >/dev/null ;;
    nuget)  compgen -G "$dir/*.csproj" >/dev/null ||
            compgen -G "$dir/*.fsproj" >/dev/null ||
            compgen -G "$dir/*.vbproj" >/dev/null ||
            compgen -G "$dir/*.sln" >/dev/null ||
            compgen -G "$dir/packages.config" >/dev/null ||
            compgen -G "$dir/Directory.Build.props" >/dev/null ||
            compgen -G "$dir/Directory.Packages.props" >/dev/null ;;
    docker) compgen -G "$dir/Dockerfile" >/dev/null ||
            compgen -G "$dir/Dockerfile.*" >/dev/null ||
            compgen -G "$dir/*.dockerfile" >/dev/null ;;
    # Actions are read from the workflow files, which live at a fixed path
    # regardless of what `directory` says.
    github-actions) compgen -G "$ROOT_DIR/.github/workflows/*.y*ml" >/dev/null ;;
    *) fail "unknown package-ecosystem '$eco'; extend has_manifest() before adding it" ;;
  esac
}

[ -f "$CONFIG" ] || fail "no .github/dependabot.yml in $ROOT_DIR"

grep -q 'open-pull-requests-limit: *0 *$' "$CONFIG" &&
  fail "dependabot.yml sets 'open-pull-requests-limit: 0'; that disables version updates entirely while leaving the config looking active"

# --- shape walk -------------------------------------------------------------
# Emits one record per line: ENTRY <ecosystem> | LIMIT <n> | GROUPS | PATH <p>
# or BAD <reason>. Comment and blank lines are dropped first.
parse() {
  awk '
    { line = $0 }
    line ~ /^[[:space:]]*#/ { next }
    line ~ /^[[:space:]]*$/ { next }

    # top-level keys
    line ~ /^version:/  { seen_version = 1; next }
    line ~ /^updates:/  { seen_updates = 1; next }

    # list item at 2-space indent opens a new entry
    line ~ /^  - / {
      if (line !~ /^  - package-ecosystem: *([a-z-]+|[\047][a-z-]+[\047]|"[a-z-]+")[[:space:]]*$/) {
        print "BAD unrecognised update entry: " line; next
      }
      eco = line
      sub(/^  - package-ecosystem: *[\047"]?/, "", eco)
      sub(/[\047"]?[[:space:]]*$/, "", eco)
      print "ENTRY " eco
      in_dirs = 0
      next
    }

    # keys at 4-space indent
    line ~ /^    [a-z-]+:/ {
      in_dirs = 0
      if (line ~ /^    open-pull-requests-limit:/) {
        v = line; sub(/^.*: */, "", v); sub(/[[:space:]]*$/, "", v)
        print "LIMIT " v; next
      }
      if (line ~ /^    groups:/)      { print "GROUPS"; next }
      if (line ~ /^    directories:/) { in_dirs = 1; next }
      if (line ~ /^    directory:/) {
        v = line; sub(/^.*: */, "", v); sub(/[[:space:]]*$/, "", v)
        if (v ~ /^[\047]/) {
          if (v !~ /^[\047][^\047]+[\047]$/) { print "BAD unrecognised directory: " line; next }
          sub(/^[\047]/, "", v); sub(/[\047]$/, "", v)
        } else if (v ~ /^"/) {
          if (v !~ /^"[^"]+"$/) { print "BAD unrecognised directory: " line; next }
          sub(/^"/, "", v); sub(/"$/, "", v)
        } else if (v == "" || v ~ /[\047"]/) {
          print "BAD unrecognised directory: " line; next
        }
        print "PATH " v; next
      }
      next
    }

    # list items under directories:
    in_dirs && line ~ /^      - / {
      v = line; sub(/^      - */, "", v); sub(/[[:space:]]*$/, "", v)
      if (v ~ /^[\047]/) {
        if (v !~ /^[\047][^\047]+[\047]$/) { print "BAD unrecognised directory: " line; next }
        sub(/^[\047]/, "", v); sub(/[\047]$/, "", v)
      } else if (v ~ /^"/) {
        if (v !~ /^"[^"]+"$/) { print "BAD unrecognised directory: " line; next }
        sub(/^"/, "", v); sub(/"$/, "", v)
      } else if (v == "" || v ~ /[\047"]/) {
        print "BAD unrecognised directory: " line; next
      }
      print "PATH " v; next
    }

    { next }

    END {
      if (!seen_version) print "BAD file declares no top-level version"
      if (!seen_updates) print "BAD file declares no top-level updates list"
    }
  ' "$CONFIG"
}

entries=0
cur=""
has_limit=0
has_groups=0
has_path=0

finish_entry() {
  [ -n "$cur" ] || return 0
  [ "$has_limit" -eq 1 ] || fail "entry '$cur' declares no open-pull-requests-limit; an entry that looks configured should say what its cap is"
  [ "$has_groups" -eq 1 ] || fail "entry '$cur' declares no groups; ungrouped version updates open one PR per dependency, which is how a repo ends up back at limit 0"
  [ "$has_path" -eq 1 ] || fail "entry '$cur' declares neither directory nor directories"
}

while IFS=' ' read -r kind value; do
  case "$kind" in
    BAD)
      fail "could not parse dependabot.yml: $value"
      ;;
    ENTRY)
      finish_entry
      cur="$value"; has_limit=0; has_groups=0; has_path=0
      entries=$((entries + 1))
      ;;
    LIMIT)
      case "$value" in
        ''|*[!0-9]*) fail "entry '$cur' has a non-numeric open-pull-requests-limit: '$value'" ;;
      esac
      [ "$value" -gt 0 ] || fail "entry '$cur' sets open-pull-requests-limit: $value, which disables version updates"
      has_limit=1
      ;;
    GROUPS)
      has_groups=1
      ;;
    PATH)
      has_path=1
      target="$ROOT_DIR/${value#/}"
      if case "$value" in *[*?]*) true ;; *) false ;; esac; then
        dirs=$(compgen -G "$target" || true)
        [ -n "$dirs" ] || fail "entry '$cur' targets '$value', which matches nothing in this repo"
      else
        [ -d "$target" ] || fail "entry '$cur' targets '$value', which is not a directory in this repo"
        dirs="$target"
      fi
      # A glob is allowed to match directories that hold no manifest (that is
      # the point of a glob); a literal path is not.
      literal=1
      case "$value" in *[*?]*) literal=0 ;; esac
      found_any=0
      while IFS= read -r d; do
        [ -d "$d" ] || continue
        if has_manifest "$cur" "$d"; then found_any=1; fi
      done <<< "$dirs"
      if [ "$found_any" -eq 0 ]; then
        if [ "$literal" -eq 1 ]; then
          fail "entry '$cur' targets '$value', which contains no $cur manifest; that entry can never produce an update"
        else
          fail "entry '$cur' targets '$value', and none of the directories it matches contain a $cur manifest"
        fi
      fi
      ;;
  esac
done < <(parse)

finish_entry

[ "$entries" -gt 0 ] || fail "dependabot.yml declares no update entries"

echo "checked $entries dependabot update entries, all enabled, grouped and pointing at real paths"
echo "dependabot config tests passed"
