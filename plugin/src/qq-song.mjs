import { voiceRoot } from './local-installation.mjs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { normalizeWav } from './voice-wav.mjs';
import { selectSongSegment } from './qq-song-chorus.mjs';
import { SONG_DOWNLOAD_CACHE } from './voice-cache.mjs';

const run = promisify(execFile);
const DEFAULT_CATALOG = join(voiceRoot, 'qq-songs.json');
const MAX_INDEX_BYTES = 256 * 1024;
const MAX_CLIP_SECONDS = 30;
const SEARCH_LIMIT = 8;
const LOCAL_EXTENSIONS = new Set(['.wav', '.flac', '.mp3', '.m4a', '.ogg']);
const IMPORT_EXTENSIONS = new Set([...LOCAL_EXTENSIONS, '.opus', '.aac']);
const IMPORT_DIRECTORY = 'qq-song-imported';
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const SECTION_LABELS = { opening: '开头', first30: '前30秒', chorus: '副歌' };

function field(value, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) return null;
  return value.replace(/\s+/gu, ' ').trim();
}

function key(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLowerCase().replace(/['’‘]/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    : '';
}

export function matchesSongArtist(artist, candidates) {
  const artistKey = key(artist);
  return Boolean(artistKey && candidates.some((candidate) => key(candidate) === artistKey));
}

export function hasSongVersion(title) {
  return typeof title === 'string' && /(?:[（(][^）)]*(?:版|翻唱|现场|伴奏|live|remix|cover|ver(?:sion)?|instrumental|original)[^）)]*[）)]|(?:女声|男声|翻唱|现场|伴奏|\b(?:live|remix|cover|instrumental)\b))/iu.test(title);
}

function matchesName(query, name, aliases) {
  return key(name) === query || (Array.isArray(aliases) && aliases.some((alias) => key(alias) === query));
}

function matchLine(song, line) {
  const query = key(line);
  if (!query || !Array.isArray(song.lines)) return undefined;
  const exact = song.lines.filter((entry) => entry && matchesName(query, entry.text, entry.aliases));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  if (query.length < 4) return undefined;
  const partial = song.lines.filter((entry) => entry && [entry.text, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
    .some((text) => {
      const candidate = key(text);
      return /\p{Script=Han}/u.test(query) ? candidate.includes(query) : (' ' + candidate + ' ').includes(' ' + query + ' ');
    }));
  return partial.length === 1 ? partial[0] : undefined;
}

export function sectionKey(value) {
  const section = key(value);
  if (['opening', '开头', '開頭', '开场', '開場'].includes(section)) return 'opening';
  if (['chorus', '副歌'].includes(section)) return 'chorus';
  if (['first30', 'first30seconds', '前30秒', '前30s', '开头30秒', '開頭30秒'].includes(section.replaceAll(' ', ''))) return 'first30';
  return undefined;
}

function numberedClip(song, section, first, count) {
  if (!section || !Array.isArray(song.lines)) return undefined;
  const last = first + count - 1;
  const lines = song.lines.filter((line) => line?.section === section &&
    Number.isSafeInteger(line.number) && line.number >= first && line.number <= last)
    .sort((left, right) => left.number - right.number);
  if (lines.length !== count || lines.some((line, index) => line.number !== first + index ||
      !Number.isFinite(line.start) || !Number.isFinite(line.end) || line.end <= line.start ||
      (index > 0 && line.start < lines[index - 1].end))) return undefined;
  return { start: lines[0].start, end: lines.at(-1).end };
}

async function readCatalog(path, signal) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_INDEX_BYTES) return [];
    const contents = await readFile(path, { encoding: 'utf8', signal });
    const entries = JSON.parse(contents.replace(/^\uFEFF/u, ''));
    return Array.isArray(entries) ? entries.filter((entry) => key(entry?.title) && field(entry.title, 100) && field(entry.artist, 100)) : [];
  } catch {
    signal?.throwIfAborted();
    return [];
  }
}

async function resolveCatalogFile(file, catalogPath, extensions = LOCAL_EXTENSIONS) {
  if (typeof file !== 'string' || isAbsolute(file) || !extensions.has(extname(file).toLowerCase())) return undefined;
  const root = await realpath(dirname(catalogPath));
  const source = await realpath(join(root, file));
  const inside = relative(root, source);
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) || !(await stat(source)).isFile()) return undefined;
  return source;
}

