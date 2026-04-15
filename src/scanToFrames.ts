import { scan } from "./scanner";
import { detectRegions, type Region } from "./regions";
import { framesFromRegions, type Frame } from "./frame";

export function scanToFrames(
  text: string,
  charWidth: number,
  charHeight: number,
): {
  frames: Frame[];
  prose: { startRow: number; text: string }[];
  regions: Region[];
} {
  const scanResult = scan(text);
  const regions = detectRegions(scanResult);
  const { frames, prose } = framesFromRegions(regions, charWidth, charHeight);
  return { frames, prose, regions };
}
