import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { XMLParser, XMLBuilder, XMLValidator } from 'fast-xml-parser';
import { video } from './proxy-media.js';

const namespaces = {
  s: 'http://www.w3.org/2003/05/soap-envelope',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
  ter: 'http://www.onvif.org/ver10/error',
};
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });
const builder = new XMLBuilder({ ignoreAttributes: false, suppressBooleanAttributes: false });
// NVRs map the second profile to their sub stream (used by multi-window live view) and ignore profiles
// that share an encoder configuration, so each gets its own token; both describe the processed stream.
const profileTokens = ['processed', 'processed-sub'];
const encoderTokens = ['encoder', 'encoder-sub'];
function mediaProfile(video) {
const resolution = { 'tt:Width': video.width, 'tt:Height': video.height };
const sourceConfig = {
  '@_token': 'source-config', 'tt:Name': 'Processed source', 'tt:UseCount': profileTokens.length,
  'tt:SourceToken': 'source',
  'tt:Bounds': { '@_x': 0, '@_y': 0, '@_width': video.width, '@_height': video.height },
};
const encoderConfigs = encoderTokens.map((token, index) => ({
  '@_token': token, 'tt:Name': `Processed H264${index ? ' sub' : ''}`, 'tt:UseCount': 1,
  'tt:Encoding': 'H264', 'tt:Resolution': resolution, 'tt:Quality': 5,
  'tt:RateControl': { 'tt:FrameRateLimit': video.fps, 'tt:EncodingInterval': 1, 'tt:BitrateLimit': video.bitrate },
  'tt:H264': { 'tt:GovLength': video.fps, 'tt:H264Profile': 'Main' },
  'tt:Multicast': {
    'tt:Address': { 'tt:Type': 'IPv4', 'tt:IPv4Address': '0.0.0.0' },
    'tt:Port': 0, 'tt:TTL': 1, 'tt:AutoStart': false,
  },
  'tt:SessionTimeout': 'PT60S',
}));
const profiles = profileTokens.map((token, index) => ({
  '@_token': token, '@_fixed': true, 'tt:Name': `Processed ${video.height}p${index ? ' sub' : ''}`,
  'tt:VideoSourceConfiguration': sourceConfig, 'tt:VideoEncoderConfiguration': encoderConfigs[index],
}));
return { resolution, sourceConfig, encoderConfigs, profiles };
}

function envelope(body) {
  return builder.build({ 's:Envelope': {
    ...Object.fromEntries(Object.entries(namespaces).map(([prefix, uri]) => [`@_xmlns:${prefix}`, uri])),
    's:Body': body,
  } });
}

function fault(code, reason) {
  return envelope({ 's:Fault': {
    's:Code': { 's:Value': 's:Sender', 's:Subcode': { 's:Value': `ter:${code}` } },
    's:Reason': { 's:Text': { '@_xml:lang': 'en', '#text': reason } },
  } });
}

function text(value) {
  return typeof value === 'string' ? value : value?.['#text'];
}

function authorized(header, credentials, seen) {
  const token = header?.Security?.UsernameToken;
  const nonce = text(token?.Nonce);
  const created = text(token?.Created);
  const supplied = text(token?.Password);
  if (text(token?.Username) !== credentials.username || !nonce || !created || !supplied
    || !token.Password?.['@_Type']?.endsWith('#PasswordDigest')) return false;
  const timestamp = Date.parse(created);
  const now = Date.now();
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300000) return false;
  for (const [key, expires] of seen) if (expires < now) seen.delete(key);
  const replayKey = `${nonce}:${created}`;
  if (seen.has(replayKey) || seen.size >= 4096) return false;
  const expected = createHash('sha1').update(Buffer.from(nonce, 'base64'))
    .update(created).update(credentials.password).digest();
  const actual = Buffer.from(supplied, 'base64');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  seen.set(replayKey, now + 600000);
  return true;
}