async function catalogLearningSource(source, { catalogPath, signal }) {
  try {
    const path = await resolveCatalogFile(source?.file, catalogPath, IMPORT_EXTENSIONS);
    signal?.throwIfAborted();
    if (!path) return undefined;

    const { sourceStart, chorus, opening } = source;
    const validStart = Number.isFinite(sourceStart) && sourceStart >= 0;
    const { start, end } = chorus ?? {};
    const validChorus = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
    const validOpening = validStart && selectSongSegment({ section: 'opening', duration: Number.MAX_VALUE, sourceStart, opening });
    return { path, ...(validStart && { sourceStart }), ...(validChorus && { chorus: { start, end } }),
      ...(validOpening && { opening: { vocalStart: opening.vocalStart, phraseEnd: opening.phraseEnd } }) };
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

function songHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function importedRecordings(library, title, artist, signal) {
  const directory = join(library, 'index', songHash(key(title)));
  const files = artist ? [songHash(key(artist)) + '.json'] : await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const records = await Promise.all(files.filter((file) => /^[a-f0-9]{64}\.json$/u.test(file))
    .map((file) => readCatalog(join(directory, file), signal)));
  return records.flat().filter((entry) => key(entry.title) === key(title) && (!artist || key(entry.artist) === key(artist)));
}

export async function importSongRecording(input, { root = dirname(DEFAULT_CATALOG), ffmpeg, signal, keepExisting = false, automatic = false } = {}) {
  signal?.throwIfAborted();
  const title = field(input?.title, 100);
  const artist = field(input?.artist, 100);
  const path = typeof input?.path === 'string' ? input.path.trim().replace(/^"(.*)"$/u, '$1') : '';
  if (!key(title) || !key(artist)) throw new Error('请填写这份录音的歌名和歌手。');
  if (!isAbsolute(path) || /^[\\/]{2}/u.test(path) || !IMPORT_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw new Error('请填写本机音频的完整路径，支持 WAV、FLAC、MP3、M4A、OGG、OPUS 和 AAC。');
  }
  const source = await realpath(path).catch(() => null);
  const info = source && !/^[\\/]{2}/u.test(source) && await stat(source).catch(() => null);
  if (!info?.isFile() || info.size < 1 || info.size > MAX_IMPORT_BYTES) throw new Error('找不到可用的本机音频，文件需在 256 MB 以内。');
  const { chorusStart, chorusEnd, openingVocalStart, openingEnd } = input;
  const hasOpening = openingVocalStart != null || openingEnd != null;
  const opening = { vocalStart: openingVocalStart, phraseEnd: openingEnd };
  if (hasOpening && !selectSongSegment({ section: 'opening', duration: Number.MAX_VALUE, sourceStart: 0, opening })) {
    throw new Error('请填写开唱秒数和完整句尾秒数，试听片段最长 40 秒。');
  }
  const vocal = input.vocal || undefined;
  if (vocal && !['female', 'male'].includes(vocal)) throw new Error('请选择有效的主唱类型。');
  const hasChorus = chorusStart != null || chorusEnd != null;
  if (hasChorus && (!Number.isFinite(chorusStart) || !Number.isFinite(chorusEnd) || chorusStart < 0 || chorusEnd <= chorusStart)) {
    throw new Error('请填写有效的副歌开始和结束秒数。');
  }

  const library = join(root, automatic ? SONG_DOWNLOAD_CACHE : IMPORT_DIRECTORY);
  const index = join(library, 'index', songHash(key(title)));
  await mkdir(index, { recursive: true });
  const directory = await mkdtemp(join(library, 'track-'));
  const audio = join(directory, 'source' + extname(path).toLowerCase());
  const temporary = join(index, randomUUID() + '.tmp');
  let adopted = false;
  try {
    await copyFile(source, audio);
    const { probeSongDuration } = await import('./qq-song-learn.mjs');
    const duration = await probeSongDuration(audio, { ffmpeg, signal }).catch(() => {
      signal?.throwIfAborted();
      throw new Error('无法读取这份音频的时长。');
    });
    if (hasChorus && chorusEnd > duration) throw new Error('副歌时间超出了这份录音的时长。');
    if (hasOpening && openingEnd > duration) throw new Error('开头句尾超出了这份录音的时长。');
    const entry = { title, artist, ...(vocal && { vocal }), source: { file: relative(root, audio), sourceStart: 0,
      ...(hasOpening && { opening }),
      ...(hasChorus && { chorus: { start: chorusStart, end: chorusEnd } }) } };
    await writeFile(temporary, JSON.stringify([entry]), { flag: 'wx', mode: 0o600, signal });
    signal?.throwIfAborted();
    const destination = join(index, songHash(key(artist)) + '.json');
    if (keepExisting) {
      try { await link(temporary, destination); }
      catch (error) {
        if (error.code === 'EEXIST') return { title, artist, existing: true };
        throw error;
      }
      adopted = true;
      await unlink(temporary);
    } else {
      await rename(temporary, destination);
    }
    adopted = true;
    return { title, artist, durationSeconds: duration, hasOpening, hasChorus };
  } finally {
    if (!adopted) {
      await unlink(temporary).catch(() => {});
      await unlink(audio).catch(() => {});
      await rmdir(directory).catch(() => {});
    }
  }
}

async function renderClip(file, clip, { catalogPath, ffmpeg, signal }) {
  const { start, end } = clip;
  const duration = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || duration <= 0 || duration > MAX_CLIP_SECONDS) return undefined;
  const source = await resolveCatalogFile(file, catalogPath);
  if (!source) return undefined;

  const { stdout } = await run(ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-format_whitelist', 'wav,flac,mp3,mov,ogg', '-protocol_whitelist', 'file,pipe',
    '-ss', String(start), '-i', source, '-t', String(duration),
    '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
  ], { encoding: 'buffer', timeout: 10_000, maxBuffer: MAX_CLIP_SECONDS * 32000 + 4096, windowsHide: true, signal });
  const result = normalizeWav(stdout, { streaming: true });
  return Math.abs(result.durationMs - duration * 1000) <= 20 ? result.audio : undefined;
}

function appleSongUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ['music.apple.com', 'itunes.apple.com'].includes(url.hostname)) return url.href;
  } catch {}
  return undefined;
}

async function searchSongs(title, artist, { fetchImpl, signal }) {
  const url = new URL('https://itunes.apple.com/search');
  url.search = new URLSearchParams({
    term: [title, artist].filter(Boolean).join(' '), country: 'HK', media: 'music', entity: 'song', limit: String(SEARCH_LIMIT),
  });
  const timeout = AbortSignal.timeout(5000);
  const response = await fetchImpl(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > MAX_INDEX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Online song catalog response unavailable');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_INDEX_BYTES) throw new Error('Online song catalog response is too large');
    chunks.push(chunk);
  }
  const { results } = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  if (!Array.isArray(results)) throw new Error('Invalid online song catalog response');
  return results.slice(0, SEARCH_LIMIT).flatMap((item) => {
    const name = field(item?.trackName, 100);
    const performer = field(item?.artistName, 100);
    if (item?.kind !== 'song' || !name || !performer) return [];
    const url = appleSongUrl(item.trackViewUrl);
    return [{ title: name, artist: performer, ...(url && { url }) }];
  });
}

export async function resolveSong(request = {}, {
  signal,
  catalogPath = process.env.SURFCORE_QQ_SONG_CATALOG || DEFAULT_CATALOG,
  importRoot = dirname(DEFAULT_CATALOG),
  ffmpeg = process.env.SURFCORE_FFMPEG || 'ffmpeg',
  fetchImpl = fetch,
  lookupOnline = true,
  preferFemale = false,
  random = Math.random,
} = {}) {
  signal?.throwIfAborted();
  const title = field(request?.title, 100);
  const artist = field(request?.artist, 100);
  const line = field(request?.line, 300);
  const requestedSection = field(request?.section, 30);
  const lineNumber = request?.lineNumber ?? 1;
  const lineCount = request?.lineCount ?? 1;
  const numbered = !line && (request?.lineNumber != null || request?.lineCount != null);
  if ([title, artist, line, requestedSection].includes(null) ||
      (numbered && (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(lineCount) ||
        lineNumber < 1 || lineCount < 1 || !Number.isSafeInteger(lineNumber + lineCount - 1)))) {
    return { text: '歌名、歌手或指定片段格式无效。' };
  }
  if (!key(title) && !key(line)) return { text: '告诉我歌名或一句歌词，我帮你找。' };

  const entries = await readCatalog(catalogPath, signal);
  signal?.throwIfAborted();
  const local = entries.filter((entry) =>
    (title ? matchesName(key(title), entry.title, entry.aliases) : matchLine(entry, line)) &&
    (!artist || matchesName(key(artist), entry.artist, entry.artistAliases)));
  let sourceCatalogPath = catalogPath;
  let avoidedArtists = [];
  if (!local.length && title) {
    const [manual, downloaded] = await Promise.all([IMPORT_DIRECTORY, SONG_DOWNLOAD_CACHE].map((directory) =>
      importedRecordings(join(importRoot, directory), title, artist, signal)));
    const manualArtists = new Set(manual.map((entry) => key(entry.artist)));
    let imported = [...manual, ...downloaded.filter((entry) => !manualArtists.has(key(entry.artist)))];
    if (preferFemale && !artist) {
      avoidedArtists = imported.filter((entry) => entry.vocal === 'male').map((entry) => entry.artist);
      const female = imported.filter((entry) => entry.vocal === 'female');
      imported = female.length ? female : imported.filter((entry) => entry.vocal !== 'male');
    }
    if (imported.length > 1) return { text: '本地有多份同名录音，请告诉我歌手。', needsArtist: true, ...(avoidedArtists.length && { avoidedArtists }) };
    if (imported.length === 1) {
      local.push(imported[0]);
      sourceCatalogPath = join(importRoot, 'qq-songs.json');
    }
  }
  if (local.length === 1) {
    const [entry] = local;
    const song = { title: entry.title, artist: entry.artist };
    const learningSource = lookupOnline ? undefined : await catalogLearningSource(entry.source, { catalogPath: sourceCatalogPath, signal });
    const result = { song, ...(learningSource && { learningSource }) };
    let section, clip;
    if (line) {
      clip = matchLine(entry, line);
      section = sectionKey(clip?.section);
    } else {
      if (requestedSection) section = sectionKey(requestedSection);
      else if (numbered) section = 'opening';
      else section = random() < 0.5 ? 'opening' : 'chorus';
      clip = numbered ? numberedClip(entry, section, lineNumber, lineCount) : section && entry.sections?.[section];
    }
    const label = '《' + song.title + '》';
    if (!clip) {
      const requested = line ? '指定歌词' : requestedSection || numbered ? '指定段落' : SECTION_LABELS[section];
      return { ...result, text: label + '的' + requested + '还没有可唱的片段。' };
    }
    let audio;
    try { audio = await renderClip(entry.file, clip, { catalogPath, ffmpeg, signal }); }
    catch { signal?.throwIfAborted(); }
    signal?.throwIfAborted();
    if (audio) {
      const portion = numbered ? (lineCount === 1 ? '这句。' : '这几句。') : line ? '这句。' : '的' + SECTION_LABELS[section] + '。';
      const indexedLines = (Array.isArray(entry.lines) ? entry.lines : []).filter((item) =>
        typeof item?.text === 'string' && item.text.trim() && Number.isFinite(item.start) && Number.isFinite(item.end) &&
        item.start >= 0 && item.end > item.start && item.start < clip.end && item.end > clip.start)
        .sort((left, right) => left.start - right.start);
      const matchedLines = indexedLines.slice(0, 24).map((item) => ({ time: item.start, text: item.text.slice(0, 200) }));
      const indexedText = matchedLines.map((item) => item.text).join('\n');
      let lyrics = { status: matchedLines.length ? 'aligned' : 'unavailable', lines: matchedLines,
        text: indexedText.slice(0, 1_600),
        ...(matchedLines.length && { alignment: 'indexed',
          truncated: indexedLines.length > 24 || indexedLines.some((item) => item.text.length > 200) || indexedText.length > 1_600 }) };
      if (!matchedLines.length) {
        try {
          const { readSongLyrics } = await import('./qq-song-lyrics.mjs');
          lyrics = await readSongLyrics({ sourcePath: await resolveCatalogFile(entry.file, catalogPath),
            ...song, ...clip, voiceRoot: importRoot, signal });
        } catch { signal?.throwIfAborted(); }
      }
      return { ...result, section, audio, text: '给你唱' + label + portion,
        performance: { ...song, portion: line || numbered ? '指定歌词' : SECTION_LABELS[section],
          start: clip.start, end: clip.end, lyrics } };
    }
    return { ...result, text: label + '的片段暂时无法播放。' };
  }

  if (!key(title)) return { text: '本地没有找到这句歌词对应的片段。可以告诉我歌名。' };
  if (avoidedArtists.length) return { text: '本地还没有《' + title + '》的其他录音，可以点名歌手。', avoidedArtists };
  if (!lookupOnline) return { text: '本地没有找到《' + title + '》的可唱片段。' };
  try {
    const found = await searchSongs(title, artist, { fetchImpl, signal });
    signal?.throwIfAborted();
    const sameTitle = found.filter((song) => key(song.title) === key(title));
    const song = sameTitle.find((song) => !artist || key(song.artist) === key(artist));
    if (song) return { song, text: '查到《' + song.title + '》（' + song.artist + '），本地还没有可唱的片段。' + (song.url ? '\n' + song.url : '') };
    const other = sameTitle[0];
    const suggestion = other ? '有一首同名歌曲由' + other.artist + '演唱，无法确认是你指定的版本。' : '';
    return { text: '在线曲库没有找到匹配的《' + title + '》。' + suggestion };
  } catch {
    signal?.throwIfAborted();
    return { text: '暂时查不到在线曲库，《' + title + '》也没有本地可唱的片段。' };
  }
}
