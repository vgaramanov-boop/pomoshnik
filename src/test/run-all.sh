#!/bin/bash
# Поднимает тестовое окружение и запускает указанный тест. $1 = тест (e2e.js / e2e-web.js), $2 = режим (peerjs|mqtt)
cd /home/claude/semhelp
pkill -f "remote-debugging-port=930" ; pkill -f "Xvfb :99"; pkill -f test/relay.js; pkill -f "http.server 8080"; sleep 0.5
rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock
Xvfb :99 -screen 0 1600x900x24 >/dev/null 2>&1 &
node test/relay.js > /tmp/relay.log 2>&1 &
python3 web/build-web.py /tmp/webtest --test >/dev/null && python3 -m http.server 8080 -d /tmp/webtest -b 127.0.0.1 > /tmp/http.log 2>&1 &
rm -rf testapp && cp -r app testapp && sed -i 's#connect-src #connect-src ws://127.0.0.1:8765 #' testapp/ui/index.html
rm -rf /tmp/prof-* ~/Videos/Помощник
for i in $(seq 1 30); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.3; done; sleep 1
/tmp/run.sh host 9301 ${2:-mqtt} &
[ "$1" = "e2e.js" ] && /tmp/run.sh helper 9302 ${2:-mqtt} &
sleep 7
cd test && NODE_PATH=$(npm root -g) timeout 170 node "$1" 2>&1 | grep -v dbus
pkill -f "remote-debugging-port=930"; pkill -f "Xvfb :99"; pkill -f test/relay.js; pkill -f "http.server 8080"
exit 0
