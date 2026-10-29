# Separate opt-in image; does not replace the existing offline browser image.
# docker build -f assistant/computer/egress.Dockerfile -t optchat-computer-browser-egress:1 assistant/computer
FROM optchat-computer-browser:1
USER root
RUN apk add --no-cache openssl nss-tools
COPY https-relay.mjs relay-policy.mjs /opt/optchat/
USER 1000
