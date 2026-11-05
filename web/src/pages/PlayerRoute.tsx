import { useParams } from "react-router-dom";
import PlayerPage from "./Player";

/** Remount player when hash/file changes so URL navigation loads a fresh file. */
export default function PlayerRoute() {
  const { infoHash, fileIndex } = useParams();
  return <PlayerPage key={`${infoHash ?? ""}-${fileIndex ?? ""}`} />;
}
