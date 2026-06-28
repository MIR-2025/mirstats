#!/bin/sh
#
# fetch-geo.sh -- download the DB-IP Lite country database for the geolocation
# breakdown. It is free (CC-BY 4.0), needs no account, and is served directly
# from a CDN. Re-run monthly to refresh; DB-IP updates the lite DB each month.
#
# Usage:  ./tools/fetch-geo.sh            # writes data/geo-country-ipv4.csv
#         GEO_DEST=/path ./fetch-geo.sh   # override the destination dir
#
# Source: https://github.com/sapics/ip-location-db  (DB-IP Lite, CC-BY 4.0)

set -eu

DEST="${GEO_DEST:-$(CDPATH= cd -- "$(dirname -- "$0")/../data" && pwd)}"
URL="https://cdn.jsdelivr.net/npm/@ip-location-db/dbip-country/dbip-country-ipv4.csv"
OUT="$DEST/geo-country-ipv4.csv"

mkdir -p "$DEST"
echo "Downloading DB-IP Lite country DB → $OUT"
if command -v curl >/dev/null 2>&1; then
  curl -fSL --retry 3 -o "$OUT.tmp" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$OUT.tmp" "$URL"
else
  echo "need curl or wget" >&2; exit 2
fi
mv "$OUT.tmp" "$OUT"
echo "Done: $(wc -l < "$OUT" | tr -d ' ') ranges. Restart MIR Sentinel to load it."
echo "Data © DB-IP (https://db-ip.com), licensed CC-BY 4.0."
