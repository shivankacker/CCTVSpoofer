import { cleanStreamUri } from './cameras.js';

const profiles = {
  '360p': { width: 640, height: 360, bitrate: 600 },
  '480p': { width: 854, height: 480, bitrate: 1000 },
  '1080p': { width: 1920, height: 1080, fps: 15, bitrate: 4000 },
  '720p': { width: 1280, height: 720, fps: 15, bitrate: 2500 },
};
const profile = process.env.VIDEO_PROFILE || '1080p';
export const frameRates = Object.freeze([5, 10, 15, 20, 25, 30]);
export function videoSettings(quality, fps) {
  if (!Object.hasOwn(profiles, quality) || !frameRates.includes(fps)) throw new Error('Invalid output quality or FPS.');
  return Object.freeze({ ...profiles[quality], quality, fps });
}
export const video = videoSettings(profile, Number(process.env.VIDEO_FPS || 15));
export const originalVideo = videoSettings('480p', 10);

export function fitFilter(settings) {
  const { width, height, fps } = settings;
  return `setpts=PTS-STARTPTS,fps=${fps},`
    + `scale=w='if(gte(dar,${width}/${height}),${width},max(2,trunc(${height}*dar/2)*2))':`
    + `h='if(gte(dar,${width}/${height}),max(2,trunc(${width}/dar/2)*2),${height})',`
    + `setsar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
}

export function osdFilter(osd, settings) {
  if (!osd) return '';
  const defaultFont = process.platform === 'darwin' ? '/System/Library/Fonts/Supplemental/Arial.ttf'
    : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const { title, fontFile = process.env.OSD_FONT_FILE || defaultFont,
    timeX = 0.65, timeY = 0.045, titleX = 0.02, titleY = 0.92, fontSize = 0.04 } = osd;
  if (typeof title !== 'string' || !/^[A-Za-z0-9 ._-]{1,80}$/.test(title) || typeof fontFile !== 'string' || !/^[A-Za-z0-9 /_.-]+$/.test(fontFile)
    || [timeX, timeY, titleX, titleY, fontSize].some((value) => !Number.isFinite(value) || value < 0 || value > 1)
    || fontSize === 0) throw new Error('Invalid proxy OSD configuration.');
  new Intl.DateTimeFormat('en', { timeZone: osd.timezone || 'Asia/Kolkata' });
  const style = `fontfile='${fontFile}':fontsize=${Math.max(8, Math.round(settings.height * fontSize))}`
    + `:fontcolor=white:borderw=${Math.max(1, Math.round(settings.height / 480))}:bordercolor=black:fix_bounds=1`;
  return `,drawtext=${style}:text='%{localtime\\:%d/%m/%Y %H\\\\\\:%M\\\\\\:%S}':x=w*${timeX}:y=h*${timeY}`
    + `,drawtext=${style}:text='${title}':x=w*${titleX}:y=h*${titleY}`;
}

export function authenticatedUri(uri, credentials) {
  const parsed = new URL(uri);
  parsed.username = credentials.username;
  parsed.password = credentials.password;
  return parsed.toString();
}

export function selectStream(inventory, hostname, settings = video) {
  const camera = inventory.cameras?.find((entry) => entry.hostname === hostname);
  const streams = camera?.streams?.filter((entry) => entry.resolution?.width > 0 && entry.resolution?.height > 0) || [];
  const ordered = streams.sort((left, right) => left.resolution.width * left.resolution.height - right.resolution.width * right.resolution.height);
  const matchingAspect = ordered.filter((entry) =>
    Math.abs(entry.resolution.width / entry.resolution.height - settings.width / settings.height) < 0.02);
  const candidates = matchingAspect.length ? matchingAspect : ordered;
  const stream = candidates.find((entry) => entry.resolution.width >= settings.width && entry.resolution.height >= settings.height)
    || candidates.at(-1)
    || ordered.at(-1);
  if (!stream) throw new Error(`No discovered video stream for ${hostname}; run inspect first.`);
  return cleanStreamUri(stream.uri, hostname);
}

function encodeArguments(label, uri, video) {
  return [
    '-map', label, '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-ac', '1',
    '-af', 'asetpts=PTS-STARTPTS,aresample=async=1000:first_pts=0',
    '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-coder', '1', '-tune', 'zerolatency',
    '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    '-b:v', `${video.bitrate}k`, '-maxrate', `${video.bitrate}k`, '-bufsize', '2000k',
    '-g', String(video.fps), '-keyint_min', String(video.fps), '-sc_threshold', '0',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', uri,
  ];
}

export function previewArguments({ source, destination }) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2',
    '-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', source,
    '-filter_threads', '2', '-vf', `${fitFilter(originalVideo)},format=yuv420p`,
    ...encodeArguments('0:v:0', destination, originalVideo)];
}

export function processedArguments({ source, destination, recording = false, settings = video, osd }) {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2',
    ...(recording ? ['-stream_loop', '-1', '-re'] : ['-rtsp_transport', 'tcp', '-timeout', '10000000']),
    '-i', source, '-filter_threads', '2', '-vf', `${fitFilter(settings)}${osdFilter(osd, settings)},format=yuv420p`,
    ...encodeArguments('0:v:0', destination, settings)];
}

export function recordingArguments({ source, destination, duration = 120 }) {
  if (!Number.isInteger(duration) || duration < 1 || duration > 120) throw new Error('Invalid recording duration.');
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-rtsp_transport', 'tcp', '-timeout', '10000000',
    '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'copy', '-t', String(duration), '-fs', '134217728',
    '-f', 'matroska', '-y', destination];
}
