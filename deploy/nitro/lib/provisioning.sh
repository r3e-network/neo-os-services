#!/usr/bin/env bash
# Shared, Node-free helpers for the Nitro host provisioning ceremony.
# Callers are expected to run with `set -euo pipefail`.

neoos_env_value() { # $1=file $2=key
  local env_path="$1"
  local env_key="$2"
  [[ -r "$env_path" ]] || return 0
  awk -v wanted="$env_key" '
    {
      sub(/\r$/, "", $0)
      if ($0 ~ /^[[:space:]]*($|#)/) next
      separator = index($0, "=")
      if (separator <= 1) next
      key = substr($0, 1, separator - 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key != wanted) next
      value = substr($0, separator + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      selected = value
      found = 1
    }
    END { if (found) print selected }
  ' "$env_path"
}

neoos_first_env_value() { # $1=file $2..=keys
  local env_path="$1"
  shift
  local env_key value
  for env_key in "$@"; do
    value="$(neoos_env_value "$env_path" "$env_key")"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
  done
}

neoos_require_printable_token() { # $1=token $2=context
  local token="$1"
  local context="$2"
  if ! printf '%s' "$token" | LC_ALL=C grep -Eq '^[!-~]{8,512}$'; then
    echo "$context requires an 8-512 character printable ASCII bearer token" >&2
    return 1
  fi
}

neoos_require_base64() { # $1=value $2=name
  local value="$1"
  local name="$2"
  if [[ -z "$value" ]] || ! printf '%s' "$value" | grep -Eq '^[A-Za-z0-9+/]+={0,2}$'; then
    echo "$name must be non-empty base64" >&2
    return 1
  fi
}

neoos_fetch_imds_credentials() {
  local metadata_token role credentials
  metadata_token="$(
    curl --fail --silent --show-error --max-time 5 \
      --request PUT \
      --header 'X-aws-ec2-metadata-token-ttl-seconds: 600' \
      http://169.254.169.254/latest/api/token
  )" || return 1
  [[ -n "$metadata_token" ]] || return 1

  role="$(
    curl --fail --silent --show-error --max-time 5 \
      --header @<(printf 'X-aws-ec2-metadata-token: %s\n' "$metadata_token") \
      http://169.254.169.254/latest/meta-data/iam/security-credentials/
  )" || return 1
  role="${role//$'\r'/}"
  role="${role//$'\n'/}"
  if [[ ! "$role" =~ ^[A-Za-z0-9+=,.@_-]{1,128}$ ]]; then
    echo 'IMDSv2 returned an invalid or empty role name' >&2
    return 1
  fi

  credentials="$(
    curl --fail --silent --show-error --max-time 5 \
      --header @<(printf 'X-aws-ec2-metadata-token: %s\n' "$metadata_token") \
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/${role}"
  )" || return 1

  NEOOS_AWS_ACCESS_KEY_ID="$(printf '%s' "$credentials" | jq -er '.AccessKeyId | select(type == "string" and length > 0)')" || return 1
  NEOOS_AWS_SECRET_ACCESS_KEY="$(printf '%s' "$credentials" | jq -er '.SecretAccessKey | select(type == "string" and length > 0)')" || return 1
  NEOOS_AWS_SESSION_TOKEN="$(printf '%s' "$credentials" | jq -er '.Token // "" | select(type == "string")')" || return 1
  export NEOOS_AWS_ACCESS_KEY_ID NEOOS_AWS_SECRET_ACCESS_KEY NEOOS_AWS_SESSION_TOKEN
}

neoos_post_json() { # $1=url $2=bearer $3=json
  local url="$1"
  local bearer="$2"
  local payload="$3"
  local response_file http_status
  response_file="$(mktemp)"
  if ! http_status="$(
    printf '%s' "$payload" | curl --silent --show-error --max-time 30 \
      --request POST \
      --header 'Content-Type: application/json' \
      --header @<(printf 'Authorization: Bearer %s\n' "$bearer") \
      --data-binary @- \
      --output "$response_file" \
      --write-out '%{http_code}' \
      "$url"
  )"; then
    rm -f -- "$response_file"
    return 1
  fi

  NEOOS_HTTP_STATUS="$http_status"
  NEOOS_HTTP_BODY="$(<"$response_file")"
  rm -f -- "$response_file"

  if [[ ! "$http_status" =~ ^2[0-9][0-9]$ ]]; then
    echo "provisioning request failed: HTTP ${http_status}" >&2
    return 1
  fi
}
