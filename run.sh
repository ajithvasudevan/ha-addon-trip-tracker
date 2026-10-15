#!/usr/bin/with-contenv bashio
set -e

# ---------------------------------------------------------------------------
# Credential resolution order for each secret:
#   1. an explicit add-on option (Configuration tab)
#   2. (MQTT only) the Supervisor-provided mqtt service (mqtt:want)
#   3. /config/secrets.yaml (recorder_db_url / immich_key) — config:ro mapped
# Nothing sensitive is baked into the image or committed to git.
# ---------------------------------------------------------------------------

secret() {
  # read a top-level key from secrets.yaml if present; never fail the script
  local key="$1" f="/config/secrets.yaml"
  [ -f "$f" ] || f="/homeassistant/secrets.yaml"
  [ -f "$f" ] || { echo ""; return 0; }
  grep "^${key}:" "$f" 2>/dev/null | head -1 | sed -E 's/^[^:]+: *"?([^"]*)"?$/\1/' || true
}

DB_URI="$(bashio::config 'db_uri')"
if bashio::var.is_empty "${DB_URI}"; then DB_URI="$(secret recorder_db_url)"; fi

IMMICH_URL="$(bashio::config 'immich_url')"
IMMICH_KEY="$(bashio::config 'immich_key')"
if bashio::var.is_empty "${IMMICH_KEY}"; then IMMICH_KEY="$(secret immich_key)"; fi

# HA Core API — used only to resolve which ingress users are admins (config/auth/list over WS).
HA_URL="$(bashio::config 'ha_url')"
if bashio::var.is_empty "${HA_URL}"; then HA_URL="http://homeassistant:8123"; fi
HA_TOKEN="$(bashio::config 'ha_token')"
if bashio::var.is_empty "${HA_TOKEN}"; then HA_TOKEN="$(secret ha_long_lived_token)"; fi

MQTT_HOST="$(bashio::config 'mqtt_host')"
MQTT_PORT="$(bashio::config 'mqtt_port')"
MQTT_USER="$(bashio::config 'mqtt_user')"
MQTT_PASSWORD="$(bashio::config 'mqtt_password')"
if bashio::var.is_empty "${MQTT_HOST}"; then
  if bashio::services.available "mqtt"; then
    MQTT_HOST="$(bashio::services 'mqtt' 'host')"
    MQTT_PORT="$(bashio::services 'mqtt' 'port')"
    MQTT_USER="$(bashio::services 'mqtt' 'username')"
    MQTT_PASSWORD="$(bashio::services 'mqtt' 'password')"
    bashio::log.info "Using Supervisor MQTT service at ${MQTT_HOST}:${MQTT_PORT}"
  else
    MQTT_HOST="172.20.1.100"
    bashio::log.warning "No mqtt_host option and no Supervisor MQTT service — defaulting host to ${MQTT_HOST}; set mqtt_user/mqtt_password in the Configuration tab."
  fi
fi
if bashio::var.is_empty "${MQTT_PORT}" || [ "${MQTT_PORT}" = "0" ]; then MQTT_PORT=1883; fi

if [ -z "${DB_URI}" ]; then
  bashio::exit.nok "db_uri is empty and recorder_db_url was not found in secrets.yaml — set 'db_uri' in the Configuration tab."
fi
if [ -z "${IMMICH_KEY}" ]; then
  bashio::log.warning "immich_key is empty — photo markers are disabled until it is set."
fi

export TT_DB_URI="${DB_URI}"
export TT_HA_URL="${HA_URL}"
export TT_HA_TOKEN="${HA_TOKEN}"
export TT_IMMICH_URL="${IMMICH_URL}"
export TT_IMMICH_KEY="${IMMICH_KEY}"
export TT_GOOGLE_MAPS_KEY="$(bashio::config 'google_maps_key')"
export TT_MQTT_HOST="${MQTT_HOST}"
export TT_MQTT_PORT="${MQTT_PORT}"
export TT_MQTT_USER="${MQTT_USER}"
export TT_MQTT_PASSWORD="${MQTT_PASSWORD}"
export TT_BASE_TOPIC="$(bashio::config 'base_topic')"
export TT_PHOTO_POLL_S="$(bashio::config 'photo_poll_s')"
export TT_MATCH_TOLERANCE_S="$(bashio::config 'match_tolerance_s')"
export TT_NEAR_TRACK_RADIUS_M="$(bashio::config 'near_track_radius_m')"
export TT_MAX_SPEED_KMPH="$(bashio::config 'max_speed_kmph')"
export TT_MAP_CENTER_LAT="$(bashio::config 'map_center_lat')"
export TT_MAP_CENTER_LON="$(bashio::config 'map_center_lon')"
export TT_MAP_ZOOM="$(bashio::config 'map_zoom')"
export TT_LOG_LEVEL="$(bashio::config 'log_level')"

bashio::log.info "Trip Tracker starting — ingress :8098, mqtt ${MQTT_HOST}:${MQTT_PORT}, base '${TT_BASE_TOPIC}'"
exec python3 /app/server.py
