#!/usr/bin/env bash
# usage: req.sh <name> <kind:search|other> <path-and-query>
# Enforces >=2s spacing across all requests, keeps counts, saves headers/body/timing.
set -u
name=$1; kind=$2; path=$3
base=https://vector-nusmods.jacobjameswiltshire.workers.dev
d=/tmp/vnm-repro
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
last=$(cat $d/.last 2>/dev/null || echo 0)
now=$(python3 -c 'import time;print(time.time())')
wait=$(python3 -c "print(max(0, 2.05-($now-$last)))")
python3 -c "import time;time.sleep($wait)"
python3 -c 'import time;print(time.time())' > $d/.last
cnt=$d/.count_$kind; n=$(( $(cat $cnt 2>/dev/null || echo 0) + 1 )); echo $n > $cnt
timing=$(curl -sS -A "$UA" -D $d/raw/$name.headers -o $d/raw/$name.body \
  -w 'http=%{http_code} dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}' "$base$path")
cache=$(grep -i '^cf-cache-status' $d/raw/$name.headers | tr -d '\r' | sed 's/^[^:]*: //')
st=$(grep -i '^server-timing' $d/raw/$name.headers | tr -d '\r')
srv=$(python3 -c "import re;t='$timing';c=float(re.search(r'tls=([\d.]+)',t)[1]);f=float(re.search(r'ttfb=([\d.]+)',t)[1]);print(round((f-c)*1000))")
line="[$kind#$n] $name GET $path | $timing | ttfb-tls(server~)=${srv}ms | cf-cache-status=${cache:-<absent>} | server-timing=${st:-<absent>}"
echo "$line" | tee -a $d/requests.log
