import { createHash } from 'node:crypto';
import { Agent, get } from 'node:https';
import { Readable } from 'node:stream';
import { buildCodexEnv } from './codex.mjs';
import { matchesSongArtist } from './qq-song.mjs';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const PROVIDER = 'Wikimedia Commons';
const USER_AGENT = 'SurfCoreCodexBot/0.1 (https://github.com/Mieksido/surfcore)';
const SEARCH_LIMIT = 12;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const AUDIO_MIME_TYPES = {
  ogg: ['application/ogg', 'audio/ogg', 'audio/opus'],
  mp3: ['audio/mpeg', 'audio/mp3'],
  wav: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  flac: ['audio/flac', 'audio/x-flac'],
};
const HTML_ENTITIES = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"', nbsp: ' ', ndash: '–', mdash: '—' };
const VERSION_LABELS = /(?:^| )(?:live|karaoke|instrumental|cover|remix|remaster(?:ed)?|demo|sample|excerpt|denoised)(?= |$)|现场|現場|伴奏|翻唱|试唱|試唱|试听|試聽|片段/gu;
let audioSourceAgent;

function fetchAudioSource(url, { signal, headers }) {
  audioSourceAgent ??= new Agent({ proxyEnv: buildCodexEnv() });
  return new Promise((resolve, reject) => {
    get(url, { agent: audioSourceAgent, signal, headers }, (response) => {
      resolve({
        ok: response.statusCode === 200,
        status: response.statusCode,
        headers: new Headers(response.headers),
        body: Readable.toWeb(response),
      });
    }).on('error', reject);
  });
}

