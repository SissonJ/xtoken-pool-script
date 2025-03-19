#!/bin/bash

ARGS="$@"

cd /root/xtoken-pool-script
while true; do
  ts-node --esm ./index.ts $1 >> ./logs/"$(date +%Y-%m-%d).log" 2>&1
  sleep $2
done 
