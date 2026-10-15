ARG BUILD_FROM
FROM $BUILD_FROM

# psycopg2 from Alpine (prebuilt for this image's musl/python — avoids the
# cpython-ABI segfault documented in the project CLAUDE.md). The rest are
# pure-python / musllinux-wheel packages, so no build toolchain is needed.
RUN apk add --no-cache python3 py3-pip py3-psycopg2 \
    && pip3 install --no-cache-dir --break-system-packages \
         "flask==3.0.3" "paho-mqtt==2.1.0" "requests==2.32.3" "waitress==3.0.0" "websocket-client==1.8.0"

# Vendor Leaflet into the image so the sidebar panel needs no CDN at runtime.
ARG LEAFLET_VERSION=1.9.4
RUN mkdir -p /app/static/vendor/images \
    && cd /app/static/vendor \
    && wget -qO leaflet.js  "https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js" \
    && wget -qO leaflet.css "https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css" \
    && for img in marker-icon.png marker-icon-2x.png marker-shadow.png layers.png layers-2x.png; do \
         wget -qO "images/$img" "https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/images/$img" || true; \
       done

# CARTO "Voyager" is now a VECTOR GL basemap (its raster CDN is key-gated). Render it inside Leaflet via
# maplibre-gl + maplibre-gl-leaflet (vendored; the style/tiles themselves are keyless).
ARG MAPLIBRE_VERSION=4.7.1
ARG MGL_LEAFLET_VERSION=0.0.22
RUN cd /app/static/vendor \
    && wget -qO maplibre-gl.js  "https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js" \
    && wget -qO maplibre-gl.css "https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css" \
    && wget -qO leaflet-maplibre-gl.js "https://unpkg.com/@maplibre/maplibre-gl-leaflet@${MGL_LEAFLET_VERSION}/leaflet-maplibre-gl.js" \
    && wget -qO Leaflet.GoogleMutant.js "https://unpkg.com/leaflet.gridlayer.googlemutant@0.14.1/dist/Leaflet.GoogleMutant.js"

COPY app /app
COPY run.sh /
RUN chmod a+x /run.sh

CMD ["/run.sh"]