function key(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLowerCase().replace(/['’‘]/gu, '').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
    : '';
}

function plainText(value) {
  if (typeof value !== 'string' || value.length > 4096) return '';
  return value.replace(/<\/(?:li|div|p)>|<br\s*\/?\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, token) => {
      if (token[0] !== '#') {
        const name = token.toLowerCase();
        return Object.hasOwn(HTML_ENTITIES, name) ? HTML_ENTITIES[name] : entity;
      }
      const hex = token[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 31 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }).trim();
}

function oneLine(value) {
  return value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
}

function recordingArtist(value) {
  const credits = plainText(value).split(/[\n;]/u).map(oneLine).filter(Boolean);
  const performers = credits.flatMap((credit) => {
    const match = /^(?:singer|vocals?|vocalist|performer|performance)\s*:\s*(.+)$/iu.exec(credit);
    return match ? [match[1]] : [];
  });
  const artist = performers.length === 1 ? performers[0] : credits.length === 1 && !credits[0].includes(':') ? credits[0] : '';
  return artist.replace(/\s*\(\d{4}\s*[-–—]\s*\d{4}\)$/u, '').trim();
}

function licenseInfo(fields, artist) {
  const name = fields.LicenseShortName?.value;
  if (name === 'Public domain' && /^false$/iu.test(fields.Copyrighted?.value) && /^false$/iu.test(fields.AttributionRequired?.value)) {
    return { license: name, licenseUrl: null, attribution: null };
  }
  const rawUrl = fields.LicenseUrl?.value;
  if (typeof rawUrl !== 'string') return null;
  const cc = /^https?:\/\/creativecommons\.org\/(licenses\/by\/(1\.0|2\.0|2\.5|3\.0|4\.0)|publicdomain\/zero\/1\.0)\/?$/u.exec(rawUrl);
  if (!cc) return null;
  const licenseUrl = `https://creativecommons.org/${cc[1]}/`;
  if (!cc[2]) return ['CC0', 'CC0 1.0'].includes(name) ? { license: 'CC0 1.0', licenseUrl, attribution: null } : null;
  const license = `CC BY ${cc[2]}`;
  const attribution = oneLine(plainText(fields.Attribution?.value) || plainText(fields.Artist?.value) || artist);
  if (name !== license || !attribution || attribution.length > 500) return null;
  return { license, licenseUrl, attribution };
}

function commonsUrl(value, origin, pathPattern) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || !pathPattern.test(url.pathname)) return null;
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function recording(page) {
  const info = page?.imageinfo?.[0];
  const fields = info?.extmetadata;
  if (page?.ns !== 6 || page.imagerepository !== 'local' || info?.mediatype !== 'AUDIO' || !fields) return null;
  const title = oneLine(plainText(fields.ObjectName?.value)).replace(/\s+\(ISRC [A-Z0-9]{12}\)$/iu, '').replace(/^"(.*)"$/u, '$1');
  const artist = recordingArtist(fields.Artist?.value);
  const fileTitle = typeof page.title === 'string' ? page.title.replace(/^File:|\.[a-z0-9]+$/giu, '') : '';
  const fileVersions = key(fileTitle).match(VERSION_LABELS) || [];
  const recordingVersions = key(`${title} ${artist}`).match(VERSION_LABELS) || [];
  if (fileVersions.some((version) => !recordingVersions.some((known) => known.trim() === version.trim()))) return null;
  return { title, artist, info, fields };
}

async function readBounded(response, maxBytes) {
  if (!response?.body || !response.ok || Number(response.headers.get('content-length')) > maxBytes) {
    await response?.body?.cancel().catch(() => {});
    return null;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function hasAudioHeader(audio, format) {
  if (format === 'ogg') return audio.toString('ascii', 0, 4) === 'OggS';
  if (format === 'flac') return audio.toString('ascii', 0, 4) === 'fLaC';
  if (format === 'wav') return audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE';
  return audio.toString('ascii', 0, 3) === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);
}

function requestOptions(signal, timeout, accept) {
  const deadline = AbortSignal.timeout(timeout);
  return {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    redirect: 'error', headers: { 'user-agent': USER_AGENT, accept },
  };
}

export async function discoverDownloadableSong({ title, artist } = {}, { signal, fetchImpl = fetchAudioSource, avoidedArtists = [] } = {}) {
  signal?.throwIfAborted();
  if (typeof title !== 'string' || title.length > 100 || (artist != null && (typeof artist !== 'string' || artist.length > 100))) return null;
  const titleKey = key(title);
  const artistKey = key(artist);
  if (!titleKey || (artist?.trim() && !artistKey)) return null;
  const searchUrl = new URL(COMMONS_API);
  const terms = [`intitle:"${titleKey}"`, ...(artistKey ? [`"${artistKey}"`] : []), 'filetype:audio'];
  searchUrl.search = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrnamespace: '6',
    gsrlimit: String(SEARCH_LIMIT), gsrsearch: terms.join(' '), prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata|sha1|mediatype', iiextmetadatalanguage: 'en',
    iiextmetadatafilter: 'ObjectName|Artist|LicenseUrl|LicenseShortName|Copyrighted|AttributionRequired|Attribution',
  });

  try {
    const searchResponse = await fetchImpl(searchUrl, requestOptions(signal, 7_000, 'application/json'));
    const searchBody = await readBounded(searchResponse, MAX_METADATA_BYTES);
    signal?.throwIfAborted();
    if (!searchBody) return null;
    const search = JSON.parse(searchBody.toString('utf8'));
    const pages = search.query?.pages;
    if (!Array.isArray(pages) || search.continue || pages.length > SEARCH_LIMIT) return null;
    const matches = pages.map(recording).filter((item) => item && key(item.title) === titleKey &&
      (!artistKey || key(item.artist) === artistKey) && !matchesSongArtist(item.artist, avoidedArtists));
    if (matches.length !== 1 || !matches[0].artist) return null;

    const item = matches[0];
    const { size, sha1, duration, mime } = item.info;
    if (!Number.isInteger(size) || size < 12 || size > MAX_AUDIO_BYTES || !/^[\da-f]{40}$/u.test(sha1) ||
        !Number.isFinite(duration) || duration <= 0) return null;
    const license = licenseInfo(item.fields, item.artist);
    const url = commonsUrl(item.info.url, 'https://upload.wikimedia.org', /^\/wikipedia\/commons\/[\da-f]\/[\da-f]{2}\/[^/]+$/iu);
    const pageUrl = commonsUrl(item.info.descriptionurl, 'https://commons.wikimedia.org', /^\/wiki\/File:[^/]+$/u);
    if (!license || !url || !pageUrl) return null;
    const extension = /\.([a-z0-9]+)$/iu.exec(url.pathname)?.[1]?.toLowerCase();
    const format = ['oga', 'opus'].includes(extension) ? 'ogg' : extension;
    const types = Object.hasOwn(AUDIO_MIME_TYPES, format) ? AUDIO_MIME_TYPES[format] : null;
    if (!types?.includes(mime)) return null;

    const response = await fetchImpl(url, requestOptions(signal, 12_000, types.join(', ')));
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!types.includes(contentType)) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const audio = await readBounded(response, size);
    signal?.throwIfAborted();
    if (!audio || audio.length !== size || !hasAudioHeader(audio, format) || createHash('sha1').update(audio).digest('hex') !== sha1) return null;
    return { audio, format, title: item.title, artist: item.artist, durationSeconds: duration,
      url: url.href, pageUrl: pageUrl.href, provider: PROVIDER, ...license };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}

