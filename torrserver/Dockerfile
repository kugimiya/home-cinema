FROM alpine:3.20
ARG TS_VERSION=MatriX.148
ARG TARGETARCH
RUN TS_ARCH=linux-amd64; \
  if [ "$TARGETARCH" = "arm64" ]; then TS_ARCH=linux-arm64; fi; \
  apk add --no-cache ca-certificates wget \
  && wget -qO /usr/local/bin/torrserver \
    "https://github.com/YouROK/TorrServer/releases/download/${TS_VERSION}/TorrServer-${TS_ARCH}" \
  && chmod +x /usr/local/bin/torrserver

EXPOSE 8090
VOLUME ["/config", "/torrents"]
ENTRYPOINT ["/usr/local/bin/torrserver", "-p", "8090", "-d", "/config", "-k"]