export function createOnvifServer({ hostname, port, rtspPort, credentials, id = 'camera-1', getVideo = () => video }) {
  let { resolution, sourceConfig, encoderConfigs, profiles } = mediaProfile(getVideo());
  const seen = new Map();
  const endpoints = () => ({
    device: `http://${hostname}:${port || server.address().port}/onvif/device_service`,
    media: `http://${hostname}:${port || server.address().port}/onvif/media_service`,
  });
  const operations = {
    GetSystemDateAndTime() {
      const now = new Date();
      return { 'tds:SystemDateAndTime': {
        'tt:DateTimeType': 'NTP', 'tt:DaylightSavings': false,
        'tt:TimeZone': { 'tt:TZ': 'UTC0' },
        'tt:UTCDateTime': {
          'tt:Time': { 'tt:Hour': now.getUTCHours(), 'tt:Minute': now.getUTCMinutes(), 'tt:Second': now.getUTCSeconds() },
          'tt:Date': { 'tt:Year': now.getUTCFullYear(), 'tt:Month': now.getUTCMonth() + 1, 'tt:Day': now.getUTCDate() },
        },
      } };
    },
    GetDeviceInformation: () => ({ 'tds:Manufacturer': 'Local', 'tds:Model': 'CCTVSpoofer',
      'tds:FirmwareVersion': '0.2', 'tds:SerialNumber': `cctvspoofer-${id}`, 'tds:HardwareId': 'software' }),
    GetHostname: () => ({ 'tds:HostnameInformation': { 'tt:FromDHCP': false, 'tt:Name': 'cctvspoofer' } }),
    GetScopes: () => ({ 'tds:Scopes': ['type/video_encoder', 'name/CCTVSpoofer', 'location/office'].map((scope) => ({
      'tt:ScopeDef': 'Fixed', 'tt:ScopeItem': `onvif://www.onvif.org/${scope}`,
    })) }),
    GetServices: () => ({ 'tds:Service': ['device', 'media'].map((service) => ({
      'tds:Namespace': namespaces[service === 'device' ? 'tds' : 'trt'],
      'tds:XAddr': endpoints()[service], 'tds:Version': { 'tt:Major': 2, 'tt:Minor': 0 },
    })) }),
    GetCapabilities: () => ({ 'tds:Capabilities': {
      'tt:Device': { 'tt:XAddr': endpoints().device,
        'tt:Network': { 'tt:IPFilter': false, 'tt:ZeroConfiguration': false, 'tt:IPVersion6': false, 'tt:DynDNS': false },
        'tt:System': { 'tt:DiscoveryResolve': false, 'tt:DiscoveryBye': false, 'tt:RemoteDiscovery': false,
          'tt:SystemBackup': false, 'tt:SystemLogging': false, 'tt:FirmwareUpgrade': false,
          'tt:SupportedVersions': { 'tt:Major': 2, 'tt:Minor': 0 } },
        'tt:Security': { 'tt:TLS1.1': false, 'tt:TLS1.2': false, 'tt:OnboardKeyGeneration': false,
          'tt:AccessPolicyConfig': false, 'tt:X.509Token': false, 'tt:SAMLToken': false,
          'tt:KerberosToken': false, 'tt:RELToken': false },
      },
      'tt:Media': { 'tt:XAddr': endpoints().media,
        'tt:StreamingCapabilities': { 'tt:RTPMulticast': false, 'tt:RTP_TCP': true, 'tt:RTP_RTSP_TCP': true } },
    } }),
    GetProfiles: () => ({ 'trt:Profiles': profiles }),
    GetProfile: (args) => ({ 'trt:Profile': profiles.find((entry) => entry['@_token'] === args.ProfileToken) }),
    GetVideoSources: () => ({ 'trt:VideoSources': { '@_token': 'source', 'tt:Framerate': getVideo().fps, 'tt:Resolution': resolution } }),
    GetVideoSourceConfigurations: () => ({ 'trt:Configurations': sourceConfig }),
    GetVideoSourceConfiguration: () => ({ 'trt:Configuration': sourceConfig }),
    GetVideoEncoderConfigurations: () => ({ 'trt:Configurations': encoderConfigs }),
    GetVideoEncoderConfiguration: (args) => ({ 'trt:Configuration': encoderConfigs.find((entry) => entry['@_token'] === args.ConfigurationToken) }),
    GetStreamUri: () => ({ 'trt:MediaUri': {
      'tt:Uri': `rtsp://${hostname}:${rtspPort}/processed`,
      'tt:InvalidAfterConnect': false, 'tt:InvalidAfterReboot': false, 'tt:Timeout': 'PT0S',
    } }),
  };
  const mediaActions = new Set(['GetProfiles', 'GetProfile', 'GetVideoSources',
    'GetVideoSourceConfigurations', 'GetVideoSourceConfiguration',
    'GetVideoEncoderConfigurations', 'GetVideoEncoderConfiguration', 'GetStreamUri']);
  const server = createServer(async (request, response) => {
    const reply = (status, xml) => {
      response.writeHead(status, { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(xml);
    };
    if (request.method !== 'POST' || !['/onvif/device_service', '/onvif/media_service'].includes(request.url)) {
      reply(404, fault('ActionNotSupported', 'Use the ONVIF SOAP service.'));
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) {
          reply(413, fault('InvalidArgVal', 'Request too large.'));
          return;
        }
        chunks.push(chunk);
      }
      const xml = Buffer.concat(chunks).toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid XML');
      const document = parser.parse(xml).Envelope;
      const actions = Object.keys(document?.Body || {}).filter((key) => !key.startsWith('@_'));
      if (actions.length !== 1) throw new Error('Expected one action');
      const action = actions[0];
      if (action !== 'GetSystemDateAndTime' && !authorized(document.Header, credentials, seen)) {
        reply(500, fault('NotAuthorized', 'A fresh WS-Security UsernameToken PasswordDigest is required.'));
        return;
      }
      const prefix = request.url === '/onvif/media_service' ? 'trt' : 'tds';
      if (!Object.hasOwn(operations, action) || mediaActions.has(action) !== (prefix === 'trt')) {
        reply(500, fault('ActionNotSupported', 'This is a read-only streaming prototype.'));
        return;
      }
      const args = document.Body[action];
      const expectedTokens = action.includes('Encoder') ? encoderTokens : ['source-config'];
      if ((['GetProfile', 'GetStreamUri'].includes(action) && !profileTokens.includes(args?.ProfileToken))
        || (['GetVideoSourceConfiguration', 'GetVideoEncoderConfiguration'].includes(action)
          && !expectedTokens.includes(args?.ConfigurationToken))) {
        reply(500, fault('InvalidArgVal', 'Unknown profile or configuration token.'));
        return;
      }
      if (action === 'GetStreamUri' && (args?.StreamSetup?.Stream !== 'RTP-Unicast'
        || args?.StreamSetup?.Transport?.Protocol !== 'RTSP')) {
        reply(500, fault('InvalidArgVal', 'Only RTP-Unicast over RTSP/TCP is supported.'));
        return;
      }
      ({ resolution, sourceConfig, encoderConfigs, profiles } = mediaProfile(getVideo()));
      reply(200, envelope({ [`${prefix}:${action}Response`]: operations[action](args) }));
    } catch {
      if (!response.headersSent) reply(400, fault('InvalidArgVal', 'Invalid SOAP request.'));
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 10000;
  return server;
}