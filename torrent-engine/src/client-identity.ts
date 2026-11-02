export function clientSessionSettings(opts: {
  userAgent?: string | null;
  peerFingerprint?: string | null;
  handshakeClientVersion?: string | null;
} = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const { userAgent, peerFingerprint, handshakeClientVersion } = opts;

  if (userAgent) out.user_agent = userAgent;
  if (peerFingerprint) out.peer_fingerprint = peerFingerprint;
  if (handshakeClientVersion) {
    out.handshake_client_version = handshakeClientVersion;
  } else if (userAgent) {
    out.handshake_client_version = userAgent.replace(/\//, " ");
  }
  return out;
}
