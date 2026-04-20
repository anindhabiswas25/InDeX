#!/bin/bash
cd /home/asus/Project/Initia/backend
exec node dist/index.js >> /tmp/backend.log 2>&1
