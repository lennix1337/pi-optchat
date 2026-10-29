# Browser image for isolated computers (T06). Built locally by the operator's machine; never pulled at run time.
# Chromium from Alpine plus a pinned agent-browser that drives it; runs as user 1000 like the base computer image.
#   docker build -f assistant/computer/browser.Dockerfile -t optchat-computer-browser:1 assistant/computer
FROM node:22.23.4-alpine3.23
RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont font-noto \
 && npm install -g --no-audit --no-fund agent-browser@0.38.2 \
 && npm cache clean --force
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    AGENT_BROWSER_ARGS="--no-sandbox --disable-dev-shm-usage --disable-gpu" \
    HOME=/work
USER 1000
WORKDIR /work
