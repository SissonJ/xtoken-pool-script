#!/bin/bash

cd /root/xtoken-pool-script
ts-node --esm ./index.ts >> ./logs/"$(date +%Y-%m-%d).log" 2>&1
