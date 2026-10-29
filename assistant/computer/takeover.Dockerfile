FROM optchat-computer-browser:1
USER root
RUN apk add --no-cache xvfb x11vnc websockify socat \
 && mkdir -p /opt/optchat/takeover \
 && npm install --prefix /opt/optchat/takeover --no-audit --no-fund @novnc/novnc@1.5.0 esbuild@0.25.11 \
 && npm cache clean --force
COPY takeover-client.js takeover.html /opt/optchat/takeover/
RUN cd /opt/optchat/takeover && ./node_modules/.bin/esbuild takeover-client.js --bundle --outfile=public/takeover-client.js && cp takeover.html public/index.html
COPY takeover-session.sh /opt/optchat/takeover-session.sh
USER 1000
WORKDIR /work
