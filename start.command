#!/bin/sh
cd "$(dirname "$0")"
( sleep 2; URL=http://localhost:3000; if command -v xdg-open >/dev/null 2>&1; then xdg-open $URL; else open $URL; fi ) >/dev/null 2>&1 &
node server.js