const ARCHIVE = 'https://archive.org';
const ARCHIVE_ITEM = /^[a-z0-9][a-z0-9_.-]{0,119}$/iu;
const ARCHIVE_ORIGINAL_AUDIO = /\.(?:ogg|oga|opus|mp3|wav|flac|wma|m4a|aac|aif|aiff|alac|ape|mka|mp4)$/iu;

function archiveIdentity(item, titleKey, artistKey) {
  if (typeof item?.creator !== 'string' || typeof item.title !== 'string') return null;
  const artist = oneLine(plainText(item.creator));
  const rawTitle = oneLine(plainText(item.title));
  const prefix = /^(.*?)\s+[-–—]\s+(.+)$/u.exec(rawTitle);
  const title = prefix && key(prefix[1]) === key(artist) ? prefix[2] : rawTitle;
  if (!artist || artist.length > 100 || key(title) !== titleKey || (artistKey && key(artist) !== artistKey)) return null;
  return { title, artist };
}

function archiveLicense(value, artist) {
  if (typeof value !== 'string') return null;
  const match = /^https?:\/\/creativecommons\.org\/(licenses\/by\/(1\.0|2\.0|2\.5|3\.0|4\.0)|publicdomain\/(zero|mark)\/1\.0)\/?$/u.exec(value);
  if (!match) return null;
  const licenseUrl = 'https://creativecommons.org/' + match[1] + '/';
  if (match[2]) return { license: 'CC BY ' + match[2], licenseUrl, attribution: artist };
  return { license: match[3] === 'zero' ? 'CC0 1.0' : 'Public domain', licenseUrl, attribution: null };
}

function archiveFile(files, titleKey, artistKey) {
  if (!Array.isArray(files)) return null;
  const originals = files.filter((file) => file?.source === 'original' && ARCHIVE_ORIGINAL_AUDIO.test(file.name || ''));
  if (originals.length !== 1 || originals[0].private) return null;
  const original = originals[0];
  if (original.title && key(original.title) !== titleKey) return null;
  if (original.artist && key(original.artist) !== artistKey) return null;
  const filenameVersions = key(original.name.replace(/\.[^.]+$/u, '')).match(VERSION_LABELS) || [];
  const titleVersions = key(titleKey + ' ' + artistKey).match(VERSION_LABELS) || [];
  if (filenameVersions.some((value) => !titleVersions.some((known) => known.trim() === value.trim()))) return null;
  for (const file of [original, ...files.filter((file) => file?.source === 'derivative' && file.original === original.name)]) {
    if (file.private || typeof file.name !== 'string' || !/^[^/\\\p{Cc}]{1,240}$/u.test(file.name)) continue;
    const format = /\.([a-z0-9]+)$/iu.exec(file.name)?.[1].toLowerCase();
    const mime = Object.hasOwn(AUDIO_MIME_TYPES, format) && AUDIO_MIME_TYPES[format];
    const size = Number(file.size);
    if (!mime || !Number.isSafeInteger(size) || size < 12 || size > MAX_AUDIO_BYTES || !/^[a-f0-9]{40}$/u.test(file.sha1)) continue;
    const time = String(file.length ?? original.length ?? '');
    if (!/^(?:\d+:){0,2}\d+(?:\.\d+)?$/u.test(time)) continue;
    const duration = time.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
    if (Number.isFinite(duration) && duration > 0) return { file, format, mime, size, duration };
  }
  return null;
}

async function archiveJson(url, { signal, fetchImpl }) {
  const response = await fetchImpl(url, requestOptions(signal, 7_000, 'application/json'));
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const body = await readBounded(response, MAX_METADATA_BYTES);
  if (!body) throw new Error('Internet Archive metadata unavailable');
  return JSON.parse(body.toString('utf8'));
}

