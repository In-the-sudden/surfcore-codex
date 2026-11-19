import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { discoverDownloadableSong } from '../plugin/src/qq-song-source.mjs';
import * as sources from '../plugin/src/qq-song-source.mjs';
const bytes = Buffer.from('OggS test audio bytes');
const pageUrl = 'https://commons.wikimedia.org/wiki/File:Auld_Lang_Syne.ogg';
const audioUrl = 'https://upload.wikimedia.org/wikipedia/commons/0/00/Auld_Lang_Syne.ogg';
const digest = createHash('sha1').update(bytes).digest('hex');

test('falls back to Internet Archive and downloads a verified, openly licensed recording', async () => {
  const id = 'example-123';
  const item = { identifier: id, title: 'Auld Lang Syne', creator: 'Static Yaks' };
  const file = { name: 'song.ogg', source: 'original', size: String(bytes.length), sha1: digest, length: '116.56' };
  const requests = [];
  const result = await sources.discoverSongAcrossSources({ title: item.title, artist: item.creator }, {
    fetchImpl: async (url) => {
      requests.push(url.hostname + url.pathname);
      if (url.hostname === 'commons.wikimedia.org') throw new Error('Commons temporarily unavailable');
      if (url.pathname === '/advancedsearch.php') return Response.json({ response: { numFound: 1, docs: [item] } });
      if (url.pathname === '/metadata/' + id) return Response.json({ metadata: { ...item, mediatype: 'audio', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' }, files: [file] });
      if (url.pathname === '/download/' + id + '/song.ogg') return new Response(null, { status: 302, headers: { Location: 'https://ia800100.us.archive.org/0/items/' + id + '/song.ogg' } });
      return new Response(bytes, { headers: { 'Content-Type': 'audio/ogg' } });
    },
  });
  assert.equal(result?.provider, 'Internet Archive');
  assert.equal(result.license, 'CC BY 4.0');
  assert.equal(result.attribution, 'Static Yaks');
  assert.deepEqual(result.audio, bytes);
  assert.deepEqual(requests, ['commons.wikimedia.org/w/api.php', 'archive.org/advancedsearch.php',
    'archive.org/metadata/example-123', 'archive.org/download/example-123/song.ogg', 'ia800100.us.archive.org/0/items/example-123/song.ogg']);
});

function page({ title = 'Auld Lang Syne', artist = '<li>Singer: Frank C. Stanley (1868–1910)</li>', ...overrides } = {}) {
  return {
    title: 'File:Auld Lang Syne.ogg', ns: 6, imagerepository: 'local',
    imageinfo: [{
      url: audioUrl, descriptionurl: pageUrl, mime: 'application/ogg', mediatype: 'AUDIO',
      size: bytes.length, sha1: digest, duration: 141.55,
      extmetadata: {
        ObjectName: { value: title }, Artist: { value: artist },
        LicenseShortName: { value: 'Public domain' }, Copyrighted: { value: 'False' },
        AttributionRequired: { value: 'false' },
      },
      ...overrides,
    }],
  };
}

function commonsFetch(pages, audio = () => new Response(bytes, { headers: { 'Content-Type': 'application/ogg' } })) {
  return async (url, options) => {
    if (url.origin === 'https://commons.wikimedia.org') {
      assert.equal(url.pathname, '/w/api.php');
      assert.match(url.searchParams.get('gsrsearch'), /"auld lang syne"/i);
      assert.doesNotMatch(url.href, /private/);
      assert.equal(options.redirect, 'error');
      return Response.json({ query: { pages } });
    }
    assert.equal(url.href, audioUrl);
    assert.equal(options.redirect, 'error');
    return audio();
  };
}

test('downloads an exact match by singer and preserves original recording provenance', async () => {
  const result = await discoverDownloadableSong({
    title: '《Auld Lang Syne》', artist: 'Frank C. Stanley', line: 'private lyric', chat: 'private chat',
  }, { fetchImpl: commonsFetch([page({ title: 'Auld Lang Syne (Live)' }), page()]) });
  assert.equal(result.title, 'Auld Lang Syne');
  assert.equal(result.artist, 'Frank C. Stanley');
  assert.equal(result.pageUrl, pageUrl);
  assert.equal(result.url, audioUrl);
  assert.equal(result.provider, 'Wikimedia Commons');
  assert.equal(result.license, 'Public domain');
  assert.equal(result.format, 'ogg');
  assert.deepEqual(result.audio, bytes);
});

test('accepts a unique title-only match and skips ambiguous recordings', async () => {
  const input = { title: 'Auld Lang Syne' };
  const result = await discoverDownloadableSong(input, { fetchImpl: commonsFetch([page()]) });
  assert.equal(result.artist, 'Frank C. Stanley');
  const another = page({ artist: 'A different artist', url: audioUrl.replace('0/00', '1/11'), sha1: 'a'.repeat(40) });
  assert.equal(await discoverDownloadableSong(input, {
    fetchImpl: commonsFetch([page(), another], () => assert.fail('Ambiguous search must not download audio')),
  }), null);
});

test('rejects unlicensed, mismatched, oversized and non-Commons candidates before download', async () => {
  const { extmetadata } = page().imageinfo[0];
  const candidates = [page({ artist: 'Another artist' }), page({ title: 'Auld Lang Syne Cover' }),
    page({ extmetadata: { ...extmetadata, Copyrighted: { value: 'True' } } }),
    page({ size: 200 * 1024 * 1024 }), page({ url: 'https://upload.wikimedia.org.attacker.example/track.ogg' }),
    page({ url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/track.ogg' })];
  const result = await discoverDownloadableSong({ title: 'Auld Lang Syne', artist: 'Frank C. Stanley' }, {
    fetchImpl: commonsFetch(candidates, () => assert.fail('Unverified candidate must not download audio')),
  });
  assert.equal(result, null);
});

test('rejects audio that exceeds the stated size or fails the recorded digest', async () => {
  for (const body of [Buffer.concat([bytes, bytes]), Buffer.from('OggS fake audio bytes')]) {
    const result = await discoverDownloadableSong({ title: 'Auld Lang Syne' }, {
      fetchImpl: commonsFetch([page()], () => new Response(body, { headers: { 'Content-Type': 'application/ogg' } })),
    });
    assert.equal(result, null);
  }
});

test('preserves requested Creative Commons attribution and the license link', async () => {
  const { extmetadata } = page().imageinfo[0];
  const entry = page({ extmetadata: {
    ...extmetadata, Copyrighted: { value: 'True' }, AttributionRequired: { value: 'true' },
    LicenseShortName: { value: 'CC BY 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0' },
    Attribution: { value: '<i>Frank &amp; Company</i>' },
  } });
  const result = await discoverDownloadableSong({ title: 'Auld Lang Syne' }, { fetchImpl: commonsFetch([entry]) });
  assert.equal(result.license, 'CC BY 4.0');
  assert.equal(result.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(result.attribution, 'Frank & Company');
});

test('rejects a live file when its generic title metadata omits the version', async () => {
  const live = { ...page(), title: 'File:Auld Lang Syne (Live).ogg' };
  const result = await discoverDownloadableSong({ title: 'Auld Lang Syne', artist: 'Frank C. Stanley' }, {
    fetchImpl: commonsFetch([live], () => assert.fail('Live version must not download as an unqualified match')),
  });
  assert.equal(result, null);
});

test('does not download a title-only match when the search has more results', async () => {
  let requests = 0;
  const result = await discoverDownloadableSong({ title: 'Auld Lang Syne' }, {
    fetchImpl: async () => {
      requests += 1;
      return Response.json({ query: { pages: [page()] }, continue: { gsroffset: 12 } });
    },
  });
  assert.equal(result, null);
  assert.equal(requests, 1);
});
