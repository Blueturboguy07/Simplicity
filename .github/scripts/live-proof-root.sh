#!/bin/bash
# CI only (.github/workflows/live-update-proof.yml, macOS runners). Not part of the app.
# The steps of the live update proof that need root on the runner:
#   gatekeeper                     prints spctl --status; turns assessments on if they are off
#   tcc-grant <id> <dr file> <out> writes REAL grants (camera, microphone, screen capture, accessibility) for
#                                  bundle ID <id> into the user and the system TCC database. Each row stores
#                                  the app's designated requirement as a csreq blob, as tccd does on "Allow".
#   tcc-check <id> <app> <out>     prints each row and checks that <app> satisfies the stored requirement
#                                  (codesign --verify -R): the check tccd makes before it uses a grant
#   net-start <file> / net-stop    a packet log of DNS queries and TCP connects, with the process name
set -euo pipefail
SERVICES="kTCCServiceCamera kTCCServiceMicrophone kTCCServiceScreenCapture kTCCServiceAccessibility"
USER_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
SYSTEM_DB="/Library/Application Support/com.apple.TCC/TCC.db"
q() { sudo sqlite3 "$@"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  gatekeeper)
    spctl --status 2>&1 || true
    if ! spctl --status 2>&1 | grep -q 'assessments enabled'; then
      sudo spctl --master-enable 2>&1 || true
      spctl --status 2>&1 || true
    fi ;;
  tcc-grant)
    id="$1"; dr="$2"; out="$3"
    csreq -r "$dr" -b "$out/csreq.bin"
    hex="$(xxd -p "$out/csreq.bin" | tr -d '\n')"
    for db in "$USER_DB" "$SYSTEM_DB"; do
      tag=user; [ "$db" = "$SYSTEM_DB" ] && tag=system
      q "$db" '.schema access' > "$out/tcc-schema-$tag.sql"
      cols=" $(q "$db" 'PRAGMA table_info(access);' | cut -d'|' -f2 | tr '\n' ' ')"
      for c in service client client_type auth_value auth_reason auth_version csreq flags; do
        case "$cols" in *" $c "*) ;; *) echo "TCC $tag: this schema has no column $c"; exit 1 ;; esac
      done
      for s in $SERVICES; do
        q "$db" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, flags) VALUES ('$s', '$id', 0, 2, 2, 1, X'$hex', 0);"
        echo "TCC $tag $s granted"
      done
    done ;;
  tcc-check)
    id="$1"; app="$2"; out="$3"; fail=0
    for db in "$USER_DB" "$SYSTEM_DB"; do
      tag=user; [ "$db" = "$SYSTEM_DB" ] && tag=system
      for s in $SERVICES; do
        where="service='$s' AND client='$id' AND client_type=0"
        row="$(q -separator ' ' "$db" "SELECT auth_value, auth_reason, length(csreq) FROM access WHERE $where;")"
        if [ -z "$row" ]; then echo "TCC $tag $s MISSING"; fail=1; continue; fi
        blob="$out/csreq-$tag-$s.bin"
        q "$db" "SELECT hex(csreq) FROM access WHERE $where;" | xxd -r -p > "$blob"
        req="$(csreq -r "$blob" -t)"
        if codesign --verify --test-requirement="=$req" "$app" 2> "$out/tcc-verify-$tag-$s.txt"; then v=satisfied; else v=NOT-SATISFIED; fail=1; fi
        set -- $row
        echo "TCC $tag $s auth_value=$1 auth_reason=$2 csreq_bytes=$3 requirement=$v :: $req"
      done
    done
    exit "$fail" ;;
  net-start)
    file="$1"
    sudo tcpdump -i pktap,all -k NP -n -l -tttt 'udp port 53 or (tcp[tcpflags] & (tcp-syn|tcp-ack) == tcp-syn)' > "$file" 2>&1 &
    sleep 2
    if ! pgrep -x tcpdump > /dev/null; then
      echo "pktap capture did not start; capturing on en0 without process names" >> "$file"
      sudo tcpdump -i en0 -n -l -tttt 'udp port 53 or (tcp[tcpflags] & (tcp-syn|tcp-ack) == tcp-syn)' >> "$file" 2>&1 &
      sleep 2
    fi
    pgrep -x tcpdump > /dev/null && echo "capture running" ;;
  net-stop)
    sudo pkill -INT -x tcpdump || true ;;
  *)
    echo "usage: live-proof-root.sh gatekeeper|tcc-grant|tcc-check|net-start|net-stop ..."; exit 2 ;;
esac