async function archiveAudio(url, filePath, mime, { signal, fetchImpl }) {
  const options = { ...requestOptions(signal, 12_000, mime.join(', ')), redirect: 'manual' };
  for (let redirects = 0; redirects <= 2; redirects++) {
    const response = await fetchImpl(url, options);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) return null;
    const target = new URL(location, url);
    if (target.protocol !== 'https:' || target.username || target.password || target.port || target.search || target.hash ||
        !/^(?:dn|ia)\d+(?:\.[a-z]{2})?\.archive\.org$/u.test(target.hostname) ||
        !/^\/\d+\/items\//u.test(target.pathname) ||
        decodeURIComponent(target.pathname.replace(/^\/\d+\/items/u, '')) !== decodeURIComponent(filePath)) return null;
    url = target;
  }
  return null;
}

export async function discoverArchiveSong({ title, artist } = {}, { signal, fetchImpl = fetchAudioSource, avoidedArtists = [] } = {}) {
  signal?.throwIfAborted();
  if (typeof title !== 'string' || title.length > 100 || (artist != null && (typeof artist !== 'string' || artist.length > 100))) return null;
  const titleKey = key(title);
  const artistKey = key(artist);
  if (!titleKey || (artist?.trim() && !artistKey)) return null;

  const searchUrl = new URL('/advancedsearch.php', ARCHIVE);
  const query = ['mediatype:audio', 'title:"' + titleKey + '"', ...(artistKey ? ['creator:"' + artistKey + '"'] : []),
    'licenseurl:*creativecommons.org*'].join(' AND ');
  searchUrl.search = new URLSearchParams({ q: query, rows: String(SEARCH_LIMIT), output: 'json' });
  for (const field of ['identifier', 'title', 'creator']) searchUrl.searchParams.append('fl[]', field);
  const result = (await archiveJson(searchUrl, { signal, fetchImpl }))?.response;
  if (!Array.isArray(result?.docs) || result.docs.length > SEARCH_LIMIT || result.numFound !== result.docs.length) return null;
  const candidates = result.docs.filter((item) => typeof item?.identifier === 'string' &&
    ARCHIVE_ITEM.test(item.identifier) && archiveIdentity(item, titleKey, artistKey) && !matchesSongArtist(item.creator, avoidedArtists));
  if (candidates.length !== 1) return null;

  const id = encodeURIComponent(candidates[0].identifier);
  const item = await archiveJson(new URL('/metadata/' + id, ARCHIVE), { signal, fetchImpl });
  const metadata = item?.metadata;
  if (item?.is_dark || metadata?.['access-restricted-item'] || metadata?.identifier !== candidates[0].identifier ||
      metadata?.mediatype !== 'audio') return null;
  const identity = archiveIdentity(metadata, titleKey, artistKey);
  const license = identity && archiveLicense(metadata.licenseurl, identity.artist);
  if (!license || matchesSongArtist(identity.artist, avoidedArtists)) return null;
  const source = archiveFile(item.files, titleKey, key(identity.artist));
  if (!source) return null;

  const { file, format, mime, size, duration } = source;
  const filePath = '/' + id + '/' + encodeURIComponent(file.name);
  const url = new URL('/download' + filePath, ARCHIVE);
  const response = await archiveAudio(url, filePath, mime, { signal, fetchImpl });
  const contentType = response?.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!mime.includes(contentType)) {
    await response?.body?.cancel().catch(() => {});
    return null;
  }
  const audio = await readBounded(response, size);
  signal?.throwIfAborted();
  if (!audio || audio.length !== size || !hasAudioHeader(audio, format) ||
      createHash('sha1').update(audio).digest('hex') !== file.sha1) return null;
  return { audio, format, ...identity, durationSeconds: duration, url: url.href,
    pageUrl: new URL('/details/' + id, ARCHIVE).href, provider: 'Internet Archive', ...license };
}

export async function discoverSongAcrossSources(request, options = {}) {
  let failure;
  let checked = false;
  for (const discover of [discoverDownloadableSong, discoverArchiveSong]) {
    try {
      const recording = await discover(request, options);
      if (recording) return recording;
      checked = true;
    } catch (error) {
      options.signal?.throwIfAborted();
      failure = error;
    }
  }
  if (!checked && failure) throw failure;
  return null;
}
